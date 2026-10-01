/**
 * Quality-value lookup for `Accept`-style request headers.
 *
 * Used to choose an HTML error page over the problem envelope for a browser
 * navigation, the response finalizer's content coding, and a precompressed
 * public-file variant for `Accept-Encoding`.
 * Only exact tokens are matched (plus an optional `*` or `type/*` fallback the
 * caller asks for), so `*\/*` alone never reads as "wants HTML".
 */

/**
 * The q-value `header` gives `token`, case-insensitively: the explicit entry
 * when present, else the best of `fallbacks` (e.g. `*`), else 0. A malformed
 * q-value reads as 0 so it can never select a representation.
 */
export function acceptQuality(
  header: string | null | undefined,
  token: string,
  fallbacks: readonly string[] = [],
): number {
  if (header === null || header === undefined || header === '') return 0;
  const wanted = token.toLowerCase();
  const fallbackSet = new Set(fallbacks.map((value) => value.toLowerCase()));
  let fallbackQ: number | undefined;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName?.trim().toLowerCase() ?? '';
    if (name === '') continue;
    const q = parseQuality(params);
    if (name === wanted) return q;
    if (fallbackSet.has(name)) fallbackQ = Math.max(fallbackQ ?? 0, q);
  }
  return fallbackQ ?? 0;
}

/** A content coding the response finalizer produces. */
export type ContentCoding = 'br' | 'gzip';

/**
 * The coding to answer `acceptEncoding` with, or `undefined` for identity:
 * the highest positive q-value, `*` standing in for an unlisted coding, and
 * brotli on a tie.
 */
export function selectEncoding(
  acceptEncoding: string | null | undefined,
): ContentCoding | undefined {
  const br = acceptQuality(acceptEncoding, 'br', ['*']);
  const gzip = acceptQuality(acceptEncoding, 'gzip', ['*']);
  if (br === 0 && gzip === 0) return undefined;
  return br >= gzip ? 'br' : 'gzip';
}

/** Read the `q=` parameter; absent means 1, malformed or out of range means 0. */
function parseQuality(params: readonly string[]): number {
  for (const param of params) {
    const [key, value] = param.split('=');
    if (key?.trim().toLowerCase() !== 'q') continue;
    const trimmed = value?.trim() ?? '';
    if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(trimmed)) return 0;
    return Number(trimmed);
  }
  return 1;
}
