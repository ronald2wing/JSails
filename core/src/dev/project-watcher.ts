/**
 * Project file watcher for `jsails dev`.
 *
 * Node 26 supports recursive `fs.watch` on Linux, macOS, and Windows, so the
 * dev runtime does not need nodemon/chokidar/braces. This watcher observes the
 * project tree, coalesces bursts of events, and reports the merged
 * {@link ChangeClass} once per quiet window, plus a separate signal when a
 * source module `build:meta` scans changed.
 *
 * It deliberately does not know which paths matter: {@link classifyChange}
 * and {@link isMetaSourceChange} own that decision, so the watcher stays a debouncer and the classification
 * table stays testable on its own.
 */

import { watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';

import { toPosixId } from '../support/project-paths.server.js';

import {
  classifyChange,
  isMetaSourceChange,
  mergeChangeClasses,
  type ChangeClass,
} from './change-classify.js';

/** A live project watcher; `close` is idempotent. */
export interface ProjectWatcher {
  close(): void;
}

/** Callbacks and test seams for {@link watchProject}. */
export interface ProjectWatcherOptions {
  /**
   * Called once after a change burst settles, with the merged class and the
   * project-relative, `/`-separated ids of the burst's non-ignored events. `paths` is
   * `undefined` when the platform omitted a filename for any event in the
   * burst, so the receiver cannot know everything that changed.
   */
  readonly onChange: (change: ChangeClass, paths: readonly string[] | undefined) => void;
  /**
   * Called once after a burst that touched a source module `build:meta` scans
   * (see {@link isMetaSourceChange}) settles, or one with an unnamed event.
   */
  readonly onMetaSourceChange?: () => void;
  /** Called for a watcher error; the watcher remains responsible for closing. */
  readonly onError: (error: unknown) => void;
  /** Quiet window used to coalesce a change burst. Defaults to 75ms. */
  readonly debounceMs?: number;
  /** Injectable `fs.watch` for tests; defaults to the real one. */
  readonly watch?: typeof watchFs;
  /**
   * The separator rules of the filenames `watch` reports (default: this
   * platform's), so a test can feed the Windows form anywhere.
   */
  readonly pathApi?: Pick<typeof path, 'sep'>;
}

/**
 * Start watching `rootDir` recursively. Returns synchronously; a watcher error
 * is delivered through `onError` rather than thrown.
 */
export function watchProject(rootDir: string, options: ProjectWatcherOptions): ProjectWatcher {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  // Classes seen since the last flush. A burst that mixes a server change and
  // a client change must produce one action, not two.
  const pending = new Set<ChangeClass>();
  const pendingPaths = new Set<string>();
  let unnamed = false;
  let metaTimer: NodeJS.Timeout | undefined;

  // Source edits get their own quiet window: they usually arrive with no
  // restart-class change at all, and the generator should run once per burst.
  const scheduleMeta = (): void => {
    if (closed || options.onMetaSourceChange === undefined) return;
    if (metaTimer !== undefined) clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      metaTimer = undefined;
      if (!closed) options.onMetaSourceChange?.();
    }, options.debounceMs ?? 75);
  };

  const schedule = (change: ChangeClass, path: string | undefined): void => {
    if (closed || change === 'ignore') {
      return;
    }
    pending.add(change);
    if (path === undefined) {
      unnamed = true;
    } else {
      pendingPaths.add(path);
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) {
        return;
      }
      const merged = mergeChangeClasses(pending);
      const paths = unnamed ? undefined : [...pendingPaths];
      pending.clear();
      pendingPaths.clear();
      unnamed = false;
      options.onChange(merged, paths);
    }, options.debounceMs ?? 75);
  };

  const watcher: FSWatcher = (options.watch ?? watchFs)(
    rootDir,
    { recursive: true },
    (_event, filename) => {
      // Some platforms omit the filename. Treat that as a server change: a
      // spurious restart is recoverable, a missed one leaves stale code running.
      if (filename === null) {
        schedule('server-restart', undefined);
        scheduleMeta();
        return;
      }
      // `fs.watch` reports platform-separated paths; everything downstream
      // (classification, the burst's paths, the auto-import injector) works on
      // `/`-separated ids. Converting here, once, keeps a `\\` that is a legal
      // file-name character on POSIX from being read as a separator.
      const id = toPosixId(filename.toString(), options.pathApi ?? path);
      schedule(classifyChange(id), id);
      if (isMetaSourceChange(id)) scheduleMeta();
    },
  );

  watcher.on('error', (error) => {
    if (!closed) {
      options.onError(error);
    }
  });

  return {
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (metaTimer !== undefined) {
        clearTimeout(metaTimer);
        metaTimer = undefined;
      }
      pending.clear();
      pendingPaths.clear();
      watcher.close();
    },
  };
}
