/**
 * Project file watcher for `jsails dev`.
 *
 * Node 26 supports recursive `fs.watch` on Linux, macOS, and Windows, so the
 * dev runtime does not need nodemon/chokidar/braces. This watcher observes the
 * project tree, coalesces bursts of events, and reports the merged
 * {@link ChangeClass} once per quiet window.
 *
 * It deliberately does not know which paths matter: {@link classifyChange}
 * owns that decision, so the watcher stays a debouncer and the classification
 * table stays testable on its own.
 */

import { watch as watchFs, type FSWatcher } from 'node:fs';

import { classifyChange, mergeChangeClasses, type ChangeClass } from './change-classify.js';

/** A live project watcher; `close` is idempotent. */
export interface ProjectWatcher {
  close(): void;
}

/** Callbacks and test seams for {@link watchProject}. */
export interface ProjectWatcherOptions {
  /** Called once after a change burst settles, with the merged class. */
  readonly onChange: (change: ChangeClass) => void;
  /** Called for a watcher error; the watcher remains responsible for closing. */
  readonly onError: (error: unknown) => void;
  /** Quiet window used to coalesce a change burst. Defaults to 75ms. */
  readonly debounceMs?: number;
  /** Injectable `fs.watch` for tests; defaults to the real one. */
  readonly watch?: typeof watchFs;
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

  const schedule = (change: ChangeClass): void => {
    if (closed || change === 'ignore') {
      return;
    }
    pending.add(change);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) {
        return;
      }
      const merged = mergeChangeClasses(pending);
      pending.clear();
      options.onChange(merged);
    }, options.debounceMs ?? 75);
  };

  const watcher: FSWatcher = (options.watch ?? watchFs)(
    rootDir,
    { recursive: true },
    (_event, filename) => {
      // Some platforms omit the filename. Treat that as a server change: a
      // spurious restart is recoverable, a missed one leaves stale code running.
      schedule(filename === null ? 'server-restart' : classifyChange(filename.toString()));
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
      pending.clear();
      watcher.close();
    },
  };
}
