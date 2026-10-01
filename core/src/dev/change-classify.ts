/**
 * Change classification for the dev loop.
 *
 * A file change can mean three different things, and the dev runtime must
 * respond differently to each. Restarting the server for a CSS edit wastes a
 * full boot; ignoring a CSS edit leaves the browser showing stale styles. This
 * module is the single source of truth for that decision.
 *
 * The rules are ordered and the first match wins. Two orderings are load
 * bearing:
 *
 * - `public/assets/` is checked BEFORE the `public` ignore rule. Vite writes
 *   its bundles there, and those writes are the only signal that a client
 *   change landed. Treating them as ignored (which the old watcher did) is why
 *   a CSS edit produced no reload at all.
 * - `.ts`/`.tsx` are NOT restart triggers. `tsc --watch` emits the `.js` that
 *   already triggers a restart; reacting to the source file too would restart
 *   against a `dist/` that has not been rewritten yet.
 */

/** What the dev runtime should do in response to a change. */
export type ChangeClass = 'server-restart' | 'client-reload' | 'ignore';

/** Directories whose contents never affect the running app. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', '.git', 'out', '.jsails']);

/** Vite's output directory, relative to the project root. */
const CLIENT_OUTPUT_PREFIX = 'public/assets/';

/** Extensions that the serve child actually loads. */
const SERVER_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs']);

/**
 * Classify one changed path, relative to the project root.
 *
 * Absolute paths and paths that escape the root are ignored: the watcher only
 * reports paths under the root, so anything else is a bug or a symlink escape
 * and must not drive a restart.
 */
export function classifyChange(filename: string): ChangeClass {
  const normalized = filename.replaceAll('\\', '/');
  if (normalized === '' || normalized.startsWith('/') || normalized.startsWith('../')) {
    return 'ignore';
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) {
    return 'ignore';
  }

  // Vite output: a client change landed, but the server is unaffected.
  if (normalized.startsWith(CLIENT_OUTPUT_PREFIX)) {
    return 'client-reload';
  }

  // Hand-copied public files are served live from disk, so a browser refresh
  // already sees them. No restart, no reload.
  if (segments.includes('public')) {
    return 'ignore';
  }

  const extension = extensionOf(normalized);
  if (SERVER_EXTENSIONS.has(extension)) {
    return 'server-restart';
  }

  return 'ignore';
}

/**
 * Collapse the classes seen in one debounce window into the single action to
 * take. A restart re-serves the new client assets anyway, so it subsumes a
 * reload; a reload is strictly more than nothing.
 */
export function mergeChangeClasses(classes: Iterable<ChangeClass>): ChangeClass {
  let merged: ChangeClass = 'ignore';
  for (const change of classes) {
    if (change === 'server-restart') {
      return 'server-restart';
    }
    if (change === 'client-reload') {
      merged = 'client-reload';
    }
  }
  return merged;
}

function extensionOf(filename: string): string {
  const slash = filename.lastIndexOf('/');
  const dot = filename.lastIndexOf('.');
  return dot > slash ? filename.slice(dot) : '';
}
