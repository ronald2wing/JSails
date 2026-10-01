/**
 * The boundary table: what each error kind means at each boundary (HTTP
 * status, CLI exit code, whether a job retries, the log level), and the one
 * function that reads it for a thrown value.
 *
 * Audience decides which column applies. A client-audience error answers its
 * kind's status; an operator-audience error answers 500, or 503/504 for
 * `unavailable`/`timeout` (and 503 for a rate limit an upstream imposed on the
 * framework), because a caller learns nothing from an internal failure's kind
 * but may retry an unavailable or timed-out one. `aborted` is a
 * non-error outcome in both: the caller is gone, so nothing is logged and the
 * 499 status only reaches access logs.
 *
 * Exit codes: 1 for a failure, 75 (`EX_TEMPFAIL`) for one a script may retry
 * (`rate_limited`, `unavailable`, `timeout`), 130 for an aborted command (the
 * shell's code for an interrupt). Usage errors keep their own code, 2, and do
 * not pass through here.
 */

import type { JsailsError } from './jsails-error.js';
import { isErrorKind, isRetryableKind, type ErrorKind } from './kinds.js';
import { normalizeError } from './normalize.js';

/**
 * A log level, or `none` for an outcome that is not logged.
 *
 * @public
 */
export type BoundaryLogLevel = 'none' | 'debug' | 'info' | 'warn' | 'error';

/**
 * One kind's row.
 *
 * @public
 */
export interface BoundaryRow {
  /** HTTP status of a client-audience error. */
  readonly status: number;
  /** HTTP status of an operator-audience error. */
  readonly operatorStatus: number;
  /** CLI exit code, whatever the audience: the CLI's reader is the operator. */
  readonly exitCode: number;
  /** True when a job that failed this way is retried. */
  readonly retryable: boolean;
  /** Log level of a client-audience error. */
  readonly logLevel: BoundaryLogLevel;
  /** Log level of an operator-audience error. */
  readonly operatorLogLevel: BoundaryLogLevel;
}

/** One row; the retry column is {@link isRetryableKind}, its one source of truth. */
function row(
  kind: ErrorKind,
  status: number,
  operatorStatus: number,
  exitCode: number,
  logLevel: BoundaryLogLevel,
  operatorLogLevel: BoundaryLogLevel,
): BoundaryRow {
  return Object.freeze({
    status,
    operatorStatus,
    exitCode,
    retryable: isRetryableKind(kind),
    logLevel,
    operatorLogLevel,
  });
}

/**
 * Every kind's row. The retry column is read from `isRetryableKind`
 * (`jsails/errors`), so a job runtime that loads only the error kernel
 * retries exactly what this table says.
 *
 * @public
 */
export const BOUNDARY_TABLE: Readonly<Record<ErrorKind, BoundaryRow>> = Object.freeze({
  invalid: row('invalid', 422, 500, 1, 'info', 'error'),
  unauthenticated: row('unauthenticated', 401, 500, 1, 'info', 'error'),
  forbidden: row('forbidden', 403, 500, 1, 'info', 'error'),
  not_found: row('not_found', 404, 500, 1, 'debug', 'error'),
  conflict: row('conflict', 409, 500, 1, 'info', 'error'),
  too_large: row('too_large', 413, 500, 1, 'info', 'error'),
  rate_limited: row('rate_limited', 429, 503, 75, 'info', 'warn'),
  unavailable: row('unavailable', 503, 503, 75, 'warn', 'warn'),
  timeout: row('timeout', 504, 504, 75, 'warn', 'warn'),
  aborted: row('aborted', 499, 499, 130, 'none', 'none'),
  internal: row('internal', 500, 500, 1, 'error', 'error'),
});

/**
 * What a boundary does with one thrown value.
 *
 * @public
 */
export interface BoundaryOutcome {
  /** The normalized error. */
  readonly error: JsailsError;
  /** True when the error is client-audience: its message, code and exposed fields may leave. */
  readonly exposed: boolean;
  readonly status: number;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly logLevel: BoundaryLogLevel;
}

/**
 * Normalize `thrown` and read its row in the column its audience selects.
 *
 * @public
 */
export function boundaryOutcome(thrown: unknown): BoundaryOutcome {
  const error = normalizeError(thrown);
  // An error from another copy of jsails may carry a kind this copy lacks.
  const entry = BOUNDARY_TABLE[isErrorKind(error.kind) ? error.kind : 'internal'];
  const exposed = error.audience === 'client';
  return Object.freeze({
    error,
    exposed,
    status: exposed ? entry.status : entry.operatorStatus,
    exitCode: entry.exitCode,
    retryable: entry.retryable,
    logLevel: exposed ? entry.logLevel : entry.operatorLogLevel,
  });
}
