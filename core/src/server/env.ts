/**
 * Hono environment types for the JSails HTTP pipeline.
 *
 * The one per-request variable is the {@link RequestFrame} the first stage
 * creates (`c.var.frame`): the request id, origin, client, and what the
 * route's claim resolved. A handler or middleware reads the route's
 * `RequestContext` from `c.var.frame.requestContext()`, so Hono's
 * `Context` never leaks into the authoring surface beyond that one field.
 *
 * This module has zero runtime deps — only `import type` from Hono and the
 * frame — so `routing/middleware.ts` can import from it with no cycle risk.
 */

import type { Context, MiddlewareHandler } from 'hono';

import type { RequestFrame } from './request-frame.js';

/**
 * The per-request values on `c.var`: the request frame only.
 *
 * @public
 */
export interface HttpVariables {
  /** The request's frame, set by the first pipeline stage before any other runs. */
  readonly frame: RequestFrame;
}

/** Hono env for the JSails pipeline. */
export type AppEnv = { Variables: HttpVariables };

/** Hono `Context` typed for the JSails pipeline. */
export type AppContext = Context<AppEnv>;

/** Hono `MiddlewareHandler` typed for the JSails pipeline. */
export type AppMiddlewareHandler = MiddlewareHandler<AppEnv>;
