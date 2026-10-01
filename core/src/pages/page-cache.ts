/**
 * Keys, generations, and admission for the shared page-props cache.
 *
 * A `cache: 'public'` page stores its `load()` result under a key built from
 * the route pattern, the request locale, the resolved params, and a full
 * SHA-256 digest of the query parameters that participate (all of them, or
 * only the page's declared `cacheQuery` names).
 *
 * Invalidation is generation-based and lives in the cache store itself: every
 * stored key carries the current generation token of its route path and of
 * each declared tag, and `revalidatePath`/`revalidateTag` replace that token.
 * Old entries then become unreachable at once — across processes sharing a
 * Valkey store, and regardless of whether the in-process reverse index still
 * remembers them — and age out through their TTL.
 *
 * Query strings are attacker-chosen, so the number of distinct query variants
 * one route may write is bounded per store; past the budget a request is
 * served with a fresh `load()` and nothing is written.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { CacheStore } from '../cache/store.js';
import type { RequestContext } from '../contracts/http.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { compareStrings } from '../support/index.js';
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
 * Derive the base cache key of a page from the route pattern, request locale,
 * resolved params, and query string. The key is independent of the
 * origin/host so it is stable across environments, and is namespaced under
 * `jsails:page:` to avoid colliding with other cache consumers.
 *
 * This is not the key an entry is stored under: the renderer appends the
 * current generation tokens of the route path and of each declared tag
 * (`<base>:g:<path>.<tags>`), and those tokens change on every revalidation.
 * Deleting this key from the store therefore purges nothing; invalidate a page
 * through `revalidatePath` or `revalidateTag`.
 *
 * The locale is part of the key because locale-prefixed aliases share one
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
  const parts: string[] = ['jsails:page', entry.route];

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
 * Lifetime of a generation token. Page entries are written with a TTL no
 * longer than this, so no entry outlives the token it was keyed under.
 */
export const PAGE_GENERATION_TTL_MS = 366 * 24 * 60 * 60 * 1000;

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
 * Append the current path and tag generations to a base key. A missing token
 * (never set, expired, or evicted by a shared store's memory policy) is
 * replaced by a fresh random one rather than a fixed default: a fixed default
 * would make every entry written before the first revalidation reachable
 * again the moment a later token disappeared. A store failure propagates so
 * the caller degrades to an uncached `load()`, never to a key that ignores a
 * revalidation.
 */
export async function versionedPageCacheKey(
  store: CacheStore,
  baseKey: string,
  path: string,
  tags: readonly string[],
): Promise<string> {
  const keys = [pathGenerationKey(path), ...tags.map((tag) => tagGenerationKey(tag))];
  const tokens = await Promise.all(
    keys.map((key) =>
      store.remember(key, PAGE_GENERATION_TTL_MS, () => Promise.resolve(newPageGeneration())),
    ),
  );
  return `${baseKey}:g:${tokens.join('.')}`;
}

// ---------------------------------------------------------------------------
// Query-variant admission
// ---------------------------------------------------------------------------

/** Distinct live query variants one route may cache in one store. */
export const MAX_QUERY_VARIANTS_PER_ROUTE = 1_000;

/** store -> route -> variant key -> expiry (epoch ms). */
const variantBudgets = new WeakMap<CacheStore, Map<string, Map<string, number>>>();

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

  const expiresAt = variants.get(variant);
  if (expiresAt !== undefined && now < expiresAt) {
    return true;
  }
  if (variants.size >= MAX_QUERY_VARIANTS_PER_ROUTE) {
    for (const [key, expiry] of variants) {
      if (now >= expiry) variants.delete(key);
    }
    if (variants.size >= MAX_QUERY_VARIANTS_PER_ROUTE) {
      return false;
    }
  }
  variants.set(variant, now + ttlMs);
  return true;
}
