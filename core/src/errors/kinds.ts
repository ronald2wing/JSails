/**
 * The closed vocabulary every framework error is classified by: its kind (what
 * went wrong) and its audience (who may read it).
 *
 * Kind and audience are independent. A kind says how a boundary should treat
 * the failure (status, exit code, retry); the audience says whether the
 * failure's message and code may leave the process. A `not_found` raised while
 * the framework resolves its own service is an operator error and answers 500,
 * while `notFound()` thrown by a page for a missing record is a client error
 * and answers 404.
 *
 * Browser-safe: no runtime imports.
 */

/**
 * Every error kind, in the order the boundary table lists them.
 *
 * @public
 */
export const ERROR_KINDS: readonly [
  'invalid',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'too_large',
  'rate_limited',
  'unavailable',
  'timeout',
  'aborted',
  'internal',
] = Object.freeze([
  'invalid',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'too_large',
  'rate_limited',
  'unavailable',
  'timeout',
  'aborted',
  'internal',
] as const);

/**
 * What went wrong, as a boundary needs to know it:
 *
 * - `invalid`: the input does not satisfy the contract (a failed parse).
 * - `unauthenticated`: no or an unusable identity.
 * - `forbidden`: the identity may not do this.
 * - `not_found`: the addressed thing does not exist.
 * - `conflict`: the thing exists but its state refuses the change.
 * - `too_large`: the input exceeds a size limit.
 * - `rate_limited`: the caller exceeded a rate limit.
 * - `unavailable`: a dependency is down; retrying later may succeed.
 * - `timeout`: the work exceeded its time budget.
 * - `aborted`: the caller went away (a client disconnect, a cancelled command);
 *   a non-error outcome that boundaries do not log.
 * - `internal`: anything else, including every error no translator recognized.
 *
 * @public
 */
export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * Who may read an error. `client` errors are part of the public contract: their
 * kind's status, their message, their code and their exposed payload members
 * reach the caller. `operator` errors stay in the process: a caller sees only a
 * generic body, and the message and context go to the logs.
 *
 * @public
 */
export type ErrorAudience = 'client' | 'operator';

const KIND_SET: ReadonlySet<string> = new Set(ERROR_KINDS);

/**
 * True when `value` is one of {@link ERROR_KINDS}.
 *
 * @public
 */
export function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'rate_limited',
  'unavailable',
  'timeout',
  'aborted',
  'internal',
]);

/**
 * True when a job that failed with this kind is retried (within its attempt
 * limit): the retry column of the boundary table, readable without the
 * server half of the error kernel. `internal` is retried because an
 * unrecognized failure is as often transient (a dropped connection no
 * translator named) as it is a bug, and the attempt limit bounds a bug.
 *
 * @public
 */
export function isRetryableKind(kind: ErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}
