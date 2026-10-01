/**
 * Hono-backed HTTP application builder.
 *
 * `createApp` turns a route {@link RouteManifest} into a Hono app without
 * opening a port or connecting to any external service: the returned `Hono`
 * instance is handed to {@link createHttpServer} (or any Fetch-compatible
 * host) by the caller, who also owns listening and shutdown.
 *
 * Route discovery is manifest-driven, never a central registry. Every `api`
 * entry is loaded and validated at setup (`api-routes.ts`: a `defineApi`
 * default export, or named method exports), every page module through the
 * renderer's loader (`page-routes.ts`). A GET route also answers HEAD, with
 * an API module's `HEAD` export when it has one.
 *
 * The request pipeline, in order:
 *
 *   request handler  — `app.fetch` (see `request-handler.ts`): opens the
 *                      request frame (the request's origin and client from
 *                      the `server` config — `origin`, `hosts`,
 *                      `trustedProxies` — a 421 for a host the app does not
 *                      serve, a health or readiness probe excepted; the
 *                      canonical forwarding headers; the request id) and
 *                      runs everything below in the request's one execution
 *                      context (`jsails/context`): its span (an inbound
 *                      `traceparent` continued only from a trusted proxy or
 *                      with `telemetry.trustInbound`), the application scope
 *                      facades resolve against, and the frame itself
 *   guards           — the guard tier (`guards`, config `http.guards`,
 *                      extension `configureGuard`): walls in front of every
 *                      later stage, route, and asset; a health or
 *                      readiness probe passes unguarded
 *   assets           — a GET or HEAD of a file in the asset index
 *                      (`assets`, `assets/responder.ts`) is answered from
 *                      the index, before any route: a literal asset path
 *                      wins over a parametric, catch-all or mount route,
 *                      and one equal to a literal route or a reserved path
 *                      fails assembly (`assets/collisions.ts`)
 *   router (Hono)    — the HEAD capture, then the matched route's
 *                      boundary, or the not-found answer (a 405 with `Allow` when the route
 *                      table says the path answers other methods); a body
 *                      declaring more than `MAX_ROUTE_BODY_BYTES` is
 *                      answered 413 first
 *   finalize         — the one response finalizer (`output.ts`): cache
 *                      policy, content coding, validator and 304, the
 *                      request id and the security headers, installed bytes
 *
 * Every failure, wherever it happens, is mapped by `toFailure` and rendered
 * once by the failure renderer (`failure-renderer.ts`): the problem envelope for an
 * API, framework or unmatched API path, an HTML page for a page route or a
 * browser navigation.
 *
 * Every route is registered through one path: it is recorded in the route
 * table (`route-table.ts`: duplicates, mount overlaps, the reserved paths and
 * the `/_jsails` namespace, the plugin-origin rule), its surface descriptor
 * is registered (`security/surfaces.ts`: no surface without access), and it
 * is compiled into one route boundary (`route-boundary.ts`), whose fixed
 * order is the frame entry, the declared-length check against the route's
 * body limit, the deadline, the rate-limit hook, the claim, the access chain
 * (`security/access-chain.ts`: the cross-site check of an unsafe request to
 * a cookie-accepting surface, then the route's `access`), the middleware and
 * the terminal, the response transforms, and the body budget's verdict. The
 * asset index is a surface too (`asset:public`: public, reading no
 * credential), answered before every route. Routes compile in precedence
 * order,
 * so a path a route owns reaches it before any fallback pattern that could
 * also match it: the framework routes (the health and readiness probes,
 * recorded and never claiming; introspection; the server-component
 * transport; each answering every method of its reserved path), the
 * registrar's mounts, the registrar's routes under `/_jsails`, the
 * registrar's other routes, then the filesystem API and page routes. Code
 * outside the filesystem serves HTTP only through a registrar
 * (`http-routes.ts`); nothing receives the router. A
 * request no route claims resolves no identity, locale or scope.
 *
 * Request bodies: every body is read lazily through the request's body
 * budget (`body-budget.ts`), counted against the limit of the route it
 * reached (its `body` declaration, else `maxBodyBytes`), so a request the
 * gate or a guard refuses has none of its body read, and `Expect:
 * 100-continue` is answered only when a reader asks for the body. A read
 * past the limit answers 413 whatever the handler does with the error.
 * Every route answers within its deadline (`timeoutMs`, else
 * `handlerTimeoutMs`, 30 seconds by default) or is answered 504.
 *
 * Security posture:
 * - Every route states its access: `publicAccess(reason)` or a check
 *   allowing only on an exact `true`; there is no default, and a filesystem
 *   API module stating none fails assembly (`surface.missing_access`). A
 *   throwing check is a fault (503, reported), never a silent deny. A page is
 *   public unless its `definePage` export says otherwise.
 * - `resolveSession` (or an `identity` source) is the trusted application
 *   seam for reading the session; it runs at most once, for a request a route
 *   claims (an `identity` source that declares its credential names only when
 *   the request carries one), and when absent the context carries
 *   `session: null`.
 * - A route accepting the `cookie` credential (the default) refuses an unsafe
 *   request, anonymous or not, unless its `Origin` is exactly the origin the
 *   request was addressed to (or, without `Origin`, its `Sec-Fetch-Site` is
 *   `same-origin`). Every denial is sent `private, no-store` without
 *   `Set-Cookie`.
 * - Under `pluginOrigins: 'code-only'` (the default) a managed plugin's route
 *   or response transform fails assembly.
 * - Errors are reduced to the problem envelope (`toFailure`): a client
 *   error's status, code, message and exposed members; an operator error's
 *   status only. Raw payloads, stack traces, and file paths never leak. A
 *   page route or a browser navigation gets an HTML error page instead (see
 *   `failure-renderer.ts`); API and framework paths always get the envelope.
 * - Every unexpected failure (a throw from a route, a session resolver, an
 *   access check, or the server-components runtime; anything `toFailure`
 *   answers with 500 or above) is reported to the `onError` hook, or by
 *   default logged to stderr with its stack, request id, and route pattern
 *   (see `request-errors.ts`). Responses stay value-free.
 *
 * `createApp` returns the Hono app with its `fetch` replaced by the request
 * handler; `app.request()` and `createHttpServer(app)` both go through it.
 */

import { Hono } from 'hono';

import { legacyAccess, publicAccess } from '../api/access-ref.js';
import { toFailure } from '../api/error-response.js';
import type { AssetIndex } from '../assets/asset-index.js';
import { enforceAssetRules } from '../assets/collisions.js';
import { createAssetResponder, type AssetResponder } from '../assets/responder.js';
import type { ApiMethod, ResolveSession } from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';
import type { SystemCheckRegistry } from '../database/system-checks.js';
import { isProductionNodeEnv } from '../environment/names.js';
import { notFound } from '../errors/kernel.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { appScopeEntry } from '../facades/app-scope.js';
import { i18nToken, type I18nService, type LocaleDecision } from '../i18n/token.js';
import {
  createIntrospectHandler,
  INTROSPECT_ENDPOINT,
  type IntrospectRouteConfig,
} from '../introspect/route.js';
import { createNotFoundErrorPage, notFoundRouteEntry } from '../pages/not-found.js';
import type { RouteManifest } from '../routing/routes.js';
import { createProxyDiagnostic } from '../security/proxy-diagnostic.js';
import {
  createOriginPolicy,
  observeRequestOrigins,
  RequestOriginConfigError,
  type OriginPolicy,
  type ServerOriginConfig,
} from '../security/request-origin.js';
import {
  attachSurfaces,
  createSurfaceRegistry,
  publicFilesSurface,
  surfaceOfRoute,
  type SurfaceDescriptor,
  type SurfaceKind,
} from '../security/surfaces.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { serverComponentsToken } from '../server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../server-components/protocol.js';
import type {
  ComponentRoute,
  ServerComponentsRuntime,
} from '../server-components/runtime/index.js';
import { registerApiRoutes } from './api-routes.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  validateBodyLimit,
  type BodySpec,
  DEFAULT_HANDLER_TIMEOUT_MS,
  isTimeoutMs,
  MAX_TIMEOUT_MS,
} from './route-limits.js';
import type { AppContext, AppEnv } from './env.js';
import { createApiPathMatcher, type ErrorPageRenderer } from './error-pages.js';
import { createFailureRenderer } from './failure-renderer.js';
import {
  isTransformKinds,
  type HttpContributions,
  type MountContribution,
  type RouteContribution,
} from './http-routes.js';
import { registerPageRoutes } from './page-routes.js';
import { createHealthResponders, resolveReadiness, type ReadinessOptions } from './readiness.js';
import { createRequestErrorReporter, type RequestErrorHook } from './request-errors.js';
import {
  resolveGuards,
  sessionIdentitySource,
  type FrameRuntime,
  type Guard,
  type IdentitySource,
  type LocaleResolver,
} from './request-frame.js';
import { createRequestHandler } from './request-handler.js';
import { HTTP_METHODS, httpFailure, type ResolvedOptions } from './request-pipeline.js';
import { resolveRequestScopes, type RequestScopeSpec } from './request-scope.js';
import { resolveSignalBus } from './request-signals.js';
import {
  compileRouteBoundary,
  type BoundaryRuntime,
  type RegisterRoute,
  type RouteRateLimit,
} from './route-boundary.js';
import { ownerSlot, RouteErrors, type RouteMeta } from './route-meta.js';
import {
  createRouteTable,
  inNamespace,
  type PluginOrigins,
  type RouteTable,
} from './route-table.js';

export { HTTP_METHODS };

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Options for {@link createApp}. */
export interface AppOptions {
  /** The route manifest produced by `discoverRoutes`. */
  readonly manifest: RouteManifest;
  /**
   * Resolve the session of a request, at most once per request and only when
   * a route claims it. A callback declares nothing about where it reads a
   * credential, so it runs for every claimed request; `identity` with declared
   * credential names skips anonymous ones. Omitted means `session: null`.
   * Mutually exclusive with `identity`.
   */
  readonly resolveSession?: ResolveSession;
  /**
   * The identity source: `hasCredential` decides from the request alone
   * whether `resolve` runs at all (`identitySource({ cookies, headers,
   * resolve })` builds one from the credential names it reads). Mutually
   * exclusive with `resolveSession`, which is the same seam counting every
   * request as credentialed.
   */
  readonly identity?: IdentitySource;
  /**
   * Structured page renderer. Serves each page entry by rendering it to an
   * HTML string and wrapping it in a `text/html; charset=utf-8` response.
   * Omitted means page routes are not served.
   */
  readonly renderer?: PageRenderer;
  /**
   * Read-only services exposed to API and page `RequestContext`s. Omitted means
   * no registry is attached. The framework never starts or shares a global
   * registry; the caller owns the one it passes.
   */
  readonly services?: ServiceRegistry;
  /**
   * What the HTTP registrars collected (`createHttpRoutes`, an extension's
   * `routes`): routes and mounts, and response transforms. Mounts and routes
   * under `/_jsails` compile before the registrars' other routes, and all of
   * them before the filesystem routes. Their guards belong in `guards`.
   */
  readonly contributions?: Pick<HttpContributions, 'routes' | 'transforms'>;
  /**
   * The rate-limit hook of every route boundary, after the frame entry and
   * before the claim. Omitted means no limit.
   */
  readonly rateLimit?: RouteRateLimit;
  /**
   * Which plugin origins may own routes. `'code-only'` (the default) fails
   * assembly on a managed plugin's route; `'allow-managed'` serves them.
   */
  readonly pluginOrigins?: PluginOrigins;
  /**
   * Load every page's modules (its layouts, its error boundary, each
   * not-found page) at assembly through the renderer's `preload`, so no
   * request imports a module. Defaults to `true` when `NODE_ENV` is
   * production. API and page modules themselves always load at assembly.
   */
  readonly preloadModules?: boolean;
  /**
   * Request scopes from extension `configureRequestScope`, in registration
   * order (the first binding is outermost). Each resolves once per request,
   * when a route claims it, after the identity and the locale and before the
   * access chain, middleware, and the handler, which run inside its binding.
   * Names must be unique.
   */
  readonly requestScopes?: readonly RequestScopeSpec[];
  /**
   * The guard tier: each guard runs, in order, for every request the app
   * serves but a GET or HEAD of `healthPath` or `readiness.path`, before the
   * assets, the 405 answer, and routes. The first that
   * answers with a `Response` refuses the request; one that throws fails it
   * with a value-free 500.
   */
  readonly guards?: readonly Guard[];
  /**
   * Request-body cap in bytes of a route that declares no `body` (and of a
   * request no route entered). Defaults to {@link DEFAULT_MAX_BODY_BYTES}; at
   * most `MAX_ROUTE_BODY_BYTES` (100 MiB), like a route's own cap. A route
   * declares its own with `body: { kind, maxBytes }` (see `route-limits.ts`).
   */
  readonly maxBodyBytes?: number;
  /**
   * Milliseconds a route that declares no `timeoutMs` has to answer, from
   * entry to the returned response; past it the request is answered 504 and
   * the frame's signal aborts. `0` disables it. Defaults to 30000 (config
   * `server.handlerTimeoutMs`).
   */
  readonly handlerTimeoutMs?: number;
  /**
   * The request-origin part of the `server` config: the canonical public
   * origin (e.g. `"https://example.com"`, which behind a TLS-terminating proxy
   * differs from the plain-HTTP request URL), the other hosts the app answers
   * on, and which proxies may speak for the client. A request for any other
   * host is answered 421. Omitted, every host is its own origin and the socket
   * peer is the client.
   */
  readonly server?: ServerOriginConfig;
  /**
   * The asset index (`createAssetIndex`): its files are served after the
   * guards and before routing, as the `asset:public` surface (public, reading
   * no credential), and its `url` is every request context's `assetUrl`. An
   * asset whose path equals a literal route or a reserved path fails assembly
   * (`asset.route_collision`; a development index warns).
   */
  readonly assets?: AssetIndex;
  /**
   * Health endpoint path, registered as framework infrastructure ahead of every
   * registrar route and filesystem route.
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
   * paths and non-HTML clients always get the JSON envelope. With a
   * `renderer`, a 404 inside the scope of a `pages/.../not-found` module
   * renders that page instead, and this renderer answers everything else.
   */
  readonly errorPage?: ErrorPageRenderer;
  /**
   * Locale-prefixed routing. When set, every page/API route is additionally
   * registered under `/{locale}/<route>` for each locale except `defaultLocale`,
   * and a leading locale segment sets the ambient request locale via the i18n
   * middleware.
   */
  readonly localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string };
  /**
   * Page rendering. Pages are buffered; a page opts into streaming with
   * `export const stream = true` (or a producer function). `streamTimeoutMs`
   * (a positive integer up to 2147483647, 30 seconds by default) bounds how
   * long the suspended subtrees of a streamed page may take after the shell,
   * and how long a streamed page may go without a chunk; past it the document
   * ends with a generic notice and the timeout goes to `onError`.
   */
  readonly render?: { readonly streamTimeoutMs?: number };
  /**
   * Tracing. `trustInbound: true` continues every inbound `traceparent`, not
   * only one a trusted proxy (`server.trustedProxies`) relayed; set it only
   * for an app no one but its own services can reach. Omitted, a request
   * from anyone else starts a new trace.
   */
  readonly telemetry?: { readonly trustInbound?: boolean };
}

/** The route table of each app `createApp` built. */
const tables = new WeakMap<object, RouteTable>();

/**
 * The route table of an app `createApp` built: every route it serves, as
 * registered. `undefined` for any other object.
 *
 * @public
 */
export function routeTableOf(app: object): RouteTable | undefined {
  return tables.get(app);
}

/**
 * What an app answers asset requests from: its index, and the responder that
 * knows which paths a route keeps.
 *
 * @internal
 */
export interface AssetSurface {
  readonly index: AssetIndex;
  readonly responder: AssetResponder;
}

/** The asset surface of each app `createApp` built with an asset index. */
const assetSurfaces = new WeakMap<object, AssetSurface>();

/**
 * The asset surface of an app `createApp` built: `null` for one without an
 * asset index, `undefined` for any other object. `assetRowsOf`
 * (`assets/surface-rows.ts`) lists it, so serving never loads the rows.
 *
 * @internal
 */
export function assetSurfaceOf(app: object): AssetSurface | null | undefined {
  if (!tables.has(app)) return undefined;
  return assetSurfaces.get(app) ?? null;
}

/** The access of the health and readiness probes. */
const PROBE_ACCESS = publicAccess('health probe; the readiness detail has its own authorize');

/** The access of the server-component transport routes. */
const COMPONENT_ACCESS = publicAccess('the component lane verifies every request');

/**
 * Build a Hono app from a route manifest. Loads every API and page module
 * eagerly, rejecting malformed exports and refused registrations before the
 * app is returned. Never opens a port or a connection; the caller owns the
 * server and its lifecycle.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const opts = resolveOptions(options);
  const routing = resolveRouting(options);

  const app = new Hono<AppEnv>();

  // The request frame's per-application inputs: what every request context
  // carries, how the origin is resolved, and what a claim resolves.
  const signals = resolveSignalBus(opts.services);
  const runtime: FrameRuntime = {
    statics: {
      ...(opts.services === undefined ? {} : { services: opts.services }),
      ...(opts.assets === undefined ? {} : { assetUrl: opts.assets.url }),
      ...(opts.storagePath === undefined ? {} : { storagePath: opts.storagePath }),
      ...(opts.seo === undefined ? {} : { seo: opts.seo }),
    },
    originPolicy: opts.originPolicy,
    probePaths: new Set(
      [opts.healthPath, opts.readiness?.path].filter((path): path is string => path !== undefined),
    ),
    trustInboundTrace: opts.trustInboundTrace,
    contextEntries: opts.services === undefined ? [] : [appScopeEntry(opts.services)],
    identity: opts.identity,
    locale: createLocaleResolver(opts),
    scopes: opts.scopes,
    reportError: opts.reportError,
    signals,
    maxBodyBytes: opts.maxBodyBytes,
    strictBodyKinds: !isProductionNodeEnv(process.env.NODE_ENV),
  };

  // Every failure is rendered here: the problem envelope for an API or
  // framework path (always) and for a non-HTML client, an HTML page for a
  // page route or a browser navigation.
  const renderFailure = createFailureRenderer({
    isApiPath: createApiPathMatcher(
      opts.manifest.entries.filter((entry) => entry.kind === 'api').map((entry) => entry.route),
      opts.localeOptions?.locales,
    ),
    errorPage: opts.errorPage,
  });
  // The asset fast path: after the guards, before the router.
  const assets =
    opts.assets === undefined ? undefined : createAssetResponder(opts.assets, { renderFailure });
  const handler = createRequestHandler(
    { runtime, guards: opts.guards, renderFailure, assets },
    app.fetch,
  );

  // The HEAD capture is the router's first middleware, so it sees the final
  // GET answer, error answers included.
  app.use('*', handler.capture);

  // The route table every registration goes through. The framework's exact
  // paths are reserved whether or not the route behind them is enabled, so
  // an app does not change meaning when it turns one on.
  const readinessPath = opts.readiness?.path;
  const reservedPaths: ReadonlySet<string> = new Set(
    [
      opts.healthPath,
      readinessPath,
      INTROSPECT_ENDPOINT,
      COMPONENT_UPDATE_ENDPOINT,
      COMPONENT_UPLOAD_ENDPOINT,
      COMPONENT_DOWNLOAD_ENDPOINT,
    ].filter((path): path is string => path !== undefined),
  );
  const table = createRouteTable({ reservedPaths, pluginOrigins: routing.pluginOrigins });
  tables.set(app, table);
  const surfaces = createSurfaceRegistry();
  attachSurfaces(app, surfaces);
  if (opts.assets !== undefined && assets !== undefined) {
    assetSurfaces.set(app, { index: opts.assets, responder: assets });
    surfaces.add(publicFilesSurface());
  }
  // Every row the table records registers its surface.
  const recordRoute = (meta: RouteMeta): { meta: RouteMeta; surface: SurfaceDescriptor } => {
    const recorded = table.record(meta);
    return { meta: recorded, surface: surfaces.add(surfaceOfRoute(recorded)) };
  };
  const boundary: BoundaryRuntime = {
    rateLimit: routing.rateLimit,
    renderFailure,
    signals,
    transforms: routing.transforms,
    handlerTimeoutMs: opts.handlerTimeoutMs,
  };
  const register: RegisterRoute = (meta, spec) => {
    const { meta: recorded, surface } = recordRoute(meta);
    const route = compileRouteBoundary(boundary, recorded, surface, spec);
    const methods: string[] = [
      ...new Set(recorded.methods.map((method) => (method === 'HEAD' ? 'GET' : method))),
    ];
    const paths =
      recorded.kind === 'mount' ? [recorded.pattern, `${recorded.pattern}/*`] : [recorded.pattern];
    app.on(methods, paths, route);
  };

  // A request no route matched: a 405 with `Allow` when its path answers
  // other methods, otherwise a 404.
  const unmatched = (c: AppContext): Promise<Response> => {
    const frame = handler.frameOf(c);
    const routeMethods = table.allowedMethods(c.req.path);
    // An asset answers GET and HEAD: any other method on its path is a 405.
    const allowed =
      assets?.serves(frame.url.pathname) === true
        ? [...new Set([...routeMethods, 'GET', 'HEAD'])].sort()
        : routeMethods;
    const failure =
      allowed.length > 0 && !allowed.includes(c.req.method)
        ? httpFailure('method_not_allowed', 405, { allow: allowed.join(', ') })
        : toFailure(notFound());
    return renderFailure(frame, failure, { unmatched: true });
  };
  // A reserved path is the framework's for every method: one it does not
  // serve is answered 405 here, never by a fallback pattern registered later.
  const reserve = (path: string, methods: readonly ApiMethod[]): void => {
    const allow = [...new Set(methods.flatMap((m) => (m === 'GET' ? [m, 'HEAD'] : [m])))]
      .sort()
      .join(', ');
    app.all(path, (c) =>
      renderFailure(c.var.frame, httpFailure('method_not_allowed', 405, { allow }), {
        unmatched: true,
      }),
    );
  };

  // Routes compile in precedence order, so a path a route owns reaches it
  // before any fallback pattern (a catch-all) that could also match it. The
  // framework routes come first: health and readiness (recorded, answered
  // without the boundary; a probe claims nothing, so it does no locale,
  // session, or scope work), introspection, and the server-component
  // transport.
  const health = createHealthResponders({
    app,
    systemChecks: opts.systemChecks,
    readiness: opts.readiness,
  });
  if (opts.healthPath !== undefined) {
    recordRoute(frameworkRoute(opts.healthPath, ['GET', 'HEAD'], PROBE_ACCESS, []));
    app.on(['GET', 'HEAD'], opts.healthPath, (c) =>
      c.req.query('deep') === '1'
        ? (health.readiness(c.req.raw) ?? health.liveness())
        : health.liveness(),
    );
    reserve(opts.healthPath, ['GET', 'HEAD']);
  }
  if (readinessPath !== undefined) {
    recordRoute(frameworkRoute(readinessPath, ['GET', 'HEAD'], PROBE_ACCESS, []));
    app.on(['GET', 'HEAD'], readinessPath, (c) => health.readiness(c.req.raw) ?? health.liveness());
    reserve(readinessPath, ['GET', 'HEAD']);
  }

  // Introspection: a framework route whose access is the config's
  // `authorize` (absent, it denies), read with the session cookie.
  if (opts.introspect !== undefined) {
    const introspect = createIntrospectHandler(opts.services, opts.introspect);
    const authorize = opts.introspect.authorize;
    register(
      frameworkRoute(INTROSPECT_ENDPOINT, ['GET'], legacyAccess(authorize ?? (() => false)), [
        'cookie',
      ]),
      {
        middleware: [],
        terminal: (_routed, context) => introspect(context),
      },
    );
    reserve(INTROSPECT_ENDPOINT, ['GET']);
  }

  // Server-components transport. Each route accepts the session cookie, so
  // the access chain's cross-site check covers its unsafe requests; past it
  // the runtime's lane boundary owns every signature, policy and concurrency
  // check, so the route's access is public. The lane also
  // owns the request's deadline (its `totalMs`, answered `503 timeout` in the
  // lane's own envelope, a body's transfer included); it starts once the
  // lane runs, so the route's deadline is the lane's plus the app's for
  // what comes before it (the rate limit, the claim), and never cuts the
  // lane short.
  const componentRuntime =
    opts.services === undefined ? undefined : tryGetServerComponents(opts.services);
  if (componentRuntime !== undefined) {
    const routes = componentRuntime.routes;
    const lanes = routes.laneTotalMs;
    const outlasting = (laneMs: number): number =>
      componentRouteTimeout(laneMs, opts.handlerTimeoutMs);
    registerComponentRoute(register, 'POST', COMPONENT_UPDATE_ENDPOINT, routes.update, {
      surface: 'component-action',
      timeoutMs: outlasting(lanes.update),
    });
    // The upload lane bounds each file itself; the route's budget is the
    // largest multipart body that lane accepts.
    registerComponentRoute(register, 'POST', COMPONENT_UPLOAD_ENDPOINT, routes.upload, {
      surface: 'upload',
      timeoutMs: outlasting(lanes.upload),
      body: { kind: 'raw', maxBytes: validateBodyLimit(routes.uploadBodyBytes, 'uploadBodyBytes') },
    });
    registerComponentRoute(register, 'GET', COMPONENT_DOWNLOAD_ENDPOINT, routes.download, {
      surface: 'download',
      timeoutMs: outlasting(lanes.download),
    });
    reserve(COMPONENT_UPDATE_ENDPOINT, ['POST']);
    reserve(COMPONENT_UPLOAD_ENDPOINT, ['POST']);
    reserve(COMPONENT_DOWNLOAD_ENDPOINT, ['GET']);
  }

  // The registrars' mounts own their subtrees, and their routes under
  // `/_jsails` the namespace paths they name: both before any other
  // registrar route that could reach into them.
  const { mounts, namespaced, others } = partitionContributions(routing.routes);
  for (const contribution of [...mounts, ...namespaced]) {
    registerContribution(register, contribution);
  }

  // The registrars' other routes, in registration order.
  for (const contribution of others) {
    registerContribution(register, contribution);
  }

  // Filesystem routes: API and pages. Both kinds emit the same
  // request-lifecycle signals, so one observer sees every failure.
  const shared = { localeOptions: opts.localeOptions };
  for (const entry of opts.manifest.entries) {
    if (entry.kind === 'api') {
      await registerApiRoutes(register, entry, shared);
    } else if (opts.renderer !== undefined) {
      await registerPageRoutes(register, entry, {
        ...shared,
        renderer: opts.renderer,
        ...(opts.streamTimeoutMs !== undefined ? { streamTimeoutMs: opts.streamTimeoutMs } : {}),
      });
    }
  }
  if (routing.preloadModules && opts.renderer !== undefined) {
    await preloadPages(opts.renderer, opts.manifest);
  }

  // Which of an asset and a route answers a shared path is settled here,
  // once every route is in the table.
  if (opts.assets !== undefined && assets !== undefined) {
    enforceAssetRules(opts.assets, assets, {
      routes: () => table.entries(),
      reserved: reservedPaths,
      production: isProductionNodeEnv(process.env.NODE_ENV),
    });
  }

  app.notFound(unmatched);
  // An `Error` thrown inside the router; anything else is thrown past Hono
  // and answered by the request handler the same way.
  app.onError((error, c) => {
    const frame = handler.frameOf(c);
    frame.report(error, 'handler');
    return renderFailure(frame, toFailure(error));
  });

  app.fetch = handler.fetch;
  return app;
}

/**
 * The locale resolver of the request claim, or `undefined` without the i18n
 * plugin: a leading `/{locale}` segment naming a configured locale wins (it
 * reads nothing but the path), otherwise the plugin decides.
 */
function createLocaleResolver(opts: ResolvedOptions): LocaleResolver | undefined {
  const i18n = resolveI18nService(opts.services);
  if (i18n === undefined) return undefined;
  const configured = opts.localeOptions?.locales;
  const locales = configured === undefined ? undefined : new Set(configured);
  return async (request, url, params) => {
    const prefixed = locales === undefined ? undefined : prefixLocale(url.pathname, locales);
    if (prefixed !== undefined) return pathLocale(prefixed);
    return i18n.resolveRequestLocale(request, { url, params: { ...params } });
  };
}

/** The decision for a locale named by the path prefix. */
function pathLocale(locale: string): LocaleDecision {
  return Object.freeze({ locale, source: 'path', vary: Object.freeze([]), cookie: false });
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

/** A framework route's meta: an `ops` surface the framework owns. */
function frameworkRoute(
  pattern: string,
  methods: RouteMeta['methods'],
  access: RouteMeta['access'],
  credentials: RouteMeta['credentials'],
): RouteMeta {
  return {
    kind: 'framework',
    pattern,
    methods,
    access,
    credentials,
    surface: 'ops',
    owner: 'framework',
    origin: 'framework',
  };
}

/**
 * Register one server-component transport route. Only a {@link ComponentRoute}
 * can be registered, and only `componentRoute` builds one, so the lane
 * boundary runs before any handler; the failures it reports reach the error
 * hook and the signal bus through the frame.
 */
function registerComponentRoute(
  register: RegisterRoute,
  method: 'GET' | 'POST',
  pattern: string,
  route: ComponentRoute,
  limits: { readonly surface: SurfaceKind; readonly timeoutMs: number; readonly body?: BodySpec },
): void {
  register(
    {
      kind: 'component',
      pattern,
      methods: [method],
      access: COMPONENT_ACCESS,
      credentials: ['cookie'],
      surface: limits.surface,
      ...(limits.body === undefined ? {} : { body: limits.body }),
      timeoutMs: limits.timeoutMs,
      owner: 'framework',
      origin: 'framework',
    },
    {
      middleware: [],
      terminal: ({ frame, request }, context) =>
        route(request, context, (error: unknown) => frame.report(error, 'component')),
    },
  );
}

/**
 * The deadline of a component route whose lane lets a request run `laneMs`:
 * the lane's whole budget plus the app's handler deadline for the stages
 * before the lane, or none when the app runs without deadlines (`0`).
 */
function componentRouteTimeout(laneMs: number, handlerTimeoutMs: number): number {
  if (handlerTimeoutMs === 0) return 0;
  return Math.min(laneMs + handlerTimeoutMs, MAX_TIMEOUT_MS);
}

/**
 * The registrars' contributions by precedence: mounts, routes under
 * `/_jsails`, every other route; each group in registration order.
 */
function partitionContributions(contributions: HttpContributions['routes']): {
  readonly mounts: readonly MountContribution[];
  readonly namespaced: readonly RouteContribution[];
  readonly others: readonly RouteContribution[];
} {
  const mounts: MountContribution[] = [];
  const namespaced: RouteContribution[] = [];
  const others: RouteContribution[] = [];
  for (const contribution of contributions) {
    if (contribution.type === 'mount') mounts.push(contribution);
    else if (inNamespace(contribution.path)) namespaced.push(contribution);
    else others.push(contribution);
  }
  return { mounts, namespaced, others };
}

/** Register one registrar route or mount. */
function registerContribution(
  register: RegisterRoute,
  contribution: RouteContribution | MountContribution,
): void {
  const { owner, origin, access, credentials, body, timeoutMs } = contribution;
  const limits = {
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  if (contribution.type === 'mount') {
    const { handler } = contribution;
    register(
      {
        kind: 'mount',
        pattern: contribution.prefix,
        methods: HTTP_METHODS,
        access,
        credentials,
        surface: 'route',
        ...limits,
        owner,
        origin,
      },
      { middleware: [], terminal: ({ request }) => handler(request) },
    );
    return;
  }
  const { handler, stream } = contribution;
  register(
    {
      kind: 'api',
      pattern: contribution.path,
      methods: contribution.methods,
      access,
      credentials,
      surface: contribution.surface,
      ...(contribution.cache === undefined ? {} : { cache: contribution.cache }),
      ...limits,
      ...(stream === undefined ? {} : { stream }),
      owner,
      origin,
    },
    {
      middleware: contribution.middleware,
      terminal: (_routed, context) => handler(context),
    },
  );
}

/**
 * Load every module rendering a page needs (its layouts and error boundary;
 * the page module itself loaded at registration) and each not-found page.
 */
async function preloadPages(renderer: PageRenderer, manifest: RouteManifest): Promise<void> {
  const preload = renderer.preload;
  if (preload === undefined) return;
  const entries = [
    ...manifest.entries.filter((entry) => entry.kind === 'page'),
    ...(manifest.notFound ?? []).map((match) => notFoundRouteEntry(match)),
  ];
  await Promise.all(entries.map((entry) => preload.call(renderer, entry)));
}

/** What `createApp` resolves for route registration, beyond the shared options. */
interface RoutingOptions {
  readonly routes: HttpContributions['routes'];
  readonly transforms: HttpContributions['transforms'];
  readonly rateLimit: RouteRateLimit | undefined;
  readonly pluginOrigins: PluginOrigins;
  readonly preloadModules: boolean;
}

/** Validate the routing options: contributions, rate limit, origins, preload. */
function resolveRouting(options: AppOptions): RoutingOptions {
  if (options.rateLimit !== undefined && typeof options.rateLimit !== 'function') {
    throw new TypeError('rateLimit must be a function');
  }
  const pluginOrigins = options.pluginOrigins ?? 'code-only';
  if (pluginOrigins !== 'code-only' && pluginOrigins !== 'allow-managed') {
    throw new TypeError("pluginOrigins must be 'code-only' or 'allow-managed'");
  }
  const preloadModules = options.preloadModules ?? isProductionNodeEnv(process.env.NODE_ENV);
  if (typeof preloadModules !== 'boolean') {
    throw new TypeError('preloadModules must be a boolean');
  }
  const contributions = options.contributions;
  if (
    contributions !== undefined &&
    (contributions === null ||
      typeof contributions !== 'object' ||
      !Array.isArray(contributions.routes) ||
      !Array.isArray(contributions.transforms))
  ) {
    throw new TypeError('contributions must carry routes and transforms arrays');
  }
  for (const { owner, kinds } of contributions?.transforms ?? []) {
    if (!isTransformKinds(kinds)) {
      throw new RouteErrors.Error('invalid_route', {
        owner: ownerSlot(owner),
        problem: 'invalid_transform_kinds',
      });
    }
  }
  if (pluginOrigins === 'code-only') {
    for (const { origin, owner } of contributions?.transforms ?? []) {
      if (origin === 'managed-plugin') {
        throw new RouteErrors.Error('managed_transform_refused', { owner });
      }
    }
  }
  return {
    routes: contributions?.routes ?? [],
    transforms: contributions?.transforms ?? [],
    rateLimit: options.rateLimit,
    pluginOrigins,
    preloadModules,
  };
}

function resolveOptions(options: AppOptions): ResolvedOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createApp requires an options object');
  }
  const { manifest } = options;
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
    throw new TypeError('createApp requires a manifest with an entries array');
  }
  // Bounded like a route's own cap: a request declaring more than
  // MAX_ROUTE_BODY_BYTES is refused before routing, so a larger app-wide cap
  // would let only a chunked body through.
  const maxBodyBytes = validateBodyLimit(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  if (!isTimeoutMs(handlerTimeoutMs)) {
    throw new TypeError('handlerTimeoutMs must be an integer from 0 to 2147483647');
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
  if (options.resolveSession !== undefined && options.identity !== undefined) {
    throw new TypeError('resolveSession and identity are mutually exclusive');
  }
  for (const [name, value] of [
    ['resolveSession', options.resolveSession],
    ['onError', options.onError],
    ['errorPage', options.errorPage],
  ] as const) {
    if (value !== undefined && typeof value !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
  const { streamTimeoutMs } = resolveRenderOptions(options.render);
  const readiness = resolveReadiness(options.readiness);
  const renderer = resolveRenderer(options.renderer);
  // On a shared path a plain GET would answer liveness, so a probe aimed at
  // `readiness.path` could never see a failure.
  if (readiness?.path !== undefined && readiness.path === options.healthPath) {
    throw new TypeError('readiness.path must differ from healthPath');
  }

  return {
    manifest,
    identity: resolveIdentity(options),
    renderer,
    services: resolveServices(options.services),
    guards: resolveGuards(options.guards),
    scopes: resolveRequestScopes(options.requestScopes),
    maxBodyBytes,
    handlerTimeoutMs,
    originPolicy: resolveOriginPolicy(options.server),
    // Anything but exactly `true` keeps inbound traces untrusted.
    trustInboundTrace: options.telemetry?.trustInbound === true,
    assets: resolveAssets(options.assets),
    healthPath: options.healthPath,
    storagePath: options.storagePath,
    seo: options.seo,
    introspect: options.introspect,
    ...(options.systemChecks !== undefined ? { systemChecks: options.systemChecks } : {}),
    readiness,
    reportError: createRequestErrorReporter(options.onError),
    errorPage: resolveErrorPage(options, manifest, renderer),
    ...(options.localeOptions !== undefined ? { localeOptions: options.localeOptions } : {}),
    ...(streamTimeoutMs !== undefined ? { streamTimeoutMs } : {}),
  };
}

/** The identity source: the `identity` option, or the adapter over `resolveSession`. */
function resolveIdentity(options: AppOptions): IdentitySource | undefined {
  if (options.resolveSession !== undefined) return sessionIdentitySource(options.resolveSession);
  const identity: unknown = options.identity;
  if (identity === undefined) return undefined;
  if (
    identity === null ||
    typeof identity !== 'object' ||
    typeof (identity as { hasCredential?: unknown }).hasCredential !== 'function' ||
    typeof (identity as { resolve?: unknown }).resolve !== 'function'
  ) {
    throw new TypeError('identity must implement hasCredential(request) and resolve(request)');
  }
  return identity as IdentitySource;
}

/** Validate the optional `render` option and read its streaming settings. */
function resolveRenderOptions(value: unknown): { readonly streamTimeoutMs?: number } {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object') {
    throw new TypeError('render must be an object');
  }
  const { stream, streamTimeoutMs } = value as { stream?: unknown; streamTimeoutMs?: unknown };
  // The app-wide switch is gone: pages are buffered and opt in one by one.
  if (stream !== undefined) {
    throw new TypeError('render.stream is not an option; a page exports stream = true');
  }
  if (
    streamTimeoutMs !== undefined &&
    (typeof streamTimeoutMs !== 'number' ||
      !Number.isInteger(streamTimeoutMs) ||
      streamTimeoutMs <= 0 ||
      // Node clamps a setTimeout delay above 2^31 - 1 to 1 ms.
      streamTimeoutMs > 2_147_483_647)
  ) {
    throw new TypeError('render.streamTimeoutMs must be a positive integer up to 2147483647');
  }
  return streamTimeoutMs !== undefined ? { streamTimeoutMs } : {};
}

/**
 * The app's error page with the manifest's `not-found` pages wired in: a 404
 * for a browser navigation renders the nearest one through the structured
 * renderer, and everything else still reaches `options.errorPage`. Without a
 * renderer or a not-found page, `options.errorPage` is returned unchanged.
 */
function resolveErrorPage(
  options: AppOptions,
  manifest: RouteManifest,
  renderer: PageRenderer | undefined,
): ErrorPageRenderer | undefined {
  if (renderer === undefined) return options.errorPage;
  return createNotFoundErrorPage({
    manifest,
    renderer,
    ...(options.errorPage !== undefined ? { fallback: options.errorPage } : {}),
    ...(options.localeOptions !== undefined ? { locales: options.localeOptions.locales } : {}),
  });
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

/** Validate an optional asset index by the members the pipeline reads. */
function resolveAssets(value: unknown): AssetIndex | undefined {
  if (value === undefined) return undefined;
  const members = ['get', 'url', 'paths', 'onChange'] as const;
  if (
    value === null ||
    typeof value !== 'object' ||
    members.some((member) => typeof (value as Record<string, unknown>)[member] !== 'function')
  ) {
    throw new TypeError('assets must be an asset index (createAssetIndex)');
  }
  return value as AssetIndex;
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

/**
 * Compile the optional `server` origin config; a bad value is a value-free
 * TypeError. The proxy-trust diagnostic rides on the policy, so whichever
 * stage resolves a request through it reports, once per process, a proxy in
 * front of the app that the trust setting does not match.
 */
function resolveOriginPolicy(value: unknown): OriginPolicy {
  if (value !== undefined && (value === null || typeof value !== 'object')) {
    throw new TypeError('server must be an object');
  }
  let policy: OriginPolicy;
  try {
    policy = createOriginPolicy(value);
  } catch (error) {
    if (error instanceof RequestOriginConfigError) throw new TypeError(error.message);
    throw error;
  }
  return observeRequestOrigins(
    policy,
    createProxyDiagnostic({
      trustedProxies: policy.trustedProxies,
      production: isProductionNodeEnv(process.env.NODE_ENV),
    }),
  );
}
