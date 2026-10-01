/**
 * The result of one attempt. The processor is total: every attempt ends in
 * exactly one of these outcomes and never in a thrown error, so a transport
 * maps outcomes to its own operations without interpreting exceptions.
 *
 * - `completed`: the handler returned.
 * - `discarded`: the handler failed and the job's error policy dropped it.
 * - `skipped`: overlap control found the job already running; nothing ran.
 * - `released`: the job goes back to its queue without spending an attempt
 *   (shutdown, a rate limit, or a worker that does not know the job).
 * - `failed`: the attempt failed; `retryable` says whether another may follow.
 */

/** A value-free description of a failure: no payload and, by default, no message. */
export interface JobErrorSummary {
  /** Stable snake_case code, when the error carried one. */
  readonly code?: string;
  /** The error-kernel kind that decides retryability. */
  readonly kind: string;
  /** The error's class name. */
  readonly name: string;
  /** The stack with messages stripped unless the app opted into storing them. */
  readonly stack?: string;
}

export type AttemptOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'discarded'; readonly error: JobErrorSummary }
  | { readonly kind: 'skipped'; readonly reason: 'overlap' }
  | {
      readonly kind: 'released';
      readonly reason: 'shutdown' | 'rate_limited' | 'unknown_job';
      readonly delayMs?: number;
    }
  | { readonly kind: 'failed'; readonly error: JobErrorSummary; readonly retryable: boolean };
