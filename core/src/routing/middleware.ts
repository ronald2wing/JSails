/**
 * The middleware contract of pages, API routes and registrar routes.
 *
 * A middleware is a function of the route's {@link RequestContext} and a
 * `next` continuation that runs the rest of the chain and resolves to its
 * `Response`. It answers by returning a `Response`: its own (a short-circuit,
 * without calling `next`) or the one `next` produced, possibly replaced with
 * `Respond.withHeaders`/`Respond.withCookies`. There is no context to stage
 * headers on before `next()`: what a middleware adds to the answer, it adds
 * to the answer it returns. `next` runs at most once; a second call throws.
 *
 * It runs inside the route boundary after the claim, the origin check and the
 * access gate, so it never sees a request the route's access denied. A
 * middleware belongs to one route: a page's or API module's `middleware`
 * export, `defineApi`'s `middleware`, or a registrar route's. There is no
 * app-wide chain: a wall in front of every route is a guard (`http.guards`,
 * `routes.guard`) and a rewrite of every answer a response transform
 * (`routes.transform`).
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { RequestContext } from '../contracts/http.js';

/**
 * A route middleware: answer with a `Response`, either your own or the one
 * `next()` resolves to.
 *
 * @public
 */
export type RouteMiddleware = (
  context: RequestContext,
  next: () => Promise<Response>,
) => Awaitable<Response>;

/**
 * Validate a module's `middleware` export structurally. `undefined` means no
 * middleware; anything else must be an array of functions
 * ({@link RouteMiddleware}). Violations are reported through `describe`,
 * which the caller uses to attach route/module context — the value itself is
 * never echoed, so the resulting error is value-free.
 *
 * @public
 */
export function validateMiddlewareList(
  value: unknown,
  describe: (message: string) => Error,
): readonly RouteMiddleware[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw describe('exports "middleware" as a non-array value');
  }
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as unknown;
    if (typeof entry !== 'function') {
      throw describe(`exports a non-function middleware entry at index ${index}`);
    }
  }
  return value as readonly RouteMiddleware[];
}
