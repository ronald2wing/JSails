/**
 * The development filler of the asset index: an index that follows the
 * files while a dev server runs.
 *
 * The walk records each file's size and mtime (nanoseconds); a file is hashed
 * on first `get` or `url`, never at the walk. Each `get` re-reads its file's
 * size and mtime (one `lstat`) and hands back a new entry object whenever
 * they moved, so a caller holding an entry can ask again and compare: the
 * responder does so after it opens the file, and answers a request that
 * raced a bundler's write again from the new bytes under their new hash.
 * Additions and removals come from watching each root: any event marks the
 * index stale, and the next access walks again, keeping every hash whose file
 * did not change, and tells the change listeners when the set of paths moved.
 * A walk that throws leaves the index stale, so the next access tries again.
 * A watcher that fails is closed, the index marked stale, and a new watcher
 * opened on the next access; while a root cannot be watched at all, every
 * access walks again. When the first walk throws, every watcher it opened is
 * closed before the error reaches the caller, who never holds an index to
 * close. The index runs no timer: work happens inside the access that needs
 * it. The one timer is {@link withSettleEvent}'s, which the default watcher
 * uses to report a change the platform watcher was not yet live to see.
 *
 * A file the process may not read is a miss: it is neither served nor
 * marked stale (a permission change moves no mtime, so nothing would ever
 * walk it back), and the next `get` tries to read it again.
 */

import type { AssetEntry, AssetIndex } from './asset-index.js';
import { assetUrlOf, lookup } from './asset-path.js';
import {
  lstatForIndex,
  readForIndexSync,
  walkRoots,
  type ResolvedAssetRoot,
  type Walk,
} from './asset-walk.js';

/**
 * How the development index watches one root: call `onEvent` on any change
 * below `dir`, `onError` when the watch fails; `close` stops it. It may throw
 * when the root cannot be watched.
 *
 * @public
 */
export type WatchAssetRoot = (
  dir: string,
  onEvent: () => void,
  onError: (error: unknown) => void,
) => { close(): void };

/**
 * `watch`, reporting one more event `settleMs` after each watcher opens.
 *
 * A platform watcher may start delivering events some time after it returns.
 * On macOS, libuv hands the FSEvents stream to its own run-loop thread, which
 * starts it from the event id current at that moment, so a change made in
 * between (a bundler's first write, a file added right after the dev server
 * starts) is never reported. The index walked when the watcher opened and,
 * with no event to come, would not look again; the late event makes the next
 * access walk once the stream is live. The timer does not keep the process
 * alive and ends with the watcher.
 */
export function withSettleEvent(watch: WatchAssetRoot, settleMs: number): WatchAssetRoot {
  return (dir, onEvent, onError) => {
    const watcher = watch(dir, onEvent, onError);
    const timer = setTimeout(onEvent, settleMs);
    timer.unref();
    return {
      close: () => {
        clearTimeout(timer);
        watcher.close();
      },
    };
  };
}

/** One walked file: what the walk saw, and its entry once hashed. */
interface FileRecord {
  readonly path: string;
  readonly file: string;
  readonly owner: string;
  size: bigint;
  mtimeNs: bigint;
  entry: AssetEntry | undefined;
}

/** Build the development index of `roots`, watching each through `watch`. */
export function createWatchIndex(
  roots: readonly ResolvedAssetRoot[],
  watch: WatchAssetRoot,
  warnLeftOut: (counts: Pick<Walk, 'refused' | 'unreadable'>) => void,
): AssetIndex {
  let records = new Map<string, FileRecord>();
  let stale = true;
  let closed = false;
  const watchers = new Map<string, { close(): void }>();
  const listeners = new Set<() => void>();

  const markStale = (): void => {
    stale = true;
  };

  /**
   * Open a watcher for every root without one (marking the index stale, since
   * nothing watched the root until now); false when a root cannot be watched.
   */
  const ensureWatching = (): boolean => {
    let watching = true;
    for (const root of roots) {
      if (watchers.has(root.dir)) continue;
      try {
        const watcher = watch(root.dir, markStale, () => {
          watchers.delete(root.dir);
          watcher.close();
          markStale();
        });
        watchers.set(root.dir, watcher);
        // Whatever changed before this watcher opened was never reported.
        stale = true;
      } catch {
        // An unwatchable root (removed, or out of watch handles) is walked on every access instead.
        watching = false;
      }
    }
    return watching;
  };

  /** Walk again, keeping unchanged records; whether the set of paths changed. */
  const rewalk = (first: boolean): boolean => {
    const walk = walkRoots(roots);
    if (first) warnLeftOut(walk);
    const next = new Map<string, FileRecord>();
    for (const walked of walk.files) {
      const stat = lstatForIndex(walked.file, walked.path);
      if (typeof stat === 'string' || !stat.isFile()) continue;
      const previous = records.get(walked.path);
      if (
        previous !== undefined &&
        previous.file === walked.file &&
        previous.size === stat.size &&
        previous.mtimeNs === stat.mtimeNs
      ) {
        next.set(walked.path, previous);
      } else {
        next.set(walked.path, {
          ...walked,
          size: stat.size,
          mtimeNs: stat.mtimeNs,
          entry: undefined,
        });
      }
    }
    const changed = next.size !== records.size || [...next.keys()].some((p) => !records.has(p));
    records = next;
    return changed;
  };

  const refresh = (): void => {
    if (closed) return;
    const watching = ensureWatching();
    if (!stale && watching) return;
    // Fresh before the listeners run: they read the index back.
    stale = false;
    let changed: boolean;
    try {
      changed = rewalk(false);
    } catch (error) {
      stale = true;
      throw error;
    }
    if (changed) for (const listener of [...listeners]) listener();
  };

  /** The record's entry, hashing the file when it changed or was never hashed. */
  const entryOf = (record: FileRecord): AssetEntry | undefined => {
    const stat = lstatForIndex(record.file, record.path);
    if (stat === 'unreadable') return undefined;
    if (stat === 'gone' || !stat.isFile()) {
      // Gone or replaced: the next access walks again and drops it.
      stale = true;
      return undefined;
    }
    if (stat.size !== record.size || stat.mtimeNs !== record.mtimeNs) {
      record.size = stat.size;
      record.mtimeNs = stat.mtimeNs;
      record.entry = undefined;
    }
    if (record.entry !== undefined) return record.entry;
    const read = readForIndexSync(record.file, record.path);
    if (read === 'unreadable') return undefined;
    if (read === 'gone') {
      // Gone or replaced: the next access walks again and drops it.
      stale = true;
      return undefined;
    }
    record.entry = Object.freeze({
      path: record.path,
      file: record.file,
      hash: read.hash,
      size: read.size,
      immutable: false,
      encodings: Object.freeze({}),
      owner: record.owner,
    });
    return record.entry;
  };

  const get = (path: string): AssetEntry | undefined => {
    refresh();
    const record = lookup(records, path);
    return record === undefined ? undefined : entryOf(record);
  };

  const sortedRecords = (): FileRecord[] =>
    [...records.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  try {
    ensureWatching();
    stale = false;
    rewalk(true);
  } catch (error) {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    throw error;
  }

  return Object.freeze({
    source: 'watch' as const,
    roots,
    get,
    url: (path: string) => assetUrlOf(get, path),
    entries: () => {
      refresh();
      return sortedRecords()
        .map(entryOf)
        .filter((entry): entry is AssetEntry => entry !== undefined);
    },
    paths: () => {
      refresh();
      return sortedRecords().map((record) => record.path);
    },
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  });
}
