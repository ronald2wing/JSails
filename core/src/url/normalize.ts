/**
 * URL-path normalization shared by the page cache and the i18n routing helpers.
 *
 * Both need the same canonical form for a route path: an absolute path with a
 * leading slash and no repeated slashes. Filesystem paths are a different
 * concern (Node's `node:path` owns those).
 *
 * Browser-safe and dependency-free.
 */

/** Normalize a URL path: empty/absent → `/`, ensure a leading slash, collapse `//`. */
export function normalizeUrlPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\/+/g, '/');
}
