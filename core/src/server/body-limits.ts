/**
 * Per-route request-body limits.
 *
 * `createApp` caps every request body at `maxBodyBytes` (1 MiB by default).
 * A route that legitimately takes more (an upload form) or should take less
 * declares its own cap with {@link routeBodyLimit}, a pass-through middleware
 * registered ahead of the handler; a filesystem API module does the same with
 * a `maxBodyBytes` export. The global body-limit stage runs before any route
 * handler, but Hono has already matched every route for the request by then,
 * so it reads the declarations of the matched routes and enforces that cap
 * instead of the global one.
 *
 * Bounds: a declaration is a positive integer no larger than
 * {@link MAX_ROUTE_BODY_BYTES}, validated when it is declared, so a typo
 * cannot lift the cap without limit. When several matched routes declare a
 * cap (a prefix middleware and the route itself), the smallest one applies:
 * any layer may tighten the cap, none may silently loosen another's.
 *
 * Unframed bodies: the stage runs before session resolution, CSRF, and
 * `authorize`, so anything it accepts is accepted from anonymous clients. A
 * body with a valid `Content-Length` costs nothing here (the header is
 * checked against the cap and the bytes stay in the socket), but a chunked
 * body has to be read to be measured, and Hono's limiter buffers it in
 * memory. A route's raised cap therefore applies only to a body that declares
 * its length; a chunked body is held to the app-wide default, so an anonymous
 * client cannot make each connection pin up to {@link MAX_ROUTE_BODY_BYTES}.
 */

import type { Context, Env, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { matchedRoutes } from 'hono/route';

import { JsailsError } from '../errors/jsails-error.js';
import type { AppContext, AppMiddlewareHandler } from './env.js';

/** The largest body cap a route may declare: 100 MiB. */
export const MAX_ROUTE_BODY_BYTES: number = 100 * 1024 * 1024;

/** Stable code carried by a {@link BodyLimitError}. */
export type BodyLimitErrorCode = 'invalid_body_limit';

/** Raised for a malformed body-limit declaration. Value-free: never echoes the value. */
export class BodyLimitError extends JsailsError {
  readonly code: BodyLimitErrorCode = 'invalid_body_limit';
}

/** The cap each declaration marker stands for, keyed by the marker itself. */
const declaredLimits = new WeakMap<object, number>();

/**
 * Validate a body cap: a positive integer no larger than
 * {@link MAX_ROUTE_BODY_BYTES}. `label` names the declaration in the error.
 */
export function validateBodyLimit(value: unknown, label = 'maxBodyBytes'): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_ROUTE_BODY_BYTES
  ) {
    throw new BodyLimitError(
      `${label} must be a positive integer of at most ${MAX_ROUTE_BODY_BYTES} bytes`,
    );
  }
  return value;
}

/**
 * A pass-through middleware that declares the request-body cap for the routes
 * it is registered on, in place of the app-wide `maxBodyBytes`:
 *
 * ```ts
 * app.post('/admin/media', routeBodyLimit(6 * 1024 * 1024), handler);
 * ```
 *
 * Register it on the app passed to an HTTP hook, not on a sub-app mounted with
 * `app.route()`, whose handlers Hono wraps.
 */
export function routeBodyLimit<E extends Env = Env>(maxBodyBytes: number): MiddlewareHandler<E> {
  const limit = validateBodyLimit(maxBodyBytes);
  const marker: MiddlewareHandler<E> = (_c, next) => next();
  declaredLimits.set(marker, limit);
  return marker;
}

/**
 * The smallest cap declared by a route matched for this request, or
 * `undefined` when none declares one.
 */
export function declaredBodyLimit(c: Context): number | undefined {
  let limit: number | undefined;
  for (const route of matchedRoutes(c)) {
    const declared = declaredLimits.get(route.handler);
    if (declared !== undefined && (limit === undefined || declared < limit)) limit = declared;
  }
  return limit;
}

/** Options for {@link createBodyLimitMiddleware}. */
export interface BodyLimitMiddlewareOptions {
  /** The app-wide cap used when no matched route declares one. */
  readonly defaultMaxBytes: number;
  /** The response for a body over the cap. */
  readonly onError: (c: AppContext) => Response | Promise<Response>;
  /** Requests that bypass the stage entirely (bounded elsewhere). */
  readonly skip?: (c: AppContext) => boolean;
}

/**
 * The global body-limit stage: enforce the matched routes' declared cap, or
 * the app-wide default. One Hono `bodyLimit` instance exists per distinct cap,
 * and caps only come from registered declarations, so the set stays small.
 */
export function createBodyLimitMiddleware(
  options: BodyLimitMiddlewareOptions,
): AppMiddlewareHandler {
  const limiters = new Map<number, MiddlewareHandler>();
  const limiterFor = (maxSize: number): MiddlewareHandler => {
    let limiter = limiters.get(maxSize);
    if (limiter === undefined) {
      limiter = bodyLimit({ maxSize, onError: options.onError });
      limiters.set(maxSize, limiter);
    }
    return limiter;
  };
  return (c, next) => {
    if (options.skip?.(c) === true) return next();
    const declared = declaredBodyLimit(c) ?? options.defaultMaxBytes;
    const cap = hasDeclaredLength(c.req.raw.headers)
      ? declared
      : Math.min(declared, options.defaultMaxBytes);
    return limiterFor(cap)(c, next);
  };
}

/**
 * Whether the body's length is fixed by `Content-Length` alone. With
 * `Transfer-Encoding` present the length header is ignored (the HTTP parser
 * frames by chunks), which is also how Hono's limiter decides to buffer.
 */
function hasDeclaredLength(headers: Headers): boolean {
  return headers.has('content-length') && !headers.has('transfer-encoding');
}
