/**
 * Page-props cache tests: key composition (locale, full query digest,
 * `cacheQuery`), the per-route query-variant budget, and generation-based
 * revalidation that survives the bounded in-process index.
 *
 * Fixtures are real compiled ESM files written to a temp directory and
 * imported through Node's loader; every fixture uses a unique filename because
 * imports are process-global and cached.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { CacheStore } from '../../src/cache/store.js';
import type { RequestContext } from '../../src/contracts/http.js';
import { loadPageModule, PageRenderError, renderRoute } from '../../src/pages/page.js';
import {
  admitQueryVariant,
  MAX_QUERY_VARIANTS_PER_ROUTE,
  PAGE_GENERATION_TTL_MS,
  pageCacheKey,
  pathGenerationKey,
} from '../../src/pages/page-cache.js';
import { recordPageCacheKey, revalidatePath, revalidateTag } from '../../src/pages/revalidate.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';

const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'page-cache-'));
const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let sequence = 0;
function writeModule(source: string): string {
  const file = join(tmpRoot, `fixture-page-cache-${sequence++}.js`);
  writeFileSync(file, source);
  return file;
}

function pageEntry(file: string, route: string): RouteManifestEntry {
  return { kind: 'page', route, file, dynamic: false, catchAll: false, params: [] };
}

/** TTL-aware in-memory store that counts writes. */
class CountingStore implements CacheStore {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();
  writes = 0;

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined || Date.now() >= entry.expiresAt) return null;
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.writes += 1;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string> {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await loader();
    await this.set(key, value, ttlMs);
    return value;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

function contextFor(
  store: CacheStore,
  url = 'http://localhost/page',
  extra: Partial<RequestContext> = {},
): RequestContext {
  const parsed = new URL(url);
  const services = { has: () => true, tryGet: () => store, get: () => store };
  return {
    request: new Request(parsed),
    url: parsed,
    params: {},
    session: null,
    services,
    ...extra,
  } as unknown as RequestContext;
}

/** A public cached page whose output reports how often `load` ran. */
function countingPage(extraExports = ''): string {
  return writeModule(
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
     export const revalidate = 60;
     export const cache = 'public';
     ${extraExports}
     let calls = 0;
     export function load(context) {
       calls += 1;
       return { calls, locale: context.locale ?? 'none' };
     }
     export default function Page({ calls, locale }) {
       return jsx('p', { children: 'calls=' + calls + ' locale=' + locale });
     }
    `,
  );
}

function servicesOf(store: CacheStore) {
  return { tryGet: <T>(): T | undefined => store as unknown as T };
}

describe('pageCacheKey composition', () => {
  const file = writeModule(
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
     export default function Page() { return jsx('p', {}); }
    `,
  );
  const store = new CountingStore();

  it('separates locales that share one manifest entry and params', () => {
    const entry = pageEntry(file, '/about');
    const fr = pageCacheKey(
      entry,
      contextFor(store, 'http://localhost/fr/about', { locale: 'fr' }),
    );
    const en = pageCacheKey(entry, contextFor(store, 'http://localhost/about', { locale: 'en' }));
    const none = pageCacheKey(entry, contextFor(store, 'http://localhost/about'));
    assert.notEqual(fr, en);
    assert.notEqual(fr, none);
  });

  it('uses the full SHA-256 digest of the query', () => {
    const entry = pageEntry(file, '/search');
    const key = pageCacheKey(entry, contextFor(store, 'http://localhost/search?q=x'));
    assert.match(key, /:q:[0-9a-f]{64}$/);
  });

  it('keys only the declared query names when a list is given', () => {
    const entry = pageEntry(file, '/list');
    const options = { query: ['page'] };
    const bare = pageCacheKey(entry, contextFor(store, 'http://localhost/list'), options);
    const tracked = pageCacheKey(
      entry,
      contextFor(store, 'http://localhost/list?utm_source=mail'),
      options,
    );
    const page2 = pageCacheKey(entry, contextFor(store, 'http://localhost/list?page=2'), options);
    const page2Tracked = pageCacheKey(
      entry,
      contextFor(store, 'http://localhost/list?utm_source=x&page=2'),
      options,
    );
    assert.equal(bare, tracked);
    assert.notEqual(bare, page2);
    assert.equal(page2, page2Tracked);
  });
});

describe('admitQueryVariant', () => {
  it('admits up to the per-route budget, re-admits known variants, and frees expired ones', () => {
    const store = new CountingStore();
    const now = 1_000;
    for (let i = 0; i < MAX_QUERY_VARIANTS_PER_ROUTE; i += 1) {
      assert.equal(admitQueryVariant(store, '/r', `v${i}`, 10, now), true);
    }
    assert.equal(admitQueryVariant(store, '/r', 'overflow', 10, now), false);
    assert.equal(admitQueryVariant(store, '/r', 'v0', 10, now), true);
    assert.equal(admitQueryVariant(store, '/other', 'v0', 10, now), true);
    assert.equal(admitQueryVariant(store, '/r', 'overflow', 10, now + 10), true);
  });
});

describe('renderRoute page cache', () => {
  it('does not serve one locale the props cached for another', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(), '/greeting');
    const fr = await renderRoute(
      entry,
      contextFor(store, 'http://localhost/fr/greeting', { locale: 'fr' }),
    );
    const en = await renderRoute(
      entry,
      contextFor(store, 'http://localhost/greeting', { locale: 'en' }),
    );
    assert.match(fr, /locale=fr/);
    assert.match(en, /locale=en/);
  });

  it('stops writing new query variants once the route budget is spent', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(), '/flood');
    for (let i = 0; i < MAX_QUERY_VARIANTS_PER_ROUTE; i += 1) {
      await renderRoute(entry, contextFor(store, `http://localhost/flood?x=${i}`));
    }
    const before = store.writes;
    const html = await renderRoute(entry, contextFor(store, 'http://localhost/flood?x=overflow'));
    assert.equal(store.writes, before, 'an over-budget variant must not be written');
    assert.match(html, /calls=/);

    // The bare page never consumes the query budget.
    await renderRoute(entry, contextFor(store, 'http://localhost/flood'));
    assert.equal(store.writes, before + 1);
  });

  it('serves tracking-parameter variants from the bare entry when cacheQuery is declared', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(`export const cacheQuery = ['page'];`), '/catalog');
    await renderRoute(entry, contextFor(store, 'http://localhost/catalog'));
    const tracked = await renderRoute(
      entry,
      contextFor(store, 'http://localhost/catalog?utm_source=mail'),
    );
    assert.match(tracked, /calls=1/);
    const page2 = await renderRoute(entry, contextFor(store, 'http://localhost/catalog?page=2'));
    assert.match(page2, /calls=2/);
  });

  it('rejects a malformed cacheQuery export', async () => {
    const file = writeModule(
      `export const cacheQuery = 'page';
       export default function Page() { return null; }
      `,
    );
    await assert.rejects(
      () => loadPageModule(file),
      (error: unknown) =>
        error instanceof PageRenderError && /export "cacheQuery"/.test(error.message),
    );
  });

  it('revalidatePath reaches entries the bounded index has already forgotten', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(), '/products');
    const first = await renderRoute(entry, contextFor(store, 'http://localhost/products'));
    assert.match(first, /calls=1/);

    // Push the live key out of the in-process index (capped at 10 000 keys).
    for (let i = 0; i < 10_050; i += 1) {
      recordPageCacheKey(store, `flood-${i}`, '/elsewhere', [], 60_000);
    }

    await revalidatePath('/products', {}, { services: servicesOf(store) });
    const after = await renderRoute(entry, contextFor(store, 'http://localhost/products'));
    assert.match(after, /calls=2/, 'revalidated page must load fresh');
  });

  it('revalidatePath from another process (a store-only view) invalidates the entry', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(), '/shared');
    await renderRoute(entry, contextFor(store, 'http://localhost/shared'));

    // A second process shares the store but not this process's index: model
    // it with a wrapper object, which has its own (empty) index.
    const otherProcessView: CacheStore = {
      get: (key) => store.get(key),
      set: (key, value, ttl) => store.set(key, value, ttl),
      delete: (key) => store.delete(key),
      remember: (key, ttl, loader) => store.remember(key, ttl, loader),
      close: () => store.close(),
    };
    await revalidatePath('/shared', {}, { services: servicesOf(otherProcessView) });

    const after = await renderRoute(entry, contextFor(store, 'http://localhost/shared'));
    assert.match(after, /calls=2/);
  });

  it('a lost generation token never resurrects entries written before a revalidation', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(), '/lost');
    const first = await renderRoute(entry, contextFor(store, 'http://localhost/lost'));
    assert.match(first, /calls=1/);

    // Revalidate through a store-only view so the first entry stays in the
    // store (no indexed delete), as it would for another process.
    const otherProcessView: CacheStore = {
      get: (key) => store.get(key),
      set: (key, value, ttl) => store.set(key, value, ttl),
      delete: (key) => store.delete(key),
      remember: (key, ttl, loader) => store.remember(key, ttl, loader),
      close: () => store.close(),
    };
    await revalidatePath('/lost', {}, { services: servicesOf(otherProcessView) });
    const second = await renderRoute(entry, contextFor(store, 'http://localhost/lost'));
    assert.match(second, /calls=2/);

    // The token expires or a shared store evicts it.
    await store.delete(pathGenerationKey('/lost'));
    const third = await renderRoute(entry, contextFor(store, 'http://localhost/lost'));
    assert.match(third, /calls=3/, 'a missing token must start a fresh generation');
  });

  it('caps an entry TTL at the generation token lifetime', async () => {
    const store = new CountingStore();
    const file = writeModule(
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
       export const revalidate = 400 * 86400;
       export const cache = 'public';
       export function load() { return {}; }
       export default function Page() { return jsx('p', { children: 'long' }); }
      `,
    );
    const before = Date.now();
    await renderRoute(pageEntry(file, '/long'), contextFor(store, 'http://localhost/long'));
    const pageEntries = [...store.entries].filter(([key]) => key.startsWith('jsails:page:'));
    assert.equal(pageEntries.length, 1);
    const [, stored] = pageEntries[0]!;
    assert.ok(stored.expiresAt <= Date.now() + PAGE_GENERATION_TTL_MS);
    assert.ok(stored.expiresAt >= before + PAGE_GENERATION_TTL_MS - 60_000);
  });

  it('revalidateTag invalidates every page carrying the tag', async () => {
    const store = new CountingStore();
    const entry = pageEntry(countingPage(`export const tags = ['posts'];`), '/tagged');
    await renderRoute(entry, contextFor(store, 'http://localhost/tagged'));
    const cached = await renderRoute(entry, contextFor(store, 'http://localhost/tagged'));
    assert.match(cached, /calls=1/);

    await revalidateTag('posts', { services: servicesOf(store) });
    const after = await renderRoute(entry, contextFor(store, 'http://localhost/tagged'));
    assert.match(after, /calls=2/);
  });
});
