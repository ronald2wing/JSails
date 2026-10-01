/**
 * The problem document itself: RFC 9457 `application/problem+json` with the
 * framework's extension members, built in one place for every error answer
 * (the kernel's `toProblem`, the HTTP server's failures, `jsonError`), so a
 * status always has the same `title` and the members always the same order.
 */

/**
 * The media type of a problem document.
 *
 * @public
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * An RFC 9457 problem document with the framework's extension members.
 *
 * @public
 */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly traceId?: string;
  readonly [member: string]: unknown;
}

/** RFC 9110 reason phrases of the statuses the framework answers with. */
const TITLES: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  499: 'Client Closed Request',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
});

/**
 * The title of a problem with `status`: its RFC 9110 reason phrase, or a
 * class-level one for a status without a listed phrase.
 */
export function statusTitle(status: number): string {
  return TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Error');
}

/**
 * What a problem document is built from: a status, and for a failure the
 * caller may read, its code, message and extension members.
 */
export interface ProblemFields {
  readonly status: number;
  readonly code?: string | undefined;
  readonly detail?: string | undefined;
  readonly members?: Readonly<Record<string, unknown>>;
}

/**
 * The problem document for `fields`, with the request's trace id when known.
 * Extension members never displace the standard ones.
 */
export function problemDocument(fields: ProblemFields, traceId?: string): ProblemDocument {
  return Object.freeze({
    ...fields.members,
    type: 'about:blank',
    title: statusTitle(fields.status),
    status: fields.status,
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
    ...(fields.code === undefined ? {} : { code: fields.code }),
    ...(traceId === undefined ? {} : { traceId }),
  });
}

/**
 * `Retry-After` seconds from a rate-limit payload's `retryAfterMs`, or
 * `undefined` when it carries none.
 */
export function retryAfterSeconds(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const ms = (payload as { readonly retryAfterMs?: unknown }).retryAfterMs;
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) return undefined;
  return String(Math.ceil(ms / 1000));
}
