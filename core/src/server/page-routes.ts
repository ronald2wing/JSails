/**
 * Filesystem page route registration.
 *
 * Serves pages through either the injected `renderPage` callback (module-free)
 * or the structured {@link PageRenderer}. The structured renderer imports the
 * page module lazily so its optional `middleware` export (inline handlers or
 * registered-name strings) is resolved against the named middleware map at
 * registration time — an unknown name fails at assembly. The resolved
 * per-route chain runs after the global chain and before the renderer, so a
 * global middleware may short-circuit with a `Response` (trusted producer) or
 * await `next()`.
 */

import type { Hono } from 'hono';

import type { RequestContext as PageRequestContext } from '../contracts/http.js';
import type { PageRenderer, PageStream } from '../contracts/render.js';
import { renderStreamResponse } from '../pages/page.js';
import { PageRenderError } from '../pages/page.js';
import { validateMiddlewareList } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import type { SignalBus } from '../signals/index.js';
import { resolveStringRefs } from './middleware-refs.js';
import { resolveRoutePaths } from './route-paths.js';
import { createRequestContextFromStore } from './request-pipeline.js';
import { createSignalsMiddleware } from './request-signals.js';
import { markStreamedResponse } from './streamed-response.js';
import type { RenderPage } from '../contracts/http.js';
import { extractCacheControlDeclaration, wrapPublicResponse } from './cache-control.js';
import type { AppEnv, AppMiddlewareHandler } from './env.js';

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Register a page route, delegating rendering to the injected callback. */
export function registerPageRoute(
  app: App,
  entry: RouteManifestEntry,
  renderPage: RenderPage,
  globalMiddleware: readonly AppMiddlewareHandler[],
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string },
  signals?: SignalBus,
): void {
  // Build the per-route chain as Hono handlers.
  const chain: AppMiddlewareHandler[] = [];
  chain.push(createSignalsMiddleware(signals, 'GET'));
  for (const mw of globalMiddleware) chain.push(mw);
  // Terminal adapter: render the page via the `renderPage` callback.
  chain.push(async (c, _next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    return renderPage(entry, ctx);
  });

  // `chain` is always non-empty (terminal adapter at minimum). Optional
  // catch-alls register two Hono paths; the same chain runs for both.
  for (const path of resolveRoutePaths(entry, localeOptions)) {
    app.on('GET', path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
  }
}

/**
 * Register a page route backed by a structured {@link PageRenderer}. The page
 * module is imported lazily so its optional `middleware` export is resolved
 * against the named middleware map at registration time.
 */
export async function registerRendererPageRoute(
  app: App,
  entry: RouteManifestEntry,
  renderer: PageRenderer,
  globalMiddleware: readonly AppMiddlewareHandler[],
  middlewareMap: Readonly<Record<string, AppMiddlewareHandler>> | undefined,
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string },
  signals?: SignalBus,
): Promise<void> {
  // Resolve the page module's middleware refs at registration time so an unknown
  // named ref fails at assembly (not at request time) with a value-free error.
  const module = (await import(entry.file)) as Record<string, unknown>;
  const refs = validateMiddlewareList(module.middleware, (message) => {
    return new Error(`page route "${entry.route}" ${message}`);
  });

  const cacheControl = extractCacheControlDeclaration(entry.route, module);

  const perRouteMiddleware = resolveStringRefs(refs, middlewareMap, (message) => {
    throw new Error(`page route "${entry.route}" ${message}`);
  });

  // Build the per-route chain as Hono middleware handlers. The signal
  // middleware is outermost so it observes the whole chain, including a
  // short-circuit from a global middleware.
  const chain: AppMiddlewareHandler[] = [];
  chain.push(createSignalsMiddleware(signals, 'GET'));
  for (const mw of globalMiddleware) chain.push(mw);
  for (const mw of perRouteMiddleware) chain.push(mw);

  // Terminal adapter: render the page via the structured renderer. A render
  // failure is re-thrown rather than swallowed so the signal middleware emits
  // `requestFailed` with the error and Hono's `onError` produces the sanitized
  // 500 envelope.
  chain.push(async (c, _next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    // Streaming precedence: the module's `stream` export wins for live serving.
    if (typeof module.stream === 'function') {
      const stream = await (
        module.stream as (ctx: PageRequestContext) => PageStream | Promise<PageStream>
      )(ctx);
      return markStreamedResponse(renderStreamResponse(stream));
    }
    const html = await renderer.render(entry, ctx, { staticMode: false });
    if (typeof html !== 'string') {
      throw new PageRenderError(`page route "${entry.route}" renderer did not return a string`);
    }
    const response = new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    return cacheControl !== undefined
      ? wrapPublicResponse(response, cacheControl, 'GET')
      : response;
  });

  for (const path of resolveRoutePaths(entry, localeOptions)) {
    app.on('GET', path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
  }
}
