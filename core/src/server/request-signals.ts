/**
 * The request-lifecycle signals of filesystem routes.
 *
 * The route boundary of a page or API route (`route-boundary.ts`) runs the
 * route between these signals once the claim settled, inside its bindings:
 * `requestStarted` before the access gate, `requestFinished` (or
 * `requestFailed` on a throw) after the answer settles, so a denial from the
 * gate is still observed with its status. A failure after the response head
 * was sent reaches observers through the frame's `report` instead.
 *
 * Both route kinds share this so a plugin observing `requestFailed` sees page
 * render failures and API handler failures through one mechanism.
 *
 * Every payload carries the matched route pattern as `route` (the concrete
 * path stays in `url`) and the request id, so an observer can group by route
 * without recording path-embedded identifiers and can match an entry to the
 * `X-Request-Id` a user reports.
 */

import type { ServiceRegistry } from '../extensions/services.js';
import {
  signalsToken,
  requestFailed,
  requestFinished,
  requestStarted,
  type RequestSignalPayload,
  type SignalBus,
} from '../signals/index.js';
import type { RequestFrame } from './request-frame.js';

/**
 * The fields every request signal shares, read from the frame's request
 * context so the signals and the handler read one URL and one params object.
 * Call it after the claim settled.
 */
export function requestSignalBase(frame: RequestFrame, method: string): RequestSignalPayload {
  const context = frame.requestContext();
  return {
    request: context.request,
    url: context.url,
    params: context.params,
    session: context.session,
    method,
    route: frame.route?.meta.pattern ?? '*',
    requestId: frame.id,
  };
}

/**
 * Run the rest of a route (`run`) between its lifecycle signals:
 * `requestStarted` first, then `requestFinished` with the status of the
 * answer it resolved to (a denial from the access gate included), or
 * `requestFailed` with the error it threw, which is thrown on to the
 * boundary's failure path.
 */
export async function withRequestSignals(
  frame: RequestFrame,
  signals: SignalBus | undefined,
  method: string,
  run: () => Promise<Response>,
): Promise<Response> {
  if (signals === undefined) return run();
  const started = Date.now();
  const base = requestSignalBase(frame, method);
  await signals.emit(requestStarted, base);
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    await signals.emit(requestFailed, { ...base, error, durationMs: Date.now() - started });
    throw error;
  }
  await signals.emit(requestFinished, {
    ...base,
    status: response.status,
    durationMs: Date.now() - started,
  });
  return response;
}

/** Resolve the signal bus from the service registry, failing closed to undefined. */
export function resolveSignalBus(services: ServiceRegistry | undefined): SignalBus | undefined {
  if (services === undefined) return undefined;
  const maybeSignals = services.tryGet(signalsToken);
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
