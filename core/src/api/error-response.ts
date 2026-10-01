/**
 * The HTTP projection of a failure, and its wire envelope: an RFC 9457
 * `application/problem+json` document,
 * `{ type, title, status, detail?, code?, traceId?, ...members }`.
 *
 * {@link toFailure} is the one mapper from a thrown value to what the client
 * may learn of it. It reads the error kernel (`normalizeError`, the boundary
 * table and its audience rule) for every framework error, and covers the
 * three shapes that predate the kernel: an `HttpError` (its own status, code,
 * message and headers, public by contract), a `ValidationError` (the kernel's
 * `request.invalid`, 422, with its issues), and a Hono `HTTPException` (its
 * response's status and headers, the framework's own body; recognized by
 * shape, so this module imports no Hono). A failure is reported only at 500
 * and above: everything below is an answer, not a fault.
 *
 * The document itself is the error kernel's (`problemDocument`,
 * `errors/problem-document.server.ts`): a failure the caller may read carries its
 * message as `detail`, its stable `code` and its extension members (`issues`
 * for invalid input); an operator failure is the status, the title and the
 * trace id only.
 *
 * {@link jsonError} builds the same document for a handler's own deliberate
 * answer (a 403 from an auth route, a 409 from a resource).
 *
 * Browser-safe: web-standard `Response` and the error kernel's leaves only,
 * so `jsails/api` stays bundleable.
 */

import { boundaryOutcome } from '../errors/boundary-table.server.js';
import { retryAfterSeconds } from '../errors/problem-document.server.js';
import { RequestErrors, type ErrorIssue } from '../errors/kernel.js';
import { HttpError } from '../contracts/http.js';
import { failure, type Failure } from './failure-response.js';
import { ValidationError } from './validation-error.js';

const NO_MEMBERS: Readonly<Record<string, unknown>> = Object.freeze({});
const NO_HEADERS: Readonly<Record<string, string>> = Object.freeze({});

/** Headers of a foreign error response that describe its own body, not the failure. */
const BODY_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-range',
  'etag',
  'last-modified',
]);

/**
 * The failure a thrown value stands for. Never throws, and never puts text
 * the value carries on the wire unless its class makes that text public.
 */
export function toFailure(error: unknown): Failure {
  if (error instanceof ValidationError) {
    // The kernel's own `request.invalid`, so a resource's and a schema's
    // invalid input read the same on the wire.
    const invalid = new RequestErrors.Error('invalid', {}, { payload: { issues: [] } });
    return failure({
      status: 422,
      code: invalid.code,
      message: invalid.message,
      members: { issues: error.issues.map(copyIssue) },
      headers: NO_HEADERS,
    });
  }
  if (error instanceof HttpError) {
    return failure({
      status: error.status,
      code: error.code,
      message: error.message,
      members: NO_MEMBERS,
      headers: error.headers,
    });
  }
  const foreign = foreignResponse(error);
  if (foreign !== undefined) {
    return failure({
      status: foreign.status,
      code: undefined,
      message: undefined,
      members: NO_MEMBERS,
      headers: failureHeaders(foreign.headers),
    });
  }
  const { error: normalized, exposed, status } = boundaryOutcome(error);
  if (!exposed) {
    return failure({
      status,
      code: undefined,
      message: undefined,
      members: NO_MEMBERS,
      headers: NO_HEADERS,
    });
  }
  const retryAfter =
    normalized.kind === 'rate_limited' ? retryAfterSeconds(normalized.payload) : undefined;
  return failure({
    status,
    code: normalized.code,
    message: normalized.message,
    members: normalized.clientFields,
    headers: retryAfter === undefined ? NO_HEADERS : { 'retry-after': retryAfter },
  });
}

function copyIssue(issue: ErrorIssue): ErrorIssue {
  return {
    path: [...issue.path],
    code: issue.code,
    ...(issue.message === undefined ? {} : { message: issue.message }),
  };
}

/**
 * The response a Hono `HTTPException` carries (`getResponse()`), recognized
 * by shape; `undefined` for anything else.
 */
function foreignResponse(error: unknown): Response | undefined {
  if (!(error instanceof Error)) return undefined;
  const getResponse = (error as { readonly getResponse?: unknown }).getResponse;
  if (typeof getResponse !== 'function') return undefined;
  const response: unknown = getResponse.call(error);
  if (!(response instanceof Response)) return undefined;
  return response.status >= 400 && response.status <= 599 ? response : undefined;
}

/** The headers of a foreign error response that belong to the failure (`WWW-Authenticate`). */
function failureHeaders(headers: Headers): Readonly<Record<string, string>> {
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!BODY_HEADERS.has(name)) kept[name] = value;
  }
  return Object.freeze(kept);
}
