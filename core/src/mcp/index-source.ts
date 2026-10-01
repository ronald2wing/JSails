/**
 * The MCP server's view of the code index.
 *
 * The MCP tools used to re-scan the tree on every call: `jsails_inspect_routes`
 * walked `pages/` and `api/`, `jsails_describe` walked it again, and neither
 * agreed with the compiler's own scan. This module makes the index the primary
 * source and keeps the live scan as an explicit fallback.
 *
 * The fallback is not silent. A tool result carries `source: 'index'` or
 * `source: 'scan'`, so a client can tell whether it is looking at a build-time
 * snapshot or a live walk. A **stale** index is never a fallback: it is a hard
 * error, because a stale answer is worse than no answer.
 */

import { readCodeIndex, type CodeIndex } from '../build/code-index.js';
import { CodeIndexError } from '../build/code-index.js';

/** Where a tool's data came from. */
export type IndexSource = 'index' | 'scan';

/** A tool result paired with its provenance. */
export interface SourcedResult<T> {
  readonly source: IndexSource;
  readonly data: T;
}

/**
 * Read the index for `rootDir`, or return `undefined` when it does not exist.
 * A stale or corrupt index throws — the caller must not fall back to a scan,
 * because the scan would answer a different question than the one the build
 * answered.
 */
export function tryReadCodeIndex(rootDir: string): CodeIndex | undefined {
  try {
    return readCodeIndex(rootDir);
  } catch (error) {
    if (error instanceof CodeIndexError && error.code === 'missing_index') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolve a tool's data from the index when it exists, else from `scan`.
 * `scan` is only called when the index is absent, so a present index costs one
 * file read and no tree walk.
 */
export async function fromIndexOrScan<T>(
  rootDir: string,
  project: (index: CodeIndex) => T,
  scan: () => Promise<T> | T,
): Promise<SourcedResult<T>> {
  const index = tryReadCodeIndex(rootDir);
  if (index !== undefined) {
    return { source: 'index', data: project(index) };
  }
  return { source: 'scan', data: await scan() };
}
