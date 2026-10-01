/**
 * When a failed attempt is the job's last: one rule shared by the processor
 * (which fires a chain's catch only on a final failure) and every adapter
 * (which decides whether a failure is retried or kept), so the two can never
 * disagree about the same attempt.
 */

/**
 * Whether a failed attempt of a job that had `attemptsMade` failed attempts
 * before it is the last: it is not retryable, or no attempt is left of
 * `attempts` (the envelope's option; absent means one).
 */
export function isFinalFailure(
  attemptsMade: number,
  attempts: number | undefined,
  retryable: boolean,
): boolean {
  return !retryable || attemptsMade + 1 >= (attempts ?? 1);
}
