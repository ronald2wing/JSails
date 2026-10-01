/**
 * On-demand revalidation: `revalidatePath` / `revalidateTag` purge cached
 * page entries through the per-store reverse index + store delete.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CacheStore } from '../../src/cache/store.js';
import { cacheToken } from '../../src/cache/tokens.js';
import { revalidatePath, revalidateTag, recordPageCacheKey } from '../../src/pages/revalidate.js';

/**
 * Minimal in-memory {@link CacheStore} fixture. The real implementation lives
 * in `@jsails/cache`; this test needs only get/set/delete for revalidation.
 */
class InMemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.#entries.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.#entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async remember(key: string, _ttlMs: number, loader: () => Promise<string>): Promise<string> {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await loader();
    await this.set(key, value);
    return value;
  }

  async close(): Promise<void> {
    this.#entries.clear();
  }
}

// A minimal context carrying a cache store under the cache token.
function contextWithStore(store: CacheStore = new InMemoryCacheStore()): {
  store: CacheStore;
  services: { tryGet: <T>(token: unknown) => T | undefined };
} {
  return {
    store,
    services: {
      tryGet: <T>(token: unknown): T | undefined => {
        if (token === cacheToken) return store as unknown as T;
        return undefined;
      },
    },
  };
}

describe('on-demand revalidation', () => {
  it('revalidatePath deletes every key recorded under the path', async () => {
    const { store, services } = contextWithStore();
    await store.set('jsails:page:/blog:a=1', 'one', 60_000);
    await store.set('jsails:page:/blog:a=2', 'two', 60_000);
    recordPageCacheKey(store, 'jsails:page:/blog:a=1', '/blog', []);
    recordPageCacheKey(store, 'jsails:page:/blog:a=2', '/blog', []);

    await revalidatePath('/blog', {}, { services });

    assert.equal(await store.get('jsails:page:/blog:a=1'), null);
    assert.equal(await store.get('jsails:page:/blog:a=2'), null);
  });

  it('revalidateTag deletes keys recorded under the tag, not others', async () => {
    const { store, services } = contextWithStore();
    await store.set('jsails:page:/blog:tagged', 'tagged', 60_000);
    await store.set('jsails:page:/blog:untagged', 'untagged', 60_000);
    recordPageCacheKey(store, 'jsails:page:/blog:tagged', '/blog', ['posts']);
    recordPageCacheKey(store, 'jsails:page:/blog:untagged', '/blog', []);

    await revalidateTag('posts', { services });

    assert.equal(await store.get('jsails:page:/blog:tagged'), null);
    assert.equal(await store.get('jsails:page:/blog:untagged'), 'untagged');
  });

  it('an invalid tag purges nothing without throwing', async () => {
    const { services } = contextWithStore();
    await assert.doesNotReject(revalidateTag('', { services }));
    await assert.doesNotReject(revalidateTag('bad\0tag', { services }));
  });

  it('normalizes a non-/ path and purges via a fresh store index', async () => {
    const { store, services } = contextWithStore();
    await store.set('k1', 'v', 60_000);
    recordPageCacheKey(store, 'k1', 'blog', []);

    await revalidatePath('blog', {}, { services });
    assert.equal(await store.get('k1'), null);
  });

  it('does not leak index state across distinct store instances', async () => {
    const a = contextWithStore();
    const b = contextWithStore();
    await a.store.set('ka', 'va', 60_000);
    await b.store.set('kb', 'vb', 60_000);
    recordPageCacheKey(a.store, 'ka', '/shared', []);
    recordPageCacheKey(b.store, 'kb', '/other', []);

    await revalidatePath('/shared', {}, { services: a.services });
    // b's key is unaffected because the index is per-store.
    assert.equal(await a.store.get('ka'), null);
    assert.equal(await b.store.get('kb'), 'vb');
  });

  it('is a silent no-op without a store', async () => {
    await assert.doesNotReject(revalidatePath('/blog', {}, undefined));
    await assert.doesNotReject(revalidateTag('posts', undefined));
  });
});

describe('revalidation index bounds', () => {
  it('drops a recorded key once its TTL has elapsed', async () => {
    // A key whose cache entry already expired must not be "deleted" later: the
    // index would otherwise retain every key ever recorded for the process
    // lifetime. Recording with a TTL lets the index prune it on read.
    const { store, services } = contextWithStore();
    await store.set('expired', 'v', 60_000);
    recordPageCacheKey(store, 'expired', '/blog', [], 1);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // The purge is a no-op for the expired key, and the index no longer
    // reports it under the path.
    await revalidatePath('/blog', {}, { services });
    assert.equal(await store.get('expired'), 'v');
  });

  it('keeps a key whose TTL has not elapsed', async () => {
    const { store, services } = contextWithStore();
    await store.set('live', 'v', 60_000);
    recordPageCacheKey(store, 'live', '/blog', [], 60_000);

    await revalidatePath('/blog', {}, { services });
    assert.equal(await store.get('live'), null);
  });

  it('treats a key recorded without a TTL as never expiring', async () => {
    const { store, services } = contextWithStore();
    await store.set('forever', 'v', 60_000);
    recordPageCacheKey(store, 'forever', '/blog', []);

    await revalidatePath('/blog', {}, { services });
    assert.equal(await store.get('forever'), null);
  });

  it('evicts the oldest keys once the index cap is exceeded', async () => {
    // The cap is 10_000 keys. Recording past it must drop the oldest entries
    // rather than grow without bound; the newest key stays purgeable.
    const { store, services } = contextWithStore();
    const total = 10_050;
    for (let i = 0; i < total; i += 1) {
      recordPageCacheKey(store, `k${i}`, '/bulk', []);
    }
    await store.set('k0', 'oldest', 60_000);
    await store.set(`k${total - 1}`, 'newest', 60_000);

    await revalidatePath('/bulk', {}, { services });

    // The oldest key was evicted from the index, so it survives the purge.
    assert.equal(await store.get('k0'), 'oldest');
    // The newest key is still tracked and is purged.
    assert.equal(await store.get(`k${total - 1}`), null);
  });
});
