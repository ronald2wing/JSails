/**
 * The sink for unexpected request failures.
 *
 * A response never carries error details (the envelope and error pages stay
 * value-free), so without a sink an unhandled throw in a route, a session
 * resolver, or an authorize callback would leave nothing behind but a status
 * code. `createApp` therefore reports every unexpected failure to one
 * {@link RequestErrorHook}: the app's `onError` option when given, otherwise
 * {@link logRequestError}, which writes one line plus the stack to stderr.
 *
 * Expected failures are not reported: an `HttpError` below 500 and a
 * `ValidationError` are answers, not faults. The report carries the route
 * PATTERN, never the raw URL, because a path segment or query string can hold a
 * token. A hook that throws is itself reported to stderr without its error
 * text, so a broken hook never turns a handled 500 into a crash.
 */

import { HttpError } from '../contracts/http.js';
import type { Awaitable } from '../contracts/awaitable.js';
import { ValidationError } from '../api/validation.js';

/** The pipeline stage an unexpected failure came from. */
export type RequestErrorPhase = 'handler' | 'session' | 'authorize' | 'component';

/** Request facts handed to a {@link RequestErrorHook}; never the raw URL or body. */
export interface RequestErrorInfo {
  readonly phase: RequestErrorPhase;
  readonly method: string;
  /** The matched route pattern (e.g. `/api/posts/:id`), or `*` when none matched. */
  readonly route: string;
  /** The request's `X-Request-Id`, when one was assigned. */
  readonly requestId: string | undefined;
}

/**
 * Receives every unexpected request failure. It runs after the sanitized
 * response is chosen and cannot change it.
 */
export type RequestErrorHook = (error: unknown, info: RequestErrorInfo) => Awaitable<void>;

/** Reports one failure; resolves after the hook settles and never rejects. */
export type RequestErrorReporter = (error: unknown, info: RequestErrorInfo) => Promise<void>;

/**
 * True for a failure the framework answers on purpose (`HttpError` below 500,
 * `ValidationError`); those are never reported.
 */
export function isExpectedRequestError(error: unknown): boolean {
  if (error instanceof ValidationError) return true;
  return error instanceof HttpError && error.status < 500;
}

/** The default hook: one stderr line with the request facts, then the stack. */
export function logRequestError(error: unknown, info: RequestErrorInfo): void {
  const id = info.requestId === undefined ? '' : ` request_id=${info.requestId}`;
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : '';
  const kind = error instanceof Error ? '' : ` (non-Error ${typeof error} thrown)`;
  console.error(
    `[jsails] ${info.phase} failed: ${info.method} ${info.route}${id}${kind}${detail === '' ? '' : `\n${detail}`}`,
  );
}

/** Build the reporter that `createApp` hands to every pipeline stage. */
export function createRequestErrorReporter(
  hook: RequestErrorHook | undefined,
): RequestErrorReporter {
  const sink = hook ?? logRequestError;
  return async (error, info) => {
    if (isExpectedRequestError(error)) return;
    try {
      await sink(error, info);
    } catch {
      console.error(`[jsails] the onError hook threw while reporting a ${info.phase} failure`);
    }
  };
}
