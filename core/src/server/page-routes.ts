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
 *
 * Streaming rendering is chosen per route at registration: a page's boolean
 * `stream` export wins over the app-wide default, and a `stream` function (a
 * progressive producer) wins over both. A streamed page is rendered through
 * the renderer's `renderStream` when it has one and buffered otherwise. A page
 * that declares a public `cacheControl` is never streamed: its `200` would be
 * sent before the suspended subtrees render, so a late failure could be stored
 * by a shared cache and served to every visitor.
 */

import type { Hono } from 'hono';

import type { RequestContext as PageRequestContext } from '../contracts/http.js';
import type { PageModule, PageRenderer } from '../contracts/render.js';
import {
  PageRenderError,
  renderStreamResponse,
  takeErrorBoundaryStatus,
  type StreamingPageRenderer,
} from '../pages/page.js';
import { validateMiddlewareList } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { requestFailed, type SignalBus } from '../signals/index.js';
import { resolveStringRefs } from './middleware-refs.js';
import { resolveRoutePaths } from './route-paths.js';
import { createRequestContextFromStore, requestErrorInfo } from './request-pipeline.js';
import type { RequestErrorReporter } from './request-errors.js';
import { createSignalsMiddleware } from './request-signals.js';
import { markStreamedResponse } from './streamed-response.js';
import type { RenderPage } from '../contracts/http.js';
import {
  extractCacheControlDeclaration,
  wrapPublicResponse,
  type CacheControlDeclaration,
} from './cache-control.js';
import type { AppEnv, AppMiddlewareHandler } from './env.js';
import { detach, escalate } from '../support/detach.js';
import { importFile } from '../support/project-paths.server.js';

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** How {@link registerRendererPageRoute} renders a page. */
export interface RendererPageRouteOptions {
  /** The app-wide streaming default; a page's boolean `stream` export overrides it. */
  readonly stream?: boolean;
  /** Milliseconds a streamed page's suspended subtrees have to finish after the shell. */
  readonly streamTimeoutMs?: number;
  /** Receives a streamed page's failure after its first chunk was sent. */
  readonly reportError?: RequestErrorReporter;
}

/** Register a page route, delegating rendering to the injected callback. */
export function registerPageRoute(
  app: App,
  entry: RouteManifestEntry,
  renderPage: RenderPage,
  globalMiddleware: readonly AppMiddlewareHandler[],
  localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string },
  signals?: SignalBus,
): void {
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
  rendering: RendererPageRouteOptions = {},
): Promise<void> {
  // Resolve the page module's middleware refs at registration time so an unknown
  // named ref fails at assembly (not at request time) with a value-free error.
  const module = await importFile(entry.file);
  const refs = validateMiddlewareList(module.middleware, (message) => {
    return new Error(`page route "${entry.route}" ${message}`);
  });

  const cacheControl = extractCacheControlDeclaration(entry.route, module);

  const streamExport = module.stream;
  if (
    streamExport !== undefined &&
    typeof streamExport !== 'function' &&
    typeof streamExport !== 'boolean'
  ) {
    throw new PageRenderError(
      'invalid_module',
      `page route "${entry.route}" export "stream" must be a function or a boolean`,
    );
  }
  // Checked just above, so the raw export now has the contract's type.
  const pageStream = streamExport as PageModule['stream'];
  // An explicit opt-in that cannot be honored fails at assembly; the app-wide
  // default quietly leaves such a page buffered.
  if (streamExport === true && cacheControl !== undefined) {
    throw new PageRenderError(
      'invalid_module',
      `page route "${entry.route}" cannot stream with a public cacheControl`,
    );
  }
  const wantsStream =
    cacheControl === undefined &&
    typeof streamExport !== 'function' &&
    (typeof streamExport === 'boolean' ? streamExport : rendering.stream === true);
  const streamRenderer = wantsStream ? streamingRenderer(renderer) : undefined;

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
    if (typeof pageStream === 'function') {
      const stream = await pageStream(ctx);
      // A producer that throws mid-stream does so after the handler returned
      // and the signal middleware recorded the request as finished, so the
      // failure is reported here or it would vanish.
      const onError =
        signals === undefined
          ? undefined
          : (error: unknown): void => emitLateFailure(signals, ctx, error);
      return markStreamedResponse(renderStreamResponse(stream, undefined, { onError }));
    }
    if (streamRenderer !== undefined) {
      // Read now: the failure is reported after this handler returned, outside
      // the request's ambient scope.
      const info = requestErrorInfo(c, 'handler');
      const body = await streamRenderer.renderStream(entry, ctx, {
        staticMode: false,
        ...(rendering.streamTimeoutMs !== undefined
          ? { timeoutMs: rendering.streamTimeoutMs }
          : {}),
        onError: (error) => {
          detach(rendering.reportError?.(error, info), escalate);
          if (signals !== undefined) emitLateFailure(signals, ctx, error);
        },
      });
      return markStreamedResponse(
        htmlResponse(body, takeErrorBoundaryStatus(ctx), cacheControl, ctx),
      );
    }
    const html = await renderer.render(entry, ctx, { staticMode: false });
    if (typeof html !== 'string') {
      throw new PageRenderError(
        'invalid_render',
        `page route "${entry.route}" renderer did not return a string`,
      );
    }
    return htmlResponse(html, takeErrorBoundaryStatus(ctx), cacheControl, ctx);
  });

  for (const path of resolveRoutePaths(entry, localeOptions)) {
    app.on('GET', path, ...(chain as [AppMiddlewareHandler, ...AppMiddlewareHandler[]]));
  }
}

/**
 * The page's HTML response. An error boundary answers with the status of the
 * error it rendered, and an error page is never stored by a shared cache;
 * otherwise a declared `cacheControl` applies (only ever to a buffered body).
 */
function htmlResponse(
  body: string | ReadableStream<Uint8Array>,
  boundaryStatus: number | undefined,
  cacheControl: CacheControlDeclaration | undefined,
  ctx: PageRequestContext,
): Response {
  const streamedBody = typeof body !== 'string';
  const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
  // A buffering reverse proxy would otherwise hold a streamed page until it ends.
  if (streamedBody) headers['x-accel-buffering'] = 'no';
  if (boundaryStatus !== undefined) {
    return new Response(body, {
      status: boundaryStatus,
      headers: { ...headers, 'cache-control': 'no-store' },
    });
  }
  const response = new Response(body, { status: 200, headers });
  return cacheControl !== undefined
    ? wrapPublicResponse(response, {
        declaration: cacheControl,
        method: 'GET',
        session: ctx.session,
        requestHeaders: ctx.request.headers,
      })
    : response;
}

/** Emit `requestFailed` for a failure that happened after the handler returned. */
function emitLateFailure(signals: SignalBus, ctx: PageRequestContext, error: unknown): void {
  // emit() isolates observer errors; a rejection is the registry itself failing
  // after the response was sent, with no caller left to tell.
  signals
    .emit(requestFailed, {
      request: ctx.request,
      url: ctx.url,
      params: ctx.params,
      session: ctx.session,
      method: 'GET',
      route: ctx.url.pathname,
      error,
    })
    .catch(() => undefined);
}

/** The renderer as a {@link StreamingPageRenderer}, when it can stream. */
function streamingRenderer(renderer: PageRenderer): StreamingPageRenderer | undefined {
  return typeof (renderer as Partial<StreamingPageRenderer>).renderStream === 'function'
    ? (renderer as StreamingPageRenderer)
    : undefined;
}
