/**
 * The one rule for an asset's URL path, and the two conversions between a
 * request's percent-encoded path and the decoded path an asset is indexed by.
 *
 * {@link validateAssetPath} is the only path validator of the asset index: a
 * file whose URL path it refuses is never indexed, so it is never served,
 * exported, or versioned. Paths are POSIX on every platform: the index builds
 * them from directory entry names joined with `/`, never from a platform path.
 *
 * A request path is decoded once, segment by segment
 * ({@link decodeAssetPath}): an encoded `/` inside a segment never becomes a
 * separator, and a malformed escape is a miss. {@link encodeAssetPath} is the
 * inverse the URLs the app emits use, so every indexed path round-trips.
 */

import type { AssetEntry } from './asset-index.js';

/** The one dot-prefixed segment an asset path may carry, and only first (RFC 8615). */
const WELL_KNOWN = '.well-known';

/** C0 controls and DEL: never part of a file name the index serves. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Whether `path` may name an asset: absolute, POSIX, no empty segment, no
 * backslash or control character, and no dot-prefixed segment (`.`, `..`, a
 * hidden file) except a literal first segment `.well-known`.
 *
 * @internal
 */
export function validateAssetPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length === 1) return false;
  if (path.includes('\\') || CONTROL.test(path)) return false;
  const segments = path.slice(1).split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment === '') return false;
    if (segment.startsWith('.') && !(index === 0 && segment === WELL_KNOWN)) return false;
  }
  return true;
}

/**
 * The decoded form of a request's `pathname`, or `undefined` when a segment
 * holds a malformed escape or decodes to one containing `/`. It is only ever
 * looked up, never used as a filesystem path.
 */
export function decodeAssetPath(pathname: string): string | undefined {
  if (!pathname.includes('%')) return pathname;
  const segments = pathname.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (!segment.includes('%')) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return undefined; // a malformed escape or invalid UTF-8: no asset has that path
    }
    if (decoded.includes('/')) return undefined;
    segments[index] = decoded;
  }
  return segments.join('/');
}

/** `path` (decoded) as a URL path: each segment percent-encoded. */
export function encodeAssetPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The other request paths an index document answers: `/dir/` and `/dir` for
 * `/dir/index.html`, `/` for `/index.html`; none for any other file.
 */
export function directoryAliases(path: string): readonly string[] {
  if (path === '/index.html') return ['/'];
  if (!path.endsWith('/index.html')) return [];
  const directory = path.slice(0, -'/index.html'.length);
  return [`${directory}/`, directory];
}

/** The indexed path a request for `path` may stand for, when `path` is a directory. */
export function directoryDocument(path: string): string {
  return path.endsWith('/') ? `${path}index.html` : `${path}/index.html`;
}

/** The entry `path` names in `byPath`, a directory standing for its `index.html`. */
export function lookup<T>(byPath: ReadonlyMap<string, T>, path: string): T | undefined {
  return byPath.get(path) ?? byPath.get(directoryDocument(path));
}

/** The URL an index answers for `path`, given its `get`. */
export function assetUrlOf(get: (path: string) => AssetEntry | undefined, path: string): string {
  if (typeof path !== 'string' || (path !== '/' && !validateAssetPath(path.replace(/\/$/, '')))) {
    return path;
  }
  const entry = get(path);
  if (entry === undefined) return path;
  const url = encodeAssetPath(path);
  return entry.immutable ? url : `${url}?v=${entry.hash}`;
}

/** Every request path that reaches the entry at `path`: itself, then its directory aliases. */
export function servedPaths(path: string): readonly string[] {
  return [path, ...directoryAliases(path)];
}
