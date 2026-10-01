/**
 * The result of one attempt. The processor is total: every attempt ends in
 * exactly one of these outcomes and never in a thrown error, so a transport
 * maps outcomes to its own operations without interpreting exceptions.
 *
 * - `completed`: the handler returned, also when it returned after its signal
 *   aborted (a shutdown or a timeout): the effect happened, and running it
 *   again would only duplicate it.
 * - `discarded`: the handler failed and the job's error policy dropped it.
 * - `skipped`: overlap control found the job already running; nothing ran.
 * - `released`: the job goes back to its queue without spending an attempt
 *   (shutdown, a rate limit, or a worker that does not know the job).
 * - `failed`: the attempt failed; `retryable` says whether another may follow.
 *   Two flags apply only when the failure is final
 *   (`isFinalFailure`), and the adapter acts on them in the same
 *   operation that settles the job: `catchFired` (the outcome's follow-ups
 *   hold the chain's catch, so the adapter marks `meta.flow.catchFired` on the
 *   stored envelope) and `drop` (the job's `onFinalFailure` is `'drop'`, so the
 *   adapter keeps no failed record).
 *
 * `followUps` are the jobs a settle enqueues: a chain's next step after a
 * completed, discarded or continuing skipped step, the chain's catch after a
 * final failure, a batch's callbacks after its finalizer completed. The
 * adapter stores them in the same operation that settles the job, so a
 * follow-up is never lost to a transport error between the two, and a job
 * whose handler completed is never failed over its follow-up. The follow-ups
 * of a failure that is not final are ignored.
 */

import type { ErrorKind } from 'jsails/errors';

import type { JobEnvelope } from './envelope.js';

/**
 * A value-free description of a failure: no payload, no `cause` chain and, by
 * default, no message. `src/errors/` produces it; a transport stores it as
 * the failure record.
 */
export interface JobErrorSummary {
  /** The stable framework code (`domain.code`), when the error carried one. */
  readonly code?: string;
  /** The error-kernel kind that decided retryability. */
  readonly kind: ErrorKind;
  /** The error's class name: a built-in error name or one that reads `<Name>Error`, else `Error`. */
  readonly name: string;
  /** Stack frames only, never a message line. */
  readonly stack?: string;
  /** The error's own message, capped; present only when the app opted into storing messages. */
  readonly message?: string;
}

/**
 * One job a settle enqueues, exactly as `JobsAdapter.enqueue` would store it:
 * on a declared queue, deduplicated by its key inside its window.
 */
export interface JobFollowUp {
  readonly queue: string;
  readonly envelope: JobEnvelope;
}

export type AttemptOutcome =
  | { readonly kind: 'completed'; readonly followUps?: readonly JobFollowUp[] }
  | {
      readonly kind: 'discarded';
      readonly error: JobErrorSummary;
      readonly followUps?: readonly JobFollowUp[];
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'overlap';
      readonly followUps?: readonly JobFollowUp[];
    }
  | {
      readonly kind: 'released';
      readonly reason: 'shutdown' | 'rate_limited' | 'unknown_job';
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'failed';
      readonly error: JobErrorSummary;
      readonly retryable: boolean;
      /** Final only: the follow-ups hold this chain's catch; the adapter marks the stored envelope. */
      readonly catchFired?: true;
      /** Final only: the job's `onFinalFailure` is `'drop'`; the adapter keeps no failed record. */
      readonly drop?: true;
      /** Final only: the chain's catch. */
      readonly followUps?: readonly JobFollowUp[];
    };
