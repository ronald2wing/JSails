/**
 * Filesystem API route registration.
 *
 * Imports each compiled API module eagerly and registers its named HTTP-method
 * exports. Each handler runs through a Hono middleware chain composed at
 * registration time. The pipeline ordering per route is:
 *
 *   signals -> CSRF -> global-authorize -> module-authorize -> global middleware
 *   -> per-route middleware -> handler adapter
 *
 * The pipeline is default-deny -- a request is allowed only when the global
 * authorize (and, when present, the module authorize) resolves to exactly true.
 * The request lifecycle signals wrap the WHOLE chain (outermost), so a 403
 * short-circuit from authorize or CSRF still emits `requestStarted` /
 * `requestFinished` with the short-circuit status -- they fire around the
 * pipeline, not only around the terminal handler.
 */

import type { ApiHandler, ApiMethod, Authorize } from '../contracts/http.js';
import { validateMiddlewareList, type RouteMiddlewareRef } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { resolveStringRefs } from './middleware-refs.js';
import { resolveRoutePaths } from './route-paths.js';
import { createSignalsMiddleware, resolveSignalBus } from './request-signals.js';
import {
  extractCacheControlDeclaration,
  wrapPublicResponse,
  type CacheControlDeclaration,
} from './cache-control.js';
import {
  createAuthorizeMiddleware,
  createCsrfMiddleware,
  createRequestContextFromStore,
  HTTP_METHODS,
  methodNotAllowedResponse,
  type ResolvedOptions,
} from './request-pipeline.js';
import type { AppContext, AppEnv, AppMiddlewareHandler } from './env.js';
import type { Hono } from 'hono';

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Import one API module and register each of its HTTP-method exports. */
export async function registerApiRoutes(
  app: App,
  entry: RouteManifestEntry,
  opts: ResolvedOptions,
  middlewareMap: Readonly<Record<string, AppMiddlewareHandler>> | undefined,
): Promise<void> {
  const mod = (await import(entry.file)) as Record<string, unknown>;
  const moduleAuthorize = extractAuthorize(entry, mod);
  const rawModuleMiddleware = extractMiddleware(entry, mod);

  // Every Hono path this route answers: the base/bare path(s) plus any
  // locale-prefixed aliases (`/fr/...`).
  const routePaths = resolveRoutePaths(entry, opts.localeOptions);

  const cacheControl = extractCacheControlDeclaration(entry.route, mod);

  // Resolve string middleware refs at registration time.
  const perRouteMiddleware = resolveStringRefs(rawModuleMiddleware, middlewareMap, (message) => {
    throw new Error(`API route "${entry.route}" ${message}`);
  });

  // Pre-build the CSRF and authorize middlewares -- identical for every method.
  const csrfMw = createCsrfMiddleware(opts.publicOrigin);
  const globalAuthMw = createAuthorizeMiddleware(opts.authorize);
  const moduleAuthMw =
    moduleAuthorize !== undefined ? createAuthorizeMiddleware(moduleAuthorize) : undefined;

  // The request lifecycle bus, resolved once per route (identity-based token).
  // The signals middleware wraps the whole chain so every outcome -- including
  // a deny from authorize/CSRF -- is observed.
  const signals = resolveSignalBus(opts);

  // Collect the method handlers.
  const handlers = new Map<ApiMethod, ApiHandler>();
  for (const method of HTTP_METHODS) {
    const exported = mod[method];
    if (exported === undefined) continue;
    if (typeof exported !== 'function') {
      throw new Error(`API route "${entry.route}" exports "${method}" as a non-function value`);
    }
    handlers.set(method, exported as ApiHandler);
  }

  const getHandler = handlers.get('GET');
  const headHandler = handlers.get('HEAD');
  if (getHandler !== undefined || headHandler !== undefined) {
    const chain = buildHandlerChain(
      createSignalsMiddleware(signals, 'GET'),
      csrfMw,
      globalAuthMw,
      moduleAuthMw,
      opts.globalMiddleware,
      perRouteMiddleware,
      (c) => {
        if (c.req.raw.method === 'HEAD') {
          const handler = headHandler ?? getHandler;
          if (handler !== undefined) {
            return invokeHandler(c, handler, cacheControl, 'HEAD');
          }
        }
        if (getHandler === undefined) {
          return methodNotAllowedResponse('HEAD');
        }
        return invokeHandler(c, getHandler, cacheControl, 'GET');
      },
    );
    // `chain` is always non-empty (signals + CSRF + authorize + terminal), so the
    // cast to a non-empty tuple satisfies Hono's positional-handler overload.
    // Optional catch-alls register two Hono paths sharing the same chain.
    for (const path of routePaths) {
      app.on('GET', path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
    }
  }

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const handler = handlers.get(method);
    if (handler === undefined) continue;
    const chain = buildHandlerChain(
      createSignalsMiddleware(signals, method),
      csrfMw,
      globalAuthMw,
      moduleAuthMw,
      opts.globalMiddleware,
      perRouteMiddleware,
      (c) => invokeHandler(c, handler, cacheControl, method),
    );
    for (const path of routePaths) {
      app.on(method, path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
    }
  }
}

/**
 * Build the complete middleware chain -- including the terminal handler adapter --
 * as a spreadable array of AppMiddlewareHandler values. `signalsMw` is outermost so
 * lifecycle signals observe the entire chain (short-circuits included).
 */
function buildHandlerChain(
  signalsMw: AppMiddlewareHandler,
  csrfMw: AppMiddlewareHandler,
  globalAuthMw: AppMiddlewareHandler,
  moduleAuthMw: AppMiddlewareHandler | undefined,
  globalMws: readonly AppMiddlewareHandler[],
  perRouteMws: readonly AppMiddlewareHandler[],
  terminal: (c: AppContext) => Response | Promise<Response>,
): AppMiddlewareHandler[] {
  const chain: AppMiddlewareHandler[] = [];
  chain.push(signalsMw);
  chain.push(csrfMw);
  chain.push(globalAuthMw);
  if (moduleAuthMw !== undefined) chain.push(moduleAuthMw);
  for (const mw of globalMws) chain.push(mw);
  for (const mw of perRouteMws) chain.push(mw);
  // Terminal handler, wrapped as middleware.
  chain.push(async (c, _next) => terminal(c));
  return chain;
}

/**
 * Invoke an API handler through the terminal adapter, wrapping cache-control only.
 * Signals are emitted by the outer {@link createSignalsMiddleware}; this adapter
 * builds the sovereign {@link RequestContext} and calls the handler verbatim.
 */
function invokeHandler(
  c: AppContext,
  handler: ApiHandler,
  cacheControl: CacheControlDeclaration | undefined,
  method: ApiMethod,
): Response | Promise<Response> {
  const context = createRequestContextFromStore(c, c.var);
  const response = handler(c.req.raw, context);
  const resolve = (result: Response): Response =>
    cacheControl !== undefined && (method === 'GET' || method === 'HEAD')
      ? wrapPublicResponse(result, cacheControl, method)
      : result;
  if (response instanceof Promise) {
    return response.then(resolve);
  }
  return resolve(response);
}

/** Validate and return a module's optional authorize export. */
function extractAuthorize(
  entry: RouteManifestEntry,
  mod: Record<string, unknown>,
): Authorize | undefined {
  const exported = mod['authorize'];
  if (exported === undefined) return undefined;
  if (typeof exported !== 'function') {
    throw new Error(`API route "${entry.route}" exports "authorize" as a non-function value`);
  }
  return exported as Authorize;
}

/**
 * Validate a module's optional middleware export structurally and return the
 * raw array that may contain string refs. The caller resolves strings at
 * registration time so an unknown name fails at assembly rather than per-request.
 */
function extractMiddleware(
  entry: RouteManifestEntry,
  mod: Record<string, unknown>,
): readonly RouteMiddlewareRef[] | undefined {
  const list = validateMiddlewareList(mod['middleware'], (message) => {
    return new Error(`API route "${entry.route}" ${message}`);
  });
  return list;
}
