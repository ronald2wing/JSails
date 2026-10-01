/**
 * The four job signals a runtime worker emits, one per settled attempt, on
 * the app's signal bus: {@link jobCompleted}, {@link jobSkipped},
 * {@link jobReleased} and {@link jobFailed}.
 *
 * Payloads are value-free: the job's id, queue and name, its attempt number,
 * and the outcome's own fields (a {@link JobErrorSummary} for a failure),
 * never the payload, the tags or the execution context. A job whose
 * definition the worker lacks has `name: undefined`, because its stored name
 * is foreign data from another release. A discarded failure is a handled one,
 * so it rides on `jobCompleted` (with its summary in `discarded`), and
 * observers that alert on failures stay quiet. `jobFailed` carries `final`,
 * decided by the adapter (no further attempt follows), and `failedJob`, where
 * a final failure the transport kept can be found (absent for a retried
 * attempt and for a job whose `onFinalFailure` dropped it).
 *
 * The names live in the `jobs.` domain, apart from the `job.*` tokens of the
 * old `jsails/jobs` runtime.
 */

import { defineEvent, type EventToken } from 'jsails/extensions';
import type { SignalBus } from 'jsails/signals';

import type { FailedJobRef, JobErrorSummary, SettleEvent } from '../contract/index.js';
import { isJobName } from '../envelope/job-options.js';

/** What every job signal carries. */
export interface JobSignalBase {
  /** The transport's id for the job. */
  readonly id: string;
  readonly queue: string;
  /** The job's name, or `undefined` when this worker does not know it as one. */
  readonly name: string | undefined;
  /** One-based attempt number; a released attempt is not counted. */
  readonly attempt: number;
}

/** A job ran to completion, or failed and its error policy discarded it. */
export interface JobCompletedSignal extends JobSignalBase {
  /** The handled failure's summary when the job's `onError` discarded it. */
  readonly discarded: JobErrorSummary | undefined;
}

/** Overlap control found the job already running; nothing ran. */
export interface JobSkippedSignal extends JobSignalBase {
  readonly reason: 'overlap';
}

/** The job went back to its queue without spending an attempt. */
export interface JobReleasedSignal extends JobSignalBase {
  readonly reason: 'shutdown' | 'rate_limited' | 'unknown_job';
  readonly delayMs: number | undefined;
}

/** An attempt failed. */
export interface JobFailedSignal extends JobSignalBase {
  readonly error: JobErrorSummary;
  readonly retryable: boolean;
  /** True when no further attempt follows. */
  readonly final: boolean;
  /** Where the failed job is kept: present only on a final failure the transport kept. */
  readonly failedJob?: FailedJobRef;
}

/**
 * A job completed, or its failure was discarded.
 *
 * @public
 */
export const jobCompleted: EventToken<JobCompletedSignal> =
  defineEvent<JobCompletedSignal>('jobs.completed');

/**
 * A job was skipped by overlap control.
 *
 * @public
 */
export const jobSkipped: EventToken<JobSkippedSignal> =
  defineEvent<JobSkippedSignal>('jobs.skipped');

/**
 * A job was released back to its queue.
 *
 * @public
 */
export const jobReleased: EventToken<JobReleasedSignal> =
  defineEvent<JobReleasedSignal>('jobs.released');

/**
 * An attempt failed; `final` says whether it was the last.
 *
 * @public
 */
export const jobFailed: EventToken<JobFailedSignal> = defineEvent<JobFailedSignal>('jobs.failed');

/** Surface an error nothing can handle as an uncaught exception, never dropped. */
export function escalate(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

function base(event: SettleEvent): JobSignalBase {
  const { job } = event;
  return {
    id: job.id,
    queue: job.queue,
    name: isJobName(job.envelope.name) ? job.envelope.name : undefined,
    attempt: job.attemptsMade + 1,
  };
}

/**
 * Emit the signal of one settle event on `signals`. Never throws back into
 * the adapter: a bus that throws or rejects is escalated as an uncaught
 * exception. Errors of observers the bus isolates are its result, not a
 * rejection.
 */
export function emitSettleSignal(signals: SignalBus, event: SettleEvent): void {
  try {
    const head = base(event);
    const { outcome } = event;
    let emitted: Promise<readonly unknown[]>;
    switch (outcome.kind) {
      case 'completed':
        emitted = signals.emit(jobCompleted, Object.freeze({ ...head, discarded: undefined }));
        break;
      case 'discarded':
        emitted = signals.emit(jobCompleted, Object.freeze({ ...head, discarded: outcome.error }));
        break;
      case 'skipped':
        emitted = signals.emit(jobSkipped, Object.freeze({ ...head, reason: outcome.reason }));
        break;
      case 'released':
        emitted = signals.emit(
          jobReleased,
          Object.freeze({ ...head, reason: outcome.reason, delayMs: outcome.delayMs }),
        );
        break;
      case 'failed':
        emitted = signals.emit(
          jobFailed,
          Object.freeze({
            ...head,
            error: outcome.error,
            retryable: outcome.retryable,
            final: event.final,
            ...(event.failedJob === undefined
              ? {}
              : {
                  failedJob: Object.freeze({
                    id: event.failedJob.id,
                    queue: event.failedJob.queue,
                  }),
                }),
          }),
        );
        break;
    }
    emitted.then(undefined, escalate);
  } catch (error) {
    escalate(error);
  }
}
