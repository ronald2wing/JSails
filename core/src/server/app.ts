/**
 * Hono-backed HTTP application builder.
 *
 * `createApp` turns a route {@link RouteManifest} into a Hono app without
 * opening a port or connecting to any external service: the returned `Hono`
 * instance is handed to {@link createHttpServer} (or any Fetch-compatible
 * host) by the caller, who also owns listening and shutdown.
 *
 * Route discovery is manifest-driven, never a central registry. Every `api`
 * entry is imported eagerly at setup and its named HTTP-method exports
 * (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`) are treated as
 * handlers of the shape `(request, context) => Response`. There is no default
 * export guessing: a module with only a `default` export serves no methods,
 * and a method name exported as a non-function value is rejected at setup.
 *
 * HEAD is not registered as its own route: Hono rewrites HEAD dispatch to GET
 * before matching, so an `app.on('HEAD', ...)` route is unreachable. Instead
 * the GET route inspects the ORIGINAL request method (`c.req.raw.method`) and,
 * for a HEAD request, dispatches to the module's `HEAD` export, falling back to
 * `GET` when none exists. A module exposing only `HEAD` is still served (its
 * GET route answers a real GET with 405 and `Allow: HEAD`).
 *
 * Middleware pipeline ordering (each registered via `app.use` in this order):
 *
 *   1. request-id       — `X-Request-Id` on every response, and the ambient id
 *                         (`currentRequestId`) for the rest of the request
 *   2. security-headers — the JSails default header set (see `security-headers.ts`)
 *   3. app-scope        — opens the ambient facade scope around the request
 *   4. body-limit       — caps request body size (skipped for component uploads)
 *   5. method-not-allowed — 405 for unrecognized methods
 *   6. compress         — response compression per Accept-Encoding
 *   7. etag             — ETag / 304 for GET/HEAD, skipped for `no-store`,
 *                         streamed, and large responses
 *   8. cache-control    — default-deny: `private, no-store` unless handler sets
 *   9. session          — installs the lazy, memoized `c.var.loadSession`; route
 *                         chains settle `c.var.session` on entry
 *
 * The health route is registered next, ahead of i18n, so a probe does no
 * locale or session work. After the global middleware, introspection,
 * extension HTTP hooks, and server-component routes are registered. Then
 * filesystem API and page routes are registered with per-route middleware
 * chains: for API routes, CSRF + global-authorize + module-authorize +
 * global-middleware + per-route-middleware → handler; for pages,
 * global-middleware + per-route-middleware → handler.
 *
 * Security posture:
 * - API authorization is default-deny: with no `authorize` callback every API
 *   request is rejected. Authorization succeeds only when the callback resolves
 *   to exactly `true` — truthy non-boolean values, throws, and rejections all
 *   deny. A per-module `authorize` can only further restrict.
 * - `resolveSession` is the trusted application seam for reading the session
 *   cookie; when absent the context carries `session: null`.
 * - Cookie-authenticated mutations (`POST`/`PUT`/`PATCH`/`DELETE` with a
 *   non-null session) require a same-origin `Origin` header and a matching
 *   `X-CSRF-Token` header. This is enforced per-route for filesystem API routes
 *   through Hono middleware.
 * - Pages are public and the loader owns its authorization decision.
 * - Extension hooks are trusted application code; routes they install own their
 *   own authorization.
 * - Errors are reduced to a generic JSON envelope; `ValidationError` maps to
 *   400 with structured issues, `AuthError` to its status, and everything else
 *   to a bare 500. Raw payloads, stack traces, and file paths never leak. A
 *   browser navigation to a page path gets an HTML error page instead (see
 *   `error-pages.ts`); API and framework paths always get the envelope.
 * - Every unexpected failure (a throw from a route, a session resolver, an
 *   authorize callback, or the server-components runtime) is reported to the
 *   `onError` hook, or by default logged to stderr with its stack, request id,
 *   and route pattern (see `request-errors.ts`). Responses stay value-free.
 */

import { Hono, type Context } from 'hono';
import { attachNoStore } from './responses.js';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { etag } from 'hono/etag';
import { methodNotAllowed } from 'hono/method-not-allowed';
import { requestId } from 'hono/request-id';

import { withAppScope } from '../facades/app-scope.js';
import { withLocale } from '../i18n/request-locale.js';
import { i18nToken, type I18nService } from '../i18n/plugin.js';
import type { HttpExtensionHook } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import type { RouteManifest } from '../routing/routes.js';
import type { AssetUrlResolver } from '../contracts/http.js';
import { contentDisposition } from '../support/urls.js';
import { assertHttpOrigin } from '../url/origin.js';
import type { PageRenderer } from '../contracts/render.js';

import type { Authorize, RenderPage, ResolveSession } from '../contracts/http.js';
import type { SystemCheckRegistry } from '../database/system-checks.js';

import {
  assertNoIntrospectRouteCollision,
  registerIntrospectRoute,
  type IntrospectRouteConfig,
} from '../introspect/index.js';
import { DEFAULT_SECURITY_HEADERS } from './security-headers.js';
import { applyDefaultCacheControl } from './cache-control.js';
import { serverComponentsToken } from '../server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../server-components/protocol.js';
import type { ServerComponentsRuntime } from '../server-components/runtime/index.js';
import { jsonError, toErrorResponse } from '../api/error-response.js';
import { readJsonBody } from '../api/json-body.js';
import { registerApiRoutes } from './api-routes.js';
import {
  createRequestContext,
  createRequestContextFromStore,
  CSRF_HEADER,
  ensureRequestSession,
  HTTP_METHODS,
  methodNotAllowedResponse,
  requestErrorInfo,
  resolveSessionOrNull,
  type ResolvedOptions,
} from './request-pipeline.js';
import { registerPageRoute, registerRendererPageRoute } from './page-routes.js';
import { resolveSignalBus } from './request-signals.js';
import { requestFailed, type SignalBus } from '../signals/index.js';
import { isStreamedResponse, markStreamedResponse } from './streamed-response.js';
import { HttpError, type Session } from '../contracts/http.js';
import { createRequestErrorReporter, type RequestErrorHook } from './request-errors.js';
import { withRequestId } from './request-scope.js';
import { createHealthResponders, resolveReadiness, type ReadinessOptions } from './readiness.js';
import {
  builtInErrorPage,
  createApiPathMatcher,
  htmlErrorResponse,
  prefersHtml,
  statusText,
  type ErrorPageRenderer,
  type PublicError,
} from './error-pages.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import type { AppMiddlewareHandler, AppEnv } from './env.js';

export { CSRF_HEADER, HTTP_METHODS };

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Default request-body cap when `maxBodyBytes` is omitted. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * Responses with a declared length above this are never digested for an ETag:
 * hashing them means buffering the whole body before the first byte is sent.
 */
const MAX_DIGEST_BYTES = 1024 * 1024; // 1 MiB

/** Options for {@link createApp}. */
export interface AppOptions {
  /** The route manifest produced by `discoverRoutes`. */
  readonly manifest: RouteManifest;
  /**
   * Global API authorization. Default-deny: omitted means every API request is
   * rejected. The request is allowed only when the callback resolves to exactly
   * `true`; any other value, a throw, or a rejection denies.
   */
  readonly authorize?: Authorize;
  /** Resolve the session for each request. Omitted means `session: null`. */
  readonly resolveSession?: ResolveSession;
  /** Render pages as a `Response`. Omitted means page routes are not served. */
  readonly renderPage?: RenderPage;
  /**
   * Structured page renderer. Serves each page entry by rendering it to an HTML
   * string and wrapping it in a `text/html; charset=utf-8` response. Mutually
   * exclusive with `renderPage`; supplying both is rejected as ambiguous.
   */
  readonly renderer?: PageRenderer;
  /**
   * Read-only services exposed to API and page `RequestContext`s. Omitted means
   * no registry is attached. The framework never starts or shares a global
   * registry; the caller owns the one it passes.
   */
  readonly services?: ServiceRegistry;
  /**
   * Ordered HTTP extension hooks. Each is validated as a function and invoked
   * exactly once, awaited in order, during `createApp` — after the body-limit
   * middleware is installed and before the filesystem routes are registered.
   * Hooks receive the Hono app and are trusted application code; routes they
   * install own their own authorization.
   */
  readonly httpHooks?: readonly HttpExtensionHook[];
  /** Request-body cap in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  readonly maxBodyBytes?: number;
  /**
   * Public origin of the app, e.g. `"https://example.com"`, when it sits behind
   * a TLS-terminating proxy whose own request URL is plain HTTP. The CSRF
   * same-origin check compares the `Origin` header against this origin instead
   * of the request URL's origin. Validated as an `http(s)` ORIGIN only.
   */
  readonly publicOrigin?: string;
  /**
   * Resolver for public asset URLs, attached to every request context so pages,
   * server components, and API handlers can emit cache-busted asset URLs.
   */
  readonly assetUrl?: AssetUrlResolver;
  /**
   * Health endpoint path, registered as framework infrastructure ahead of every
   * extension hook and filesystem route.
   */
  readonly healthPath?: string;
  /**
   * Absolute persistent-storage directory, attached to every request context as
   * `storagePath`.
   */
  readonly storagePath?: string;
  /**
   * Resolved SEO runtime options, attached to every page request context as
   * `seo`.
   */
  readonly seo?: SeoRuntimeOptions;
  /**
   * Resolved introspection config. Passed through from the application config
   * resolver: absent means the route is never registered.
   */
  readonly introspect?: IntrospectRouteConfig;
  /**
   * Optional system-check registry for the readiness probe (`/up?deep=1`).
   * Absent (with no `readiness`) keeps the health route a pure liveness probe.
   */
  readonly systemChecks?: SystemCheckRegistry;
  /**
   * Async readiness probes (database, cache, ...) served at `<healthPath>?deep=1`
   * and at `readiness.path`. Anonymous callers see only the aggregate status;
   * per-check results need `readiness.authorize` to return exactly `true`.
   */
  readonly readiness?: ReadinessOptions;
  /**
   * Receives every unexpected request failure with the route pattern and
   * request id. Omitted means the failure is logged to stderr with its stack.
   * It cannot change the response, which stays a value-free 500.
   */
  readonly onError?: RequestErrorHook;
  /**
   * Renders the HTML document for a 404 or a failed browser navigation to a
   * page path. Omitted (or throwing) means the framework's minimal page. API
   * paths and non-HTML clients always get the JSON envelope.
   */
  readonly errorPage?: ErrorPageRenderer;
  /**
   * Resolved global middleware chain (concrete handlers — string refs already
   * resolved by the application layer), applied before per-route middleware.
   */
  readonly globalMiddleware?: readonly AppMiddlewareHandler[];
  /**
   * Named middleware map (name → handler) for resolving string refs in route
   * `middleware` exports. Concrete handlers are resolved at registration time
   * by `registerApiRoutes` / `registerRendererPageRoute`.
   */
  readonly middlewareMap?: Readonly<Record<string, AppMiddlewareHandler>>;
  /**
   * Locale-prefixed routing. When set, every page/API route is additionally
   * registered under `/{locale}/<route>` for each locale except `defaultLocale`,
   * and a leading locale segment sets the ambient request locale via the i18n
   * middleware.
   */
  readonly localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string };
}

/**
 * Build a Hono app from a route manifest. Imports every API module eagerly,
 * rejecting malformed handler exports before the app is returned. Never opens
 * a port or a connection; the caller owns the server and its lifecycle.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const opts = resolveOptions(options);

  const app = new Hono<AppEnv>();

  // Tells an API/framework path (always the JSON envelope) from a page path
  // (an HTML error page for a browser navigation); every error stage uses it.
  const isApiPath = createApiPathMatcher(
    opts.manifest.entries.filter((entry) => entry.kind === 'api').map((entry) => entry.route),
    opts.localeOptions?.locales,
  );

  // 1. Request ID — early so every response carries an id for correlation,
  //    and ambient for the rest of the request so logs, jobs, and the error
  //    hook can read it without threading it through every call.
  //    Hono's `requestId()` stages the header on the context, which a raw
  //    `Response` returned by a handler does not inherit, so it is re-applied
  //    to the final response here.
  app.use('*', requestId());
  app.use('*', async (c, next) => {
    const id = c.get('requestId');
    await withRequestId(id, () => next());
    if (!c.res.headers.has('x-request-id')) c.res.headers.set('X-Request-Id', id);
  });

  // 2. Security headers — the JSails default header set, applied after handlers
  //    run so an explicit header set by a route or extension is never
  //    overwritten (the guard checks `c.res.headers.has(name)` before setting).
  //    Deliberately NOT `hono/secure-headers`: that built-in's defaults (CSP
  //    `default-src 'self'`, `Referrer-Policy: no-referrer`, obsolete
  //    `X-XSS-Protection`) contradict the framework's documented 3-header policy
  //    (see `security-headers.ts`) — a blind CSP would break inline styles/scripts
  //    in the starter, and the same 3-header set feeds the static-hosting deploy
  //    generators. A developer wanting stricter headers mounts `hono/secure-headers`
  //    via `configureHttp`.
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) {
        c.res.headers.set(name, value);
      }
    }
  });

  // 3. Open the ambient application scope around every request so facades
  //    resolve for the whole pipeline. Registered before all other middleware
  //    so every later handler (health, introspect, extension hooks, filesystem
  //    routes, component updates) has access to facades.
  if (opts.services !== undefined) {
    const services = opts.services;
    app.use('*', (_c, next) => withAppScope(services, () => next()));
  }

  // 4. Body limit — cap request body size. Skipped for component-upload routes
  //    (multipart uploads are bounded by the store's streaming byte limit
  //    instead).
  //    A browser navigation to a page path (a form post) gets the HTML error
  //    page here and at the 405 stage, like a 404 or a failed render.
  const bodyLimitMiddleware = bodyLimit({
    maxSize: opts.maxBodyBytes,
    onError: (c) =>
      prefersHtml(c.req.raw, isApiPath)
        ? renderErrorPage(c, opts, { status: 413, message: statusText(413) })
        : jsonError(413, 'payload_too_large', 'Request body too large'),
  });
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && c.req.path === COMPONENT_UPLOAD_ENDPOINT) {
      return next();
    }
    return bodyLimitMiddleware(c, next);
  });

  // 5. Method not allowed — 405 for unrecognized methods.
  app.use(
    '*',
    methodNotAllowed({
      app,
      onMethodNotAllowed: async (c, methods) => {
        const allow = methods.join(', ');
        if (!prefersHtml(c.req.raw, isApiPath)) return methodNotAllowedResponse(allow);
        const page = await renderErrorPage(c, opts, { status: 405, message: statusText(405) });
        page.headers.set('Allow', allow);
        return page;
      },
    }),
  );

  // 6. Response compresssion per Accept-Encoding.
  app.use('*', compress());

  // 7. ETag / 304 for GET/HEAD responses. Hono's built-in `etag()` awaits the
  //    whole downstream and then buffers `c.res` to EOF to compute a digest. For
  //    a response that never ends — a `text/event-stream` body — that means the
  //    headers are never flushed because `next()` never resolves, so an SSE client
  //    sees zero bytes until it gives up. The wrapper below runs the downstream
  //    once, then routes only finalized non-SSE responses through the captured
  //    native middleware (whose own `next` is a no-op because `c.res` is already
  //    complete), while open event streams are returned untouched and unbuffered.
  //    A finite non-SSE stream still buffers to a digest exactly as before; the
  //    case-insensitive media type (params stripped) is what selects the path.
  //    A page `stream` export is progressive by definition — its first chunk is
  //    meant to reach the client before the producer finishes — so the page
  //    route marks those responses and they bypass digesting too. Otherwise a
  //    slow producer would withhold the whole document, defeating streaming.
  //    A `no-store` response (the default-deny cache layer below has already
  //    stamped it) is never stored, so a browser never revalidates it and a
  //    digest would be pure cost; a large declared body is skipped too. A
  //    response that already carries its own ETag still gets the 304 check,
  //    which costs no hashing. When that check replaces the response with a
  //    304, the discarded body is cancelled so an unread file stream releases
  //    its descriptor.
  const nativeEtag = etag();
  app.use('*', async (c, next) => {
    await next();
    const original = c.res;
    if (!shouldAnswerConditionally(original)) {
      return;
    }
    await nativeEtag(c, async () => {});
    const body = original.body;
    if (c.res.status === 304 && original.status !== 304 && body !== null && !body.locked) {
      void body
        .cancel()
        .catch((error: unknown) => opts.reportError(error, requestErrorInfo(c, 'handler')));
    }
  });

  // 8. Default-deny cache-control: every framework-owned response is
  //    `Cache-Control: private, no-store` unless a route handler set an
  //    explicit header.
  app.use('*', async (c, next) => {
    await next();
    applyDefaultCacheControl(c.res.headers);
  });

  // 9. Session resolution — lazy and memoized. A request that no route claims
  //    (a public file, the health probe, a 404) never touches the session
  //    store, and one that does costs a single lookup however many stages ask.
  //    Route chains settle `c.var.session` on entry (`ensureRequestSession`).
  //    Fail-closed to `null`; a throwing resolver is reported, not swallowed.
  const resolveSession = opts.resolveSession;
  app.use('*', async (c, next) => {
    c.set('session', null);
    let pending: Promise<Session | null> | undefined;
    c.set('loadSession', () => {
      pending ??= resolveSessionOrNull(resolveSession, c.req.raw, (error) =>
        opts.reportError(error, requestErrorInfo(c, 'session')),
      );
      return pending;
    });
    return next();
  });

  // Health and readiness: registered before i18n and every route so a probe
  // does no locale or session work and nothing can shadow it.
  const health = createHealthResponders({
    app,
    systemChecks: opts.systemChecks,
    readiness: opts.readiness,
  });
  if (opts.healthPath !== undefined) {
    app.on(['GET', 'HEAD'], opts.healthPath, (c) =>
      c.req.query('deep') === '1'
        ? (health.readiness(c.req.raw) ?? health.liveness())
        : health.liveness(),
    );
  }
  const readinessPath = opts.readiness?.path;
  if (readinessPath !== undefined) {
    app.on(['GET', 'HEAD'], readinessPath, (c) => health.readiness(c.req.raw) ?? health.liveness());
  }

  // i18n: resolve the request locale and make it ambient for the rest of the
  // pipeline. When the i18n plugin is active, the resolved locale is stored on
  // `c.var.locale` and every async continuation inside the request sees it via
  // the ambient scope. When the plugin is absent this step is skipped entirely.
  if (opts.services !== undefined) {
    const i18n = resolveI18nService(opts.services);
    if (i18n !== undefined) {
      const configuredLocales = opts.localeOptions?.locales;
      const localeSet = configuredLocales === undefined ? undefined : new Set(configuredLocales);
      app.use('*', async (c, next) => {
        // Locale-prefixed routing: a leading `/{locale}` segment (when the
        // locale is configured) wins over Accept-Language/cookie resolution.
        const prefixed = localeSet === undefined ? undefined : prefixLocale(c.req.path, localeSet);
        const resolved =
          prefixed ??
          (await i18n.resolveRequestLocale(c.req.raw, {
            url: new URL(c.req.url),
            params: { ...c.req.param() },
          }));
        c.set('locale', resolved);
        return withLocale(resolved, () => next());
      });
    }
  }

  // 10. Static per-app request-context values — services, publicOrigin,
  //     assetUrl, storagePath, seo. These do not vary per request; storing them
  //     in `c.var` gives the terminal adapter (createRequestContextFromStore)
  //     a single honest source for everything the sovereign RequestContext
  //     needs, alongside the per-request `session` set above.
  app.use('*', async (c, next) => {
    c.set('services', opts.services);
    c.set('publicOrigin', opts.publicOrigin);
    c.set('assetUrl', opts.assetUrl);
    c.set('storagePath', opts.storagePath);
    c.set('seo', opts.seo);
    return next();
  });

  // Introspection: registered before any extension hook or filesystem route
  // so none can shadow it.
  if (opts.introspect !== undefined) {
    assertNoIntrospectRouteCollision(opts.manifest);
    registerIntrospectRoute(app, opts, opts.introspect);
  }

  // Extension hooks run once, in order, after the global middleware and before
  // the filesystem routes. They receive the maintained Hono app directly, so
  // hook routes and middleware reuse Hono. Hook routes are trusted application
  // code: they own their own authorization and are not covered by the
  // default-deny API pipeline below.
  for (const hook of opts.httpHooks) {
    await hook(app);
  }

  // Server-components transport: mounted after extension hooks, before
  // filesystem routes. The runtime owns every origin/CSRF/signature/policy
  // check — no global CSRF or authorize middleware applies here.
  const signals = resolveSignalBus(opts);
  const componentRuntime =
    opts.services === undefined ? undefined : tryGetServerComponents(opts.services);
  if (componentRuntime !== undefined) {
    assertNoComponentRouteCollision(opts.manifest);
    registerComponentUpdateRoute(app, opts, componentRuntime, signals);
    registerComponentUploadRoute(app, opts, componentRuntime, signals);
    registerComponentDownloadRoute(app, opts, componentRuntime, signals);
  }

  // Filesystem routes: API and pages, each with per-route middleware chains.
  // API routes get: CSRF → global-authorize → module-authorize → global-mw →
  // per-route-mw → handler.  Page routes get: global-mw → per-route-mw →
  // handler.  String refs in module `middleware` exports are resolved at
  // registration time via `opts.middlewareMap`. Both kinds emit the same
  // request-lifecycle signals, so one observer sees every failure.
  for (const entry of opts.manifest.entries) {
    if (entry.kind === 'api') {
      await registerApiRoutes(app, entry, opts, opts.middlewareMap);
    } else if (opts.renderer !== undefined) {
      await registerRendererPageRoute(
        app,
        entry,
        opts.renderer,
        opts.globalMiddleware,
        opts.middlewareMap,
        opts.localeOptions,
        signals,
      );
    } else if (opts.renderPage !== undefined) {
      registerPageRoute(
        app,
        entry,
        opts.renderPage,
        opts.globalMiddleware,
        opts.localeOptions,
        signals,
      );
    }
  }

  app.notFound((c) =>
    prefersHtml(c.req.raw, isApiPath)
      ? renderErrorPage(c, opts, { status: 404, message: statusText(404) })
      : jsonError(404, 'not_found', 'Not Found'),
  );
  app.onError((error, c) => {
    void opts.reportError(error, requestErrorInfo(c, 'handler'));
    const envelope = toErrorResponse(error);
    if (!prefersHtml(c.req.raw, isApiPath)) return envelope;
    const message = error instanceof HttpError ? error.message : statusText(envelope.status);
    return renderErrorPage(c, opts, { status: envelope.status, message });
  });

  return app;
}

/**
 * Render the HTML error page for a browser navigation: the app's `errorPage`
 * when given (with the request's lazily resolved session), otherwise or on a
 * renderer failure the framework's minimal page. Always the error's status.
 */
async function renderErrorPage(
  c: Context<AppEnv>,
  opts: ResolvedOptions,
  error: PublicError,
): Promise<Response> {
  if (opts.errorPage !== undefined) {
    try {
      await ensureRequestSession(c);
      const html = await opts.errorPage(error, createRequestContextFromStore(c, c.var));
      if (typeof html === 'string') return htmlErrorResponse(error.status, html);
    } catch (renderError) {
      void opts.reportError(renderError, requestErrorInfo(c, 'handler'));
    }
  }
  return htmlErrorResponse(error.status, builtInErrorPage(error));
}

/**
 * Whether the ETag layer should look at a finalized response at all: never
 * for an open event stream or a progressive page stream, and never digest a
 * `no-store` or large body. A response with its own ETag is always checked.
 */
function shouldAnswerConditionally(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  if (contentType !== null && isEventStream(contentType)) return false;
  if (isStreamedResponse(response)) return false;
  if (response.headers.has('etag')) return true;
  if (/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) {
    return false;
  }
  const length = Number(response.headers.get('content-length') ?? '0');
  return !(length > MAX_DIGEST_BYTES);
}

/** True when a `content-type` header's media type (ignoring parameters and
 *  case) is `text/event-stream`. */
function isEventStream(contentType: string): boolean {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'text/event-stream';
}

/** Extract the leading `/{locale}` segment of a path when it is a configured
 *  locale, otherwise `undefined`. Prefix routing reads the first path segment. */
function prefixLocale(path: string, locales: ReadonlySet<string>): string | undefined {
  const second = path.indexOf('/', 1);
  const firstSegment = second === -1 ? path.slice(1) : path.slice(1, second);
  if (firstSegment.length === 0) return undefined;
  return locales.has(firstSegment) ? firstSegment : undefined;
}

/** Resolve the registered server-components runtime, if one was provided. */
function tryGetServerComponents(services: ServiceRegistry): ServerComponentsRuntime | undefined {
  try {
    return services.tryGet(serverComponentsToken);
  } catch {
    return undefined;
  }
}

/** Resolve the registered i18n service, if one was provided. Structural
 *  guard: a `tryGet` that returns a non-service value (e.g. a test fake that
 *  echoes a constant) is rejected, so the i18n middleware never treats a
 *  non-`I18nService` as one. */
function resolveI18nService(services: ServiceRegistry | undefined): I18nService | undefined {
  if (services === undefined) return undefined;
  let maybe: unknown;
  try {
    maybe = services.tryGet(i18nToken);
  } catch {
    return undefined;
  }
  if (maybe === undefined || maybe === null || typeof maybe !== 'object') {
    return undefined;
  }
  const candidate = maybe as { resolveRequestLocale?: unknown };
  if (typeof candidate.resolveRequestLocale !== 'function') {
    return undefined;
  }
  return maybe as I18nService;
}

/** Reject a filesystem route that would shadow the server-components endpoint. */
function assertNoComponentRouteCollision(manifest: RouteManifest): void {
  for (const entry of manifest.entries) {
    if (
      entry.route === COMPONENT_UPDATE_ENDPOINT ||
      entry.route === COMPONENT_UPLOAD_ENDPOINT ||
      entry.route === COMPONENT_DOWNLOAD_ENDPOINT
    ) {
      throw new Error(
        `route "${entry.route}" collides with the reserved server-components endpoint`,
      );
    }
  }
}

/**
 * Report a server-component runtime failure to the error hook and the signal
 * bus, and return the sanitized 500 envelope. The response stays value-free;
 * the error reaches observers only.
 */
async function componentFailureResponse(
  opts: ResolvedOptions,
  signals: SignalBus | undefined,
  c: Context<AppEnv>,
  method: string,
  error: unknown,
): Promise<Response> {
  void opts.reportError(error, requestErrorInfo(c, 'component'));
  if (signals !== undefined) {
    const url = new URL(c.req.url);
    await signals.emit(requestFailed, {
      request: c.req.raw,
      url,
      params: { ...c.req.param() },
      session: c.var.session,
      method,
      route: url.pathname,
      error,
    });
  }
  return attachNoStore(jsonError(500, 'internal_error', 'Internal Server Error'));
}

/**
 * Register the internal component-update POST route. The route is registered
 * after the body-limit/405 middleware and outside the extension-hook and
 * filesystem pipelines, so the runtime owns every origin/CSRF/signature/policy
 * decision.
 */
function registerComponentUpdateRoute(
  app: App,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
  signals: SignalBus | undefined,
): void {
  app.on('POST', COMPONENT_UPDATE_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await ensureRequestSession(c);
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    let payload: unknown;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      return attachNoStore(toErrorResponse(error));
    }

    try {
      const result = await runtime.update(payload, context, {
        origin: opts.publicOrigin ?? url.origin,
      });
      return attachNoStore(
        new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } catch (error) {
      return componentFailureResponse(opts, signals, c, 'POST', error);
    }
  });
}

/**
 * Register the internal component-upload POST route. Like the update route, the
 * runtime owns every security decision.
 */
function registerComponentUploadRoute(
  app: App,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
  signals: SignalBus | undefined,
): void {
  app.on('POST', COMPONENT_UPLOAD_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await ensureRequestSession(c);
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    try {
      const result = await runtime.handleUpload(request, context, {
        origin: opts.publicOrigin ?? url.origin,
      });
      return attachNoStore(
        new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } catch (error) {
      return componentFailureResponse(opts, signals, c, 'POST', error);
    }
  });
}

/**
 * Register the internal component-download GET route. Like the upload route, the
 * runtime owns every security decision.
 */
function registerComponentDownloadRoute(
  app: App,
  opts: ResolvedOptions,
  runtime: ServerComponentsRuntime,
  signals: SignalBus | undefined,
): void {
  app.on('GET', COMPONENT_DOWNLOAD_ENDPOINT, async (c) => {
    const request = c.req.raw;
    const url = new URL(c.req.url);
    const session = await ensureRequestSession(c);
    const context = createRequestContext({
      request,
      url,
      params: {},
      session,
      publicOrigin: opts.publicOrigin,
      services: opts.services,
      assetUrl: opts.assetUrl,
      storagePath: opts.storagePath,
    });

    try {
      const result = await runtime.handleDownload(request, context, {
        origin: opts.publicOrigin ?? url.origin,
      });

      if (
        result.status === 200 &&
        result.stream !== undefined &&
        result.contentType !== undefined
      ) {
        // Marked streamed so neither the ETag layer nor anything else buffers
        // the whole file before the first byte goes out.
        return markStreamedResponse(
          new Response(result.stream as never, {
            status: 200,
            headers: {
              'content-type': result.contentType,
              'content-disposition': contentDisposition(result.filename ?? 'download'),
              'cache-control': 'no-store',
            },
          }),
        );
      }

      return attachNoStore(
        new Response(JSON.stringify(result.body ?? {}), {
          status: result.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    } catch (error) {
      return componentFailureResponse(opts, signals, c, 'GET', error);
    }
  });
}

function resolveOptions(options: AppOptions): ResolvedOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createApp requires an options object');
  }
  const { manifest } = options;
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw new TypeError('createApp requires a manifest with an entries array');
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (typeof maxBodyBytes !== 'number' || !Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }
  if (options.renderer !== undefined && options.renderPage !== undefined) {
    throw new TypeError('renderer and renderPage are mutually exclusive');
  }
  if (
    options.healthPath !== undefined &&
    (typeof options.healthPath !== 'string' || options.healthPath === '')
  ) {
    throw new TypeError('healthPath must be a non-empty string');
  }
  if (options.storagePath !== undefined && typeof options.storagePath !== 'string') {
    throw new TypeError('storagePath must be a string');
  }
  for (const [name, value] of [
    ['authorize', options.authorize],
    ['resolveSession', options.resolveSession],
    ['renderPage', options.renderPage],
    ['assetUrl', options.assetUrl],
    ['onError', options.onError],
    ['errorPage', options.errorPage],
  ] as const) {
    if (value !== undefined && typeof value !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
  if (options.globalMiddleware !== undefined && !Array.isArray(options.globalMiddleware)) {
    throw new TypeError('globalMiddleware must be an array of middleware handlers');
  }
  const readiness = resolveReadiness(options.readiness);
  // On a shared path a plain GET would answer liveness, so a probe aimed at
  // `readiness.path` could never see a failure.
  if (readiness?.path !== undefined && readiness.path === options.healthPath) {
    throw new TypeError('readiness.path must differ from healthPath');
  }

  return {
    manifest,
    authorize: options.authorize,
    resolveSession: options.resolveSession,
    renderPage: options.renderPage,
    renderer: resolveRenderer(options.renderer),
    services: resolveServices(options.services),
    httpHooks: resolveHttpHooks(options.httpHooks),
    maxBodyBytes,
    publicOrigin: resolvePublicOrigin(options.publicOrigin),
    assetUrl: options.assetUrl,
    healthPath: options.healthPath,
    storagePath: options.storagePath,
    seo: options.seo,
    introspect: options.introspect,
    ...(options.systemChecks !== undefined ? { systemChecks: options.systemChecks } : {}),
    readiness,
    reportError: createRequestErrorReporter(options.onError),
    errorPage: options.errorPage,
    globalMiddleware: options.globalMiddleware ?? [],
    middlewareMap: options.middlewareMap ?? {},
    ...(options.localeOptions !== undefined ? { localeOptions: options.localeOptions } : {}),
  };
}

/** Validate an optional structured renderer exposing a `render` function. */
function resolveRenderer(value: unknown): PageRenderer | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('renderer must be an object implementing render(entry, context, options)');
  }
  if (typeof (value as { render?: unknown }).render !== 'function') {
    throw new TypeError('renderer must implement render(entry, context, options)');
  }
  return value as PageRenderer;
}

/** Validate an optional read-only service registry by its read methods. */
function resolveServices(value: unknown): ServiceRegistry | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('services must be a service registry');
  }
  const registry = value as Record<string, unknown>;
  for (const method of ['has', 'tryGet', 'get'] as const) {
    if (typeof registry[method] !== 'function') {
      throw new TypeError('services must expose has, tryGet, and get');
    }
  }
  return value as ServiceRegistry;
}

/** Validate optional HTTP hooks; every entry must be a function. */
function resolveHttpHooks(value: unknown): readonly HttpExtensionHook[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('httpHooks must be an array of functions');
  }
  for (const hook of value) {
    if (typeof hook !== 'function') {
      throw new TypeError('httpHooks entries must be functions');
    }
  }
  return value as readonly HttpExtensionHook[];
}

/**
 * Validate and canonicalize the optional `publicOrigin`: an `http(s)` ORIGIN
 * only. Rejects credentials, any path beyond `/`, and query/fragment. Returns
 * the canonical origin (lowercased host, no trailing slash) for comparison.
 */
function resolvePublicOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError('publicOrigin must be an http(s) origin string');
  }
  return assertHttpOrigin(value, (problem) => new TypeError(`publicOrigin ${problem}`));
}
