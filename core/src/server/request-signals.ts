/**
 * Request-lifecycle signal middleware shared by API and page routes.
 *
 * Emits `requestStarted` before the chain runs and `requestFinished` (or
 * `requestFailed` on a throw) after it settles, reading the final status from
 * `c.res.status` so a short-circuit from authorize/CSRF is still observed.
 * When no signal bus is wired in, this is a transparent pass-through (zero
 * overhead beyond one `await next()`).
 *
 * Both route kinds share this so a plugin observing `requestFailed` sees page
 * render failures and API handler failures through one mechanism.
 */

import {
  signalsToken,
  requestFailed,
  requestFinished,
  requestStarted,
  type SignalBus,
} from '../signals/index.js';
import type { ResolvedOptions } from './request-pipeline.js';
import type { AppMiddlewareHandler } from './env.js';

/**
 * Build the outermost request-lifecycle middleware for `method`.
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
    if (signals === undefined) return next();
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const started = Date.now();
    const base = {
      request,
      url,
      params: { ...c.req.param() },
      session: c.var.session,
      method,
      route: url.pathname,
    };
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
