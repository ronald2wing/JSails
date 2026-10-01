/**
 * The one place core turns filesystem paths into module ids and import URLs,
 * so path handling is the same on POSIX and Windows. Server-only (Node `path`
 * and `url`).
 *
 * - {@link toPosixId}: a relative filesystem path as a `/`-separated id, the
 *   form route tables, manifests, and generated code compare and store. On
 *   Windows `relative()` and `join()` return `\`-separated paths, so splitting
 *   their result on `/` (or joining with `/`) silently keeps one segment.
 * - {@link toFileUrl} / {@link importFile}: a filesystem path as a `file:` URL
 *   and its dynamic import. `import()` takes a URL or a module specifier, never
 *   a path: `C:\app\x.js` fails with ERR_UNSUPPORTED_ESM_URL_SCHEME, and a
 *   POSIX path containing `#`, `?`, or `%` is read as a URL fragment, query,
 *   or escape. `pathToFileURL` escapes all of them.
 * - {@link importModule}: a module specifier (a package name, a subpath, or a
 *   URL) imported as given; an absolute filesystem path is routed through
 *   {@link importFile} so the same call works on every platform, and a
 *   relative specifier, which would resolve against this file, is refused.
 *
 * `eslint/paths.mjs` bans a non-literal `import()` and the hand-written
 * separator conversions (`.split(sep)`, `.split('/')` on a `path` call result)
 * in core outside this module.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Options for {@link importFile}. */
export interface ImportFileOptions {
  /**
   * A cache key for this evaluation. ESM caches a module by URL, so a distinct
   * key gives the file a new URL and a fresh evaluation in the same process
   * (a rebuilt config read twice). Omitted, the module is shared as usual.
   */
  readonly version?: string | number;
}

/**
 * `relativePath` with every platform separator replaced by `/`. A path that is
 * already `/`-separated is returned unchanged, so the result is a stable id on
 * every platform. `pathApi` selects the separator rules (default: this
 * platform's), which lets a test exercise the Windows form anywhere.
 */
export function toPosixId(relativePath: string, pathApi: Pick<typeof path, 'sep'> = path): string {
  return pathApi.sep === '/' ? relativePath : relativePath.split(pathApi.sep).join('/');
}

/**
 * The `file:` URL of `filePath`, resolved against the working directory when
 * relative. Every character a path may hold but a URL treats specially (`#`,
 * `?`, `%`, a space, a drive letter, a backslash) is escaped.
 */
export function toFileUrl(filePath: string): URL {
  return pathToFileURL(path.resolve(filePath));
}

/**
 * Dynamically imports the module at `filePath` (absolute, or relative to the
 * working directory). With `version`, the module is evaluated again under a
 * distinct URL instead of answering from the module cache.
 */
export function importFile<T = Record<string, unknown>>(
  filePath: string,
  options: ImportFileOptions = {},
): Promise<T> {
  const url = toFileUrl(filePath);
  if (options.version !== undefined) url.searchParams.set('v', String(options.version));
  return import(url.href) as Promise<T>;
}

/**
 * Dynamically imports a module specifier: a bare package name or subpath
 * (resolved by Node from the `jsails` package, as an `import()` anywhere in
 * core would be) or a URL. An absolute filesystem path is imported through
 * {@link importFile} instead of being handed to `import()` as a string. A
 * relative specifier is refused: it would resolve against this module, not
 * against the caller or the project.
 */
export function importModule<T = Record<string, unknown>>(specifier: string): Promise<T> {
  if (path.isAbsolute(specifier)) return importFile<T>(specifier);
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return Promise.reject(
      new TypeError('a relative module specifier has no base here; pass an absolute path'),
    );
  }
  return import(specifier) as Promise<T>;
}
