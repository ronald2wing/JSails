/**
 * Route-entry middleware shared by API and page routes: lazy session
 * resolution plus the request-lifecycle signals.
 *
 * It is the outermost handler of every filesystem route chain, so it is where
 * the lazily resolved session (see `loadSession` in `env.ts`) is settled: once
 * here, before CSRF, authorize, middleware, and the handler read
 * `c.var.session`, and never for a request no route claims.
 *
 * Emits `requestStarted` before the chain runs and `requestFinished` (or
 * `requestFailed` on a throw) after it settles, reading the final status from
 * `c.res.status` so a short-circuit from authorize/CSRF is still observed.
 * When no signal bus is wired in, it only settles the session.
 *
 * Both route kinds share this so a plugin observing `requestFailed` sees page
 * render failures and API handler failures through one mechanism.
 *
 * Every payload carries the matched route pattern as `route` (the concrete
 * path stays in `url`) and the ambient request id, so an observer can group by
 * route without recording path-embedded identifiers and can match an entry to
 * the `X-Request-Id` a user reports.
 */

import {
  signalsToken,
  requestFailed,
  requestFinished,
  requestStarted,
  type RequestSignalPayload,
  type SignalBus,
} from '../signals/index.js';
import {
  createRequestContextFromStore,
  ensureRequestSession,
  matchedRoutePattern,
  type ResolvedOptions,
} from './request-pipeline.js';
import { currentRequestId } from './request-scope.js';
import type { AppContext, AppMiddlewareHandler } from './env.js';

/**
 * The fields every request signal shares, built from the request's cached
 * {@link RequestContext} so the signals and the handler read one URL and one
 * params object. Call it after the session is settled.
 */
export function requestSignalBase(c: AppContext, method: string): RequestSignalPayload {
  const context = createRequestContextFromStore(c, c.var);
  const requestId = currentRequestId();
  return {
    request: context.request,
    url: context.url,
    params: context.params,
    session: context.session,
    method,
    route: matchedRoutePattern(c),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * Build the outermost route-entry middleware for `method`.
 *
 * `c.error` distinguishes the two outcomes rather than the status: Hono's
 * `onError` converts a throwing handler into a 500 Response and records the
 * error on `c.error`, so `next()` itself resolves. A handler that returned a
 * non-2xx without throwing is `requestFinished`; a thrown error is
 * `requestFailed`.
 */
export function createSignalsMiddleware(
  signals: SignalBus | undefined,
  method: string,
): AppMiddlewareHandler {
  return async (c, next) => {
    await ensureRequestSession(c);
    if (signals === undefined) return next();
    const started = Date.now();
    const base = requestSignalBase(c, method);
    await signals.emit(requestStarted, base);
    try {
      await next();
      if (c.error !== undefined) {
        await signals.emit(requestFailed, {
          ...base,
          error: c.error,
          durationMs: Date.now() - started,
        });
      } else {
        await signals.emit(requestFinished, {
          ...base,
          status: c.res.status,
          durationMs: Date.now() - started,
        });
      }
    } catch (error) {
      await signals.emit(requestFailed, {
        ...base,
        error,
        durationMs: Date.now() - started,
      });
      throw error;
    }
  };
}

/** Resolve the signal bus from the service registry, failing closed to undefined. */
export function resolveSignalBus(opts: ResolvedOptions): SignalBus | undefined {
  if (opts.services === undefined) return undefined;
  const maybeSignals = opts.services.tryGet(signalsToken);
  if (
    maybeSignals !== undefined &&
    typeof maybeSignals === 'object' &&
    maybeSignals !== null &&
    typeof (maybeSignals as unknown as { emit?: unknown }).emit === 'function'
  ) {
    return maybeSignals;
  }
  return undefined;
}
