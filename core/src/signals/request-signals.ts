/**
 * Request lifecycle signal payload and event tokens.
 *
 * These events are emitted by the built-in API pipeline at well-defined
 * boundaries — before the access chain, after the handler returns, and
 * on handler/middleware throw — so a plugin can observe every request through
 * the shared signal bus without touching the Hono pipeline.
 *
 * Payloads are deliberately value-free: no request body, no headers, no
 * cookies. The `session` field carries the resolved session object (may be
 * null); it is server-only and must never reach the browser boundary.
 */

import { defineEvent, type EventToken } from '../extensions/interceptors.js';

/** Snapshot of a request at the point a lifecycle signal fires. */
export interface RequestSignalPayload {
  /** The native {@link Request} (body is never read or buffered). */
  readonly request: Request;
  /**
   * Parsed URL, including the concrete path; query parameters are available
   * but never parsed by the signal. The same object the handler's
   * `RequestContext.url` holds, so treat it as read-only.
   */
  readonly url: URL;
  /** Route parameters (e.g. `{ id: '42' }`). */
  readonly params: Readonly<Record<string, string>>;
  /** Resolved session object (null when no session resolver is configured). */
  readonly session: unknown;
  /** HTTP method (e.g. `'GET'`, `'POST'`). */
  readonly method: string;
  /**
   * The route pattern that matched (`/users/:id`, `/fr/docs/*`), never the
   * concrete path, so grouping or exporting by route does not record
   * path-embedded identifiers. `*` when no route pattern applies.
   */
  readonly route: string;
  /**
   * The request's `X-Request-Id` (the same value `currentContext()?.requestId` returns
   * on the request path). Absent only when the signal is emitted outside a
   * `createApp` request.
   */
  readonly requestId?: string;
  /** Response status (present only on `requestFinished`). */
  readonly status?: number;
  /** Wall-clock duration in milliseconds from `requestStarted` to this event. */
  readonly durationMs?: number;
  /** The thrown error (present only on `requestFailed`; never echoes its message). */
  readonly error?: unknown;
}

/** Emitted once per API request, after session resolution and before the access chain. */
export const requestStarted: EventToken<RequestSignalPayload> =
  defineEvent<RequestSignalPayload>('request.started');

/** Emitted when the handler (or any intermediate gate) returns a Response successfully. */
export const requestFinished: EventToken<RequestSignalPayload> =
  defineEvent<RequestSignalPayload>('request.finished');

/** Emitted when the handler or middleware throws, before re-throwing to the 500 envelope. */
export const requestFailed: EventToken<RequestSignalPayload> =
  defineEvent<RequestSignalPayload>('request.failed');
