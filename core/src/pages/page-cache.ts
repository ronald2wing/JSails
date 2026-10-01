/**
 * Keys, generations, and admission for the shared page-props cache.
 *
 * A `cache: 'public'` page stores its `load()` result under a key built from
 * the route pattern, the request host, the request locale, the resolved
 * params, and a full SHA-256 digest of the query parameters that participate
 * (all of them, or only the page's declared `cacheQuery` names).
 *
 * Invalidation is generation-based and lives in the cache store itself: every
 * stored key carries the current generation token of its route path and of
 * each declared tag, and `revalidatePath`/`revalidateTag` replace that token.
 * Old entries then become unreachable at once — across processes sharing a
 * Valkey store, and regardless of whether the in-process reverse index still
 * remembers them — and age out through their TTL.
 *
 * Query strings and `Host` headers are attacker-chosen, so the number of
 * distinct query variants one route may write, and of distinct hosts one store
 * holds entries for, is bounded per store; past the budget a request is served
 * with a fresh `load()` and nothing is written.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CacheStore } from '../cache/store.js';
import type { RequestContext } from '../contracts/http.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { compareStrings } from '../support/compare-strings.js';
import { normalizeUrlPath } from '../url/normalize.js';

/** Options for {@link pageCacheKey}. */
export interface PageCacheKeyOptions {
  /**
   * Query parameter names that participate in the key. Absent means every
   * query parameter does; a declared list ignores every other parameter, so
   * tracking parameters such as `utm_source` share one entry.
   */
  readonly query?: readonly string[];
}

/**
 * Derive the base cache key of a page from the route pattern, request host,
 * request locale, resolved params, and query string, namespaced under
 * `jsails:page:` to avoid colliding with other cache consumers.
 *
 * This is not the key an entry is stored under: the renderer appends the
 * current generation tokens of the route path and of each declared tag
 * (`<base>:g:<path>.<tags>`), and those tokens change on every revalidation.
 * Deleting this key from the store therefore purges nothing; invalidate a page
 * through `revalidatePath` or `revalidateTag`.
 *
 * The host is part of the key because one process (or one shared Valkey
 * store) may serve several sites or tenants from the same routes, and a
 * `load()` that reads the host would otherwise answer one site with another's
 * props. The locale is part of the key because locale-prefixed aliases share one
 * manifest entry and params, and a locale may also come from a cookie or
 * `Accept-Language`. The query digest is the full SHA-256: a truncated digest
 * lets an attacker search offline for a query that collides with a popular
 * page's key and poison that shared entry.
 */
export function pageCacheKey(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageCacheKeyOptions = {},
): string {
  return describePageCacheKey(entry, context, options).key;
}

/** A page cache key and whether a query digest is part of it. */
export interface PageCacheKeyDescription {
  readonly key: string;
  /** True when participating query parameters were present. */
  readonly queried: boolean;
}

/** {@link pageCacheKey}, also reporting whether the query contributed. */
export function describePageCacheKey(
  entry: RouteManifestEntry,
  context: RequestContext,
  options: PageCacheKeyOptions = {},
): PageCacheKeyDescription {
  const parts: string[] = ['jsails:page', entry.route, `h:${JSON.stringify(context.url.host)}`];

  if (typeof context.locale === 'string' && context.locale !== '') {
    parts.push(`l:${JSON.stringify(context.locale)}`);
  }

  // Params: sorted by key for determinism. Each pair is JSON-encoded rather
  // than joined as `k=v`, so a value containing the separator cannot collide
  // with a different key/value split.
  const paramKeys = Object.keys(context.params).sort();
  for (const key of paramKeys) {
    parts.push(JSON.stringify([key, context.params[key]]));
  }

  const digest = queryDigest(context.url, options.query);
  if (digest !== undefined) {
    parts.push(`q:${digest}`);
  }

  return { key: parts.join(':'), queried: digest !== undefined };
}

/**
 * Digest of the participating query pairs, sorted by key then value, or
 * `undefined` when none participate. The pairs are JSON-encoded for the same
 * reason as params: `?a=1%26b%3D2` and `?a=1&b=2` must not hash alike.
 */
function queryDigest(url: URL, allowed: readonly string[] | undefined): string | undefined {
  const allow = allowed === undefined ? undefined : new Set(allowed);
  const pairs = [...url.searchParams.entries()].filter(
    ([key]) => allow === undefined || allow.has(key),
  );
  if (pairs.length === 0) {
    return undefined;
  }
  pairs.sort(([aKey, aVal], [bKey, bVal]) => {
    const cmp = compareStrings(aKey, bKey);
    return cmp !== 0 ? cmp : compareStrings(aVal, bVal);
  });
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

/**
 * Lifetime of a generation token: the longest cache TTL (`MAX_CACHE_TTL_MS`,
 * 365 days). Page entries are written with a TTL no longer than this, so no
 * entry outlives the token it was keyed under. Written as a literal so the
 * request path loads no cache module for it; a test keeps the two equal.
 */
export const PAGE_GENERATION_TTL_MS = 31_536_000_000;

/** Store key holding the generation token of a route path. */
export function pathGenerationKey(path: string): string {
  return `jsails:page-gen:path:${normalizeUrlPath(path)}`;
}

/** Store key holding the generation token of a tag. */
export function tagGenerationKey(tag: string): string {
  return `jsails:page-gen:tag:${tag}`;
}

/** A fresh, unguessable generation token. */
export function newPageGeneration(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * Append the current path and tag generations to a base key. The tokens are
 * read in one `getMany`; a missing one (never set, expired, or evicted) is
 * minted with `add`, and a process that loses that race reads the winner's
 * token, so every process agrees on it. A fresh random token, never a fixed
 * default, replaces a missing one: a fixed default would make every entry
 * written before the first revalidation reachable again the moment a later
 * token disappeared. A store failure propagates so the caller degrades to an
 * uncached `load()`, never to a key that ignores a revalidation.
 */
export async function versionedPageCacheKey(
  store: CacheStore,
  baseKey: string,
  path: string,
  tags: readonly string[],
): Promise<string> {
  const keys = [pathGenerationKey(path), ...tags.map((tag) => tagGenerationKey(tag))];
  const current = await store.getMany(keys);
  const tokens = await Promise.all(
    keys.map(async (key, index) => {
      const token = current[index];
      if (typeof token === 'string') return token;
      const minted = newPageGeneration();
      if (await store.add(key, minted, PAGE_GENERATION_TTL_MS)) return minted;
      const winner = await store.get(key);
      return typeof winner === 'string' ? winner : minted;
    }),
  );
  return `${baseKey}:g:${tokens.join('.')}`;
}

/** store -> key -> the read-or-load in flight for it. */
const pageLoads = new WeakMap<CacheStore, Map<string, Promise<string>>>();

/**
 * The entry under `key`, or `load()`'s result stored under it for `ttlMs`. One
 * read-or-load runs per store and key in this process at a time: a caller
 * that arrives while one is in flight joins it, and the in-flight map is
 * consulted before any await, so two callers can never both miss and load. A
 * failure rejects every caller that joined, and nothing is stored.
 */
export async function readThroughPageCache(
  store: CacheStore,
  key: string,
  ttlMs: number,
  load: () => Promise<string>,
): Promise<string> {
  let loads = pageLoads.get(store);
  if (loads === undefined) {
    loads = new Map();
    pageLoads.set(store, loads);
  }
  const pending = loads.get(key);
  if (pending !== undefined) return pending;
  const run = (async () => {
    const cached = await store.get(key);
    if (typeof cached === 'string') return cached;
    const value = await load();
    await store.set(key, value, ttlMs);
    return value;
  })();
  loads.set(key, run);
  try {
    return await run;
  } finally {
    if (loads.get(key) === run) loads.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Query-variant admission
// ---------------------------------------------------------------------------

/** Distinct live query variants one route may cache in one store. */
export const MAX_QUERY_VARIANTS_PER_ROUTE = 1_000;

/** Distinct live hosts, other than the public origin's, one store may cache pages for. */
export const MAX_CACHE_HOSTS_PER_STORE = 64;

/** store -> route -> variant key -> expiry (epoch ms). */
const variantBudgets = new WeakMap<CacheStore, Map<string, Map<string, number>>>();

/** store -> host -> expiry (epoch ms). */
const hostBudgets = new WeakMap<CacheStore, Map<string, number>>();

/**
 * Whether a query-string variant of `route` may be written to the cache. A
 * variant already admitted and not expired is always admitted again; a new
 * one is admitted while the route has fewer than
 * {@link MAX_QUERY_VARIANTS_PER_ROUTE} live variants.
 */
export function admitQueryVariant(
  store: CacheStore,
  route: string,
  variant: string,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  let routes = variantBudgets.get(store);
  if (routes === undefined) {
    routes = new Map();
    variantBudgets.set(store, routes);
  }
  let variants = routes.get(route);
  if (variants === undefined) {
    variants = new Map();
    routes.set(route, variants);
  }
  return admitBudgeted(variants, variant, MAX_QUERY_VARIANTS_PER_ROUTE, ttlMs, now);
}

/**
 * Whether pages requested under `host` may be written to the cache. A request
 * addressed to the configured canonical origin is always admitted; any other
 * host (a `server.hosts` alias, a tenant subdomain, or any host at all when no
 * origin is configured) is admitted while the store has fewer than
 * {@link MAX_CACHE_HOSTS_PER_STORE} live ones.
 */
export function admitPageCacheHost(
  store: CacheStore,
  host: string,
  canonical: boolean,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (canonical) return true;
  let hosts = hostBudgets.get(store);
  if (hosts === undefined) {
    hosts = new Map();
    hostBudgets.set(store, hosts);
  }
  return admitBudgeted(hosts, host, MAX_CACHE_HOSTS_PER_STORE, ttlMs, now);
}

/**
 * Admit `key` into a budget of at most `limit` live keys: a key already
 * admitted and not expired is admitted again (its expiry extended), and a new
 * one is admitted while there is room once expired keys are dropped.
 */
function admitBudgeted(
  budget: Map<string, number>,
  key: string,
  limit: number,
  ttlMs: number,
  now: number,
): boolean {
  const expiresAt = budget.get(key);
  if (expiresAt !== undefined && now < expiresAt) {
    budget.set(key, Math.max(expiresAt, now + ttlMs));
    return true;
  }
  if (budget.size >= limit) {
    for (const [entry, expiry] of budget) {
      if (now >= expiry) budget.delete(entry);
    }
    if (budget.size >= limit) {
      return false;
    }
  }
  budget.set(key, now + ttlMs);
  return true;
}
