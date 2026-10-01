/**
 * Shared diagnostics test fixtures: a recorder on a fake clock, a watcher
 * context that records into one, and a context that only collects entries.
 */

import type { DiagnosticsEntry, DiagnosticsRecorderOptions } from 'jsails/diagnostics';
import { createFakeClock } from 'jsails/testing';
import { InMemoryDiagnosticsRecorder } from '../src/recorder.js';
import type { WatcherContext } from '../src/watchers/registry.js';

/** A recorder whose clock starts at `0` and never moves on its own. */
export function createRecorder(
  options: Omit<DiagnosticsRecorderOptions, 'clock'> = {},
): InMemoryDiagnosticsRecorder {
  return new InMemoryDiagnosticsRecorder({ ...options, clock: createFakeClock().now });
}

/** A watcher context that records into `recorder` on a fake clock. */
export function recordingContext(recorder: InMemoryDiagnosticsRecorder): WatcherContext {
  return { record: (entry) => recorder.record(entry), now: createFakeClock().now };
}

/** A watcher context that only collects the entries a watcher records. */
export function collectingContext(): { ctx: WatcherContext; recorded: DiagnosticsEntry[] } {
  const recorded: DiagnosticsEntry[] = [];
  const clock = createFakeClock();
  return {
    recorded,
    ctx: { record: (entry) => recorded.push({ ...entry, at: clock.now() }), now: clock.now },
  };
}
