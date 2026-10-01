/**
 * Cancellation for one run: a single abort signal that fires on the caller's
 * signal, on `run.abort()`, at the run deadline, or after an idle stream, and
 * remembers which came first.
 *
 * The signal reaches the provider call and every tool. The first reason wins,
 * so a run aborted by its caller is never reported as timed out because a
 * timer fired while it was winding down.
 */

import { AiError } from '../errors/ai-error.js';

/** Why a run was stopped from outside its own logic. */
export type RunStopReason = 'aborted' | 'deadline' | 'idle';

/** The cancellation state of one run. */
export interface RunControl {
  readonly signal: AbortSignal;
  /** The first stop reason, or `undefined` while the run may continue. */
  stopReason(): RunStopReason | undefined;
  stop(reason: RunStopReason): void;
  /** Attach the caller's signal and start the deadline. Called when the run starts. */
  start(): void;
  /** Detach the caller's signal and clear the deadline. */
  dispose(): void;
}

/** A control for a run with an optional deadline and caller signal. */
export function createRunControl(timeoutMs: number, external: AbortSignal | undefined): RunControl {
  const controller = new AbortController();
  let reason: RunStopReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (next: RunStopReason): void => {
    if (reason !== undefined) return;
    reason = next;
    controller.abort();
  };
  const onExternalAbort = (): void => stop('aborted');
  return {
    signal: controller.signal,
    stopReason: () => reason,
    stop,
    start() {
      if (external !== undefined) {
        if (external.aborted) stop('aborted');
        else external.addEventListener('abort', onExternalAbort, { once: true });
      }
      if (timeoutMs > 0 && reason === undefined) {
        timer = setTimeout(() => stop('deadline'), timeoutMs);
      }
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** The value-free error a stop reason settles the run with. */
export function stopError(reason: RunStopReason): AiError {
  if (reason === 'aborted') return new AiError('aborted', 'the run was aborted');
  return new AiError('timed_out', 'the run timed out', { context: { timeout: reason } });
}
