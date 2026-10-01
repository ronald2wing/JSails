/**
 * The wire envelope for a failure: RFC 9457 `application/problem+json`.
 *
 * A client-audience error's document carries its kind's status and title, its
 * message as `detail`, and the extension members `code`, its exposed payload
 * members (`issues` for `request.invalid`, `reason` for `request.conflict`) and
 * `traceId`. An operator-audience error's document carries the status and its
 * generic title and `traceId` only: no message, no code, no context, so nothing
 * an operator error knows reaches the caller. `type` is `about:blank`, so
 * `title` is the status's own phrase.
 *
 * An aborted request has no reader, so it answers 499 with no body.
 */

import { boundaryOutcome } from './boundary-table.server.js';
import {
  PROBLEM_CONTENT_TYPE,
  problemDocument,
  retryAfterSeconds,
  type ProblemDocument,
} from './problem-document.server.js';

export { PROBLEM_CONTENT_TYPE, type ProblemDocument } from './problem-document.server.js';

/**
 * A failure ready to be written: status, headers, and the document (none for 499).
 *
 * @public
 */
export interface Problem {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ProblemDocument | undefined;
}

/**
 * Options for {@link toProblem}.
 *
 * @public
 */
export interface ProblemOptions {
  /** The request's trace id, echoed as the `traceId` member. */
  readonly traceId?: string;
}

/**
 * Encode any thrown value as a problem.
 *
 * @public
 */
export function toProblem(thrown: unknown, options?: ProblemOptions): Problem {
  const { error, exposed, status } = boundaryOutcome(thrown);
  if (error.kind === 'aborted') return Object.freeze({ status, headers: {}, body: undefined });

  const headers: Record<string, string> = { 'content-type': PROBLEM_CONTENT_TYPE };
  if (!exposed) {
    return Object.freeze({
      status,
      headers: Object.freeze(headers),
      body: problemDocument({ status }, options?.traceId),
    });
  }
  if (error.kind === 'rate_limited') {
    const seconds = retryAfterSeconds(error.payload);
    if (seconds !== undefined) headers['retry-after'] = seconds;
  }
  const body = problemDocument(
    { status, code: error.code, detail: error.message, members: error.clientFields },
    options?.traceId,
  );
  return Object.freeze({ status, headers: Object.freeze(headers), body });
}

/**
 * {@link toProblem} as a web `Response`.
 *
 * @public
 */
export function problemResponse(thrown: unknown, options?: ProblemOptions): Response {
  const { status, headers, body } = toProblem(thrown, options);
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}
