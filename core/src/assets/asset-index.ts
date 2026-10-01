/**
 * The asset index: every file the app serves from its asset roots (the app's
 * `public/`, plus any root a plugin serves under its own prefix), each
 * described once by an {@link AssetEntry}.
 *
 * One type, three fillers:
 * - `snapshot` ({@link createAssetIndex}, the default): walks every root once
 *   at assembly, hashes every file, and keeps the bytes of small files
 *   (inline) within a budget. Production and tests use it: the index is a
 *   deploy-time snapshot, so a file added or replaced after the start is not
 *   served under the old entry (a replaced one answers `asset.stale_assets`).
 * - `watch` (development): the walk records each file's size and mtime and a
 *   hash is computed on first use (`watch-index.ts`).
 * - a fixed set of entries ({@link assetIndexOf}): what the build pass's
 *   manifest loader fills.
 *
 * Every lookup is a `Map` read: serving, versioning (`url`), static export
 * and the collision rule never touch the filesystem to answer a path. URL
 * paths are decoded and POSIX; `/dir/` and `/dir` stand for `dir/index.html`,
 * and `/` for `index.html`.
 */

import { watch as watchFs } from 'node:fs';

import { AssetErrors } from './asset-errors.js';
import { assetUrlOf, lookup } from './asset-path.js';
import {
  readForIndex,
  resolveRoots,
  walkRoots,
  type AssetRoot,
  type ResolvedAssetRoot,
  type Walk,
} from './asset-walk.js';
import { createWatchIndex, withSettleEvent, type WatchAssetRoot } from './watch-index.js';

export type { AssetRoot, ResolvedAssetRoot, WatchAssetRoot };

/**
 * A precompressed copy of an asset.
 *
 * @public
 */
export interface AssetVariant {
  /** Its absolute location. */
  readonly file: string;
  readonly size: number;
}

/**
 * One file the app serves.
 *
 * @public
 */
export interface AssetEntry {
  /** Its URL path, decoded and POSIX: `/assets/app.css`. */
  readonly path: string;
  /** Its absolute location. */
  readonly file: string;
  /** Its content hash: SHA-256, base64url, 16 characters. */
  readonly hash: string;
  /** Its size in bytes. */
  readonly size: number;
  /** Content-addressed by its name (a fingerprinted bundler output): cacheable for a year at any URL. */
  readonly immutable: boolean;
  /** Its bytes, when the index holds them. */
  readonly inline?: Uint8Array<ArrayBuffer>;
  /** Its precompressed copies. */
  readonly encodings: { readonly br?: AssetVariant; readonly gzip?: AssetVariant };
  /** Who provides it: `app` or a plugin's name. */
  readonly owner: string;
}

/**
 * Which filler built an index.
 *
 * @public
 */
export type AssetIndexSource = 'manifest' | 'snapshot' | 'watch';

/**
 * Every file the app serves.
 *
 * @public
 */
export interface AssetIndex {
  readonly source: AssetIndexSource;
  /** The roots it reads, as resolved. */
  readonly roots: readonly ResolvedAssetRoot[];
  /** The entry `path` (decoded) names, a directory standing for its `index.html`. */
  get(path: string): AssetEntry | undefined;
  /**
   * The URL to emit for `path` (decoded): percent-encoded, with `?v=<hash>`
   * unless the entry is immutable. Anything the index does not hold comes back
   * unchanged, so a page never fails on a link.
   */
  url(path: string): string;
  /** Every entry, sorted by path. */
  entries(): Iterable<AssetEntry>;
  /** Every entry's path, sorted, without reading any file. */
  paths(): Iterable<string>;
  /** Call `listener` when the set of paths changes (development only); returns its removal. */
  onChange(listener: () => void): () => void;
  /** Stop watching (development); the entries stay readable. */
  close(): void;
}

/**
 * How {@link createAssetIndex} fills an index.
 *
 * @public
 */
export interface CreateAssetIndexOptions {
  readonly roots: readonly AssetRoot[];
  /** `snapshot` (the default) or `watch` (development). */
  readonly mode?: 'snapshot' | 'watch';
  /**
   * How the `watch` filler watches a root; tests pass their own. Defaults to
   * a recursive `fs.watch` that does not keep the process alive and reports
   * one more change a second after it opens, since the platform may not
   * deliver events from the moment `fs.watch` returns (FSEvents on macOS).
   */
  readonly watch?: WatchAssetRoot;
}

/** Files up to this size are held inline by a snapshot. */
export const INLINE_MAX_BYTES: number = 64 * 1024;

/** The most bytes a snapshot holds inline in all. */
export const INLINE_BUDGET_BYTES: number = 32 * 1024 * 1024;

const NO_CHANGE = (): void => undefined;

/**
 * Build the index of `options.roots`.
 *
 * @throws `asset.invalid_options`, `asset.invalid_root`, `asset.invalid_prefix`,
 *   `asset.duplicate_asset`, `asset.read_failed`.
 * @public
 */
export async function createAssetIndex(options: CreateAssetIndexOptions): Promise<AssetIndex> {
  if (
    options === null ||
    typeof options !== 'object' ||
    !Array.isArray(options.roots) ||
    (options.mode !== undefined && options.mode !== 'snapshot' && options.mode !== 'watch') ||
    (options.watch !== undefined && typeof options.watch !== 'function')
  ) {
    throw new AssetErrors.Error('invalid_options');
  }
  const roots = resolveRoots(options.roots);
  if (options.mode === 'watch') {
    return createWatchIndex(roots, options.watch ?? watchRecursively, warnLeftOut);
  }
  const walk = walkRoots(roots);
  const entries: AssetEntry[] = [];
  let unreadable = walk.unreadable;
  let budget = INLINE_BUDGET_BYTES;
  for (const walked of walk.files) {
    const read = await readForIndex(walked.file, walked.path, Math.min(INLINE_MAX_BYTES, budget));
    // Gone since the walk: it is simply not part of the snapshot.
    if (read === 'gone') continue;
    if (read === 'unreadable') {
      unreadable += 1;
      continue;
    }
    if (read.bytes !== undefined) budget -= read.size;
    entries.push(
      Object.freeze({
        path: walked.path,
        file: walked.file,
        hash: read.hash,
        size: read.size,
        immutable: false,
        ...(read.bytes === undefined ? {} : { inline: read.bytes }),
        encodings: Object.freeze({}),
        owner: walked.owner,
      }),
    );
  }
  warnLeftOut({ refused: walk.refused, unreadable });
  return assetIndexOf(entries, { source: 'snapshot', roots });
}

/**
 * An index over a fixed set of entries: what the build pass's manifest
 * loader fills, and what tests build directly.
 *
 * @internal
 */
export function assetIndexOf(
  entries: Iterable<AssetEntry>,
  options: {
    readonly source?: AssetIndexSource;
    readonly roots?: readonly ResolvedAssetRoot[];
  } = {},
): AssetIndex {
  const byPath = new Map<string, AssetEntry>();
  for (const entry of entries) byPath.set(entry.path, entry);
  const sorted = Object.freeze([...byPath.values()].sort(byEntryPath));
  const get = (path: string): AssetEntry | undefined => lookup(byPath, path);
  return Object.freeze({
    source: options.source ?? 'manifest',
    roots: Object.freeze([...(options.roots ?? [])]),
    get,
    url: (path: string) => assetUrlOf(get, path),
    entries: () => sorted,
    paths: () => sorted.map((entry) => entry.path),
    onChange: () => NO_CHANGE,
    close: NO_CHANGE,
  });
}

function byEntryPath(a: AssetEntry, b: AssetEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * One warning for the entries a walk left out that are not hidden, and one
 * for those the process may not read.
 */
function warnLeftOut(counts: Pick<Walk, 'refused' | 'unreadable'>): void {
  if (counts.refused > 0) {
    process.emitWarning(
      `jsails: ${counts.refused} file(s) in an asset root are not served: symbolic links, special files, and names an asset path may not carry`,
      { code: 'JSAILS_ASSETS_REFUSED' },
    );
  }
  if (counts.unreadable > 0) {
    process.emitWarning(
      `jsails: ${counts.unreadable} file(s) or directories in an asset root are not served: the server may not read them`,
      { code: 'JSAILS_ASSETS_UNREADABLE' },
    );
  }
}

/**
 * How long the default watch gives the platform to make its events live after
 * `fs.watch` returns. The FSEvents stream starts on another thread once it is
 * scheduled; a second leaves room for a loaded machine, and a change made in
 * that gap shows at most a second late.
 */
const WATCH_SETTLE_MS = 1000;

/**
 * The default watch: a recursive `fs.watch` that does not keep the process
 * alive, with the late event of {@link withSettleEvent}.
 */
const watchRecursively: WatchAssetRoot = withSettleEvent((dir, onEvent, onError) => {
  const watcher = watchFs(dir, { recursive: true, persistent: false }, onEvent);
  watcher.on('error', onError);
  return { close: () => watcher.close() };
}, WATCH_SETTLE_MS);
