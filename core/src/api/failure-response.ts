/**
 * A failure as it reaches the client, and its problem+json response.
 *
 * A {@link Failure} is what a client may learn of a failure; the mapper from
 * a thrown value is `toFailure` (`error-response.ts`). This half has no part
 * in that mapping, so a handler's own `jsonError` loads only the document
 * builder and the recorded body, not the error kernel's boundary table.
 */

import { PROBLEM_CONTENT_TYPE, problemDocument } from '../errors/problem-document.server.js';
import { bytesResponse, emptyResponse, utf8 } from './response-bodies.js';

/**
 * What a client may learn of a failure: its status, the code and message it
 * may read (both absent for an operator failure), extension members, the
 * headers its answer carries (`Allow`, `WWW-Authenticate`, `Retry-After`), and
 * whether the failure is a fault to report (500 and above).
 */
export interface Failure {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string | undefined;
  readonly members: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly report: boolean;
}

/** `fields` as a frozen failure, reported when its status is 500 or above. */
export function failure(fields: Omit<Failure, 'report'>): Failure {
  return Object.freeze({ ...fields, report: fields.status >= 500 });
}

/**
 * `failure` as a problem+json response carrying its headers. An aborted
 * request (499) has no reader, so it has no body.
 */
export function failureResponse(failure: Failure, traceId?: string): Response {
  if (failure.status === 499) {
    return emptyResponse({ status: failure.status, headers: failure.headers });
  }
  const document = problemDocument(
    {
      status: failure.status,
      code: failure.code,
      detail: failure.message,
      members: failure.members,
    },
    traceId,
  );
  return bytesResponse(utf8(JSON.stringify(document)), {
    status: failure.status,
    headers: { ...failure.headers, 'content-type': PROBLEM_CONTENT_TYPE },
  });
}

/**
 * A problem+json response for a deliberate answer: `message` becomes
 * `detail`, `code` the `code` member, and `extra` further members. Pass only
 * value-free text: the body reaches the caller verbatim.
 *
 * @public
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return failureResponse(failure({ status, code, message, members: extra, headers }));
}
