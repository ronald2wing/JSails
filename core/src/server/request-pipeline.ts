/**
 * Shared request-pipeline primitives for the HTTP assembly.
 *
 * This module is the leaf of the `server` package's dependency graph: the
 * assembly (`app.ts`), the filesystem API registration (`api-routes.ts`), and
 * the page registration (`page-routes.ts`) all import from it, while it never
 * imports back (its only reference to `app.ts` is the type-only
 * `Authorize`/`RenderPage`/`ResolveSession` contract, erased at compile time).
 * It holds the API method/CSRF constants, the first pipeline stage (request
 * origin and client address), per-request {@link RequestContext} construction,
 * and session resolution, so no route module has to import the assembly that
 * imports it. The JSON error envelope itself lives in
 * `api/error-response.ts`, because the browser-safe `jsails/api` uses it too.
 */

import type { HttpExtensionHook } from '../extensions/extension.js';
import type { ServiceRegistry } from '../extensions/services.js';
import {
  HttpError,
  type AssetUrlResolver,
  type Authorize,
  type RenderPage,
  type RequestContext,
  type ResolveSession,
  type Session,
} from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';
import type { RouteManifest } from '../routing/routes.js';
import type { AppContext, AppMiddlewareHandler, HttpVariables } from './env.js';
import type {
  RequestErrorInfo,
  RequestErrorPhase,
  RequestErrorReporter,
} from './request-errors.js';
import { currentRequestId } from './request-scope.js';
import type { RouteScopeRunner } from './route-scopes.js';
import type { ResolvedReadiness } from './readiness.js';
import type { ErrorPageRenderer } from './error-pages.js';

// CSRF primitives for the per-route middleware factory.
import { assertCsrfToken, CSRF_HEADER } from '../security/index.js';
import {
  checkRequestOrigin,
  isHeaderAuthenticatedSession,
  isUnsafeMethod,
} from '../security/trusted-mutation.js';
import {
  canonicalizeForwardingHeaders,
  resolveRequestOrigin,
  type ClientAddress,
  type OriginPolicy,
  type RequestOrigin,
} from '../security/request-origin.js';
import { detach, escalate } from '../support/detach.js';

/** HTTP method names recognized as API handler exports. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

/** Request header carrying the session-bound CSRF token on mutations. */
export { CSRF_HEADER } from '../security/index.js';

import type { IntrospectRouteConfig } from '../introspect/route.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { jsonError } from '../api/error-response.js';
import type { SystemCheckRegistry } from '../database/system-checks.js';

/** Options resolved and validated by `createApp`; shared by every route module. */
export interface ResolvedOptions {
  readonly manifest: RouteManifest;
  readonly authorize: Authorize | undefined;
  readonly resolveSession: ResolveSession | undefined;
  readonly renderPage: RenderPage | undefined;
  readonly renderer: PageRenderer | undefined;
  readonly services: ServiceRegistry | undefined;
  readonly httpHooks: readonly HttpExtensionHook[];
  readonly maxBodyBytes: number;
  /** The compiled `server` origin config the first stage resolves every request against. */
  readonly originPolicy: OriginPolicy;
  readonly assetUrl: AssetUrlResolver | undefined;
  readonly healthPath: string | undefined;
  readonly storagePath: string | undefined;
  readonly seo: SeoRuntimeOptions | undefined;
  readonly introspect: IntrospectRouteConfig | undefined;
  /** Optional system-check registry for the deep health probe. */
  readonly systemChecks?: SystemCheckRegistry;
  /** Validated readiness probes and their gate, when configured. */
  readonly readiness: ResolvedReadiness | undefined;
  /** Reports every unexpected failure: the app's `onError`, or the stderr logger. */
  readonly reportError: RequestErrorReporter;
  /** The app's HTML error-page renderer for browser navigations, when given. */
  readonly errorPage: ErrorPageRenderer | undefined;
  /**
   * Resolved global middleware chain, applied to every request after the
   * authorize gates and before per-route middleware. Built by the application
   * layer from config `globalMiddleware` refs (resolved against the named
   * registry) followed by extension `configureMiddleware` handlers in setup
   * order. An empty array means no global middleware runs.
   */
  readonly globalMiddleware: readonly AppMiddlewareHandler[];
  /**
   * Named middleware map for resolving string refs at registration time.
   * Built by the application layer from config `middleware` entries.
   */
  readonly middlewareMap: Readonly<Record<string, AppMiddlewareHandler>>;
  /**
   * The extension request scopes composed into one runner; it calls straight
   * through when none is registered. Applied around every framework route.
   */
  readonly runScopes: RouteScopeRunner;
  /**
   * {@link runScopes} as a chain stage for the page and API chains, or
   * `undefined` when no scope is registered so those chains gain no stage.
   */
  readonly scopeMiddleware: AppMiddlewareHandler | undefined;
  /** Locale-prefixed routing: locales to register as `/{locale}` aliases. */
  readonly localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string };
  /** Whether structured-renderer pages stream by default (a page export overrides it). */
  readonly streamPages?: boolean;
  /** Milliseconds a streamed page's suspended subtrees have to finish after the shell. */
  readonly streamTimeoutMs?: number;
}

/** Inputs to {@link createRequestContext}; each field maps to one context field. */
interface BuildContextInput {
  readonly request: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly session: Session | null;
  readonly origin?: RequestOrigin;
  readonly client?: ClientAddress;
  readonly services?: ServiceRegistry;
  readonly assetUrl?: AssetUrlResolver;
  readonly storagePath?: string;
  readonly seo?: SeoRuntimeOptions;
  readonly locale?: string;
}

/**
 * Build a {@link RequestContext} from a resolved request, URL, params, and
 * session, attaching the optional `origin`/`client`/`services`/`assetUrl`/
 * `storagePath` fields only when they are defined.
 */
export function createRequestContext(input: BuildContextInput): RequestContext {
  return {
    request: input.request,
    url: input.url,
    params: input.params,
    session: input.session,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.client === undefined ? {} : { client: input.client }),
    ...(input.services === undefined ? {} : { services: input.services }),
    ...(input.assetUrl === undefined ? {} : { assetUrl: input.assetUrl }),
    ...(input.storagePath === undefined ? {} : { storagePath: input.storagePath }),
    ...(input.seo === undefined ? {} : { seo: input.seo }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  };
}

/**
 * The first pipeline stage: resolve the origin the request was addressed to
 * and the client that sent it (see `security/request-origin.ts`), before any
 * other stage runs. A host the app does not serve is answered 421 here, so it
 * costs no other stage anything, except on a GET or HEAD for one of
 * `probePaths` (the health and readiness paths), which a deploy tool sends to
 * the container's own address. Otherwise the request's forwarding headers
 * are rewritten to the resolved client, and `c.var.origin`, `c.var.client`,
 * and `c.var.relayed` are set for every later stage and route.
 */
export function createRequestOriginStage(
  policy: OriginPolicy,
  probePaths: ReadonlySet<string> = new Set(),
): AppMiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    const resolved = resolveRequestOrigin(
      {
        peer: socketPeer(c.env),
        url: requestUrl(c),
        headers: c.req.raw.headers,
        probe: (method === 'GET' || method === 'HEAD') && probePaths.has(c.req.path),
      },
      policy,
    );
    if ('refused' in resolved) {
      return jsonError(421, 'misdirected_request', 'Misdirected Request', {}, MISDIRECTED_HEADERS);
    }
    canonicalizeForwardingHeaders(c.req.raw.headers, resolved);
    c.set('origin', resolved.origin);
    c.set('client', resolved.client);
    c.set('relayed', resolved.relayed);
    await next();
  };
}

/** Headers of the 421 answer, which no later stage decorates. */
const MISDIRECTED_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** The TCP peer the Node adapter exposes on `env.incoming.socket`; absent in-process. */
function socketPeer(env: unknown): string | undefined {
  if (env === null || typeof env !== 'object') return undefined;
  const incoming = (env as { incoming?: unknown }).incoming;
  if (incoming === null || typeof incoming !== 'object') return undefined;
  const socket = (incoming as { socket?: unknown }).socket;
  if (socket === null || typeof socket !== 'object') return undefined;
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  return typeof address === 'string' && address !== '' ? address : undefined;
}

/**
 * The request URL, parsed once per request and shared by every stage that
 * needs it. `c.req.url` never changes during a request, so the cached copy
 * cannot go stale.
 */
export function requestUrl(c: AppContext): URL {
  const cached = c.get('requestUrl');
  if (cached !== undefined) return cached;
  const url = new URL(c.req.url);
  c.set('requestUrl', url);
  return url;
}

/**
 * The route pattern the current handler was registered under (`/users/:id`),
 * never the concrete path, so observers can group by route without recording
 * path-embedded identifiers or tokens. `*` when no route pattern applies.
 */
export function matchedRoutePattern(c: AppContext): string {
  const route = c.req.routePath;
  return route === '' ? '*' : route;
}

/**
 * Build a sovereign {@link RequestContext} from a Hono {@link AppContext} and
 * the per-request variables stored on `c.var` by the pipeline middleware.
 *
 * This is the SINGLE terminal adapter — every page and API handler sees
 * {@link RequestContext}, never Hono's `Context`. The context is built once
 * per request and reused by the later stages (signals, authorize gates, the
 * handler) for as long as the session, locale, and matched route it was built
 * from are unchanged.
 */
export function createRequestContextFromStore(c: AppContext, vars: HttpVariables): RequestContext {
  const route = c.req.routePath;
  const cached = c.get('requestContext');
  if (
    cached !== undefined &&
    cached.session === vars.session &&
    cached.locale === vars.locale &&
    cached.route === route
  ) {
    return cached.context;
  }
  const context = createRequestContext({
    request: c.req.raw,
    url: requestUrl(c),
    params: { ...c.req.param() },
    session: vars.session,
    services: vars.services,
    assetUrl: vars.assetUrl,
    storagePath: vars.storagePath,
    seo: vars.seo,
    origin: vars.origin,
    client: vars.client,
    locale: vars.locale,
  });
  c.set('requestContext', { context, session: vars.session, locale: vars.locale, route });
  return context;
}

/**
 * Resolve the session for a request, failing closed to `null`. A throwing
 * resolver (a session store outage) is handed to `onError` so the outage is
 * visible rather than every visitor silently becoming anonymous.
 */
export async function resolveSessionOrNull(
  resolveSession: ResolveSession | undefined,
  request: Request,
  onError?: (error: unknown) => void | Promise<void>,
): Promise<Session | null> {
  if (resolveSession === undefined) return null;
  try {
    return (await resolveSession(request)) ?? null;
  } catch (error) {
    if (onError !== undefined) detach(onError(error), escalate);
    return null;
  }
}

/**
 * The request's session, resolved on first use and memoized for the rest of
 * the request (see `loadSession` in `env.ts`). Every framework route chain
 * calls this on entry, so `c.var.session` is current before CSRF, authorize,
 * middleware, and handlers read it.
 */
export async function ensureRequestSession(c: AppContext): Promise<Session | null> {
  const load = c.var.loadSession;
  const session = load === undefined ? null : await load();
  c.set('session', session);
  return session;
}

/** The request facts an error report carries: method, route pattern, request id. */
export function requestErrorInfo(c: AppContext, phase: RequestErrorPhase): RequestErrorInfo {
  return {
    phase,
    method: c.req.method,
    route: matchedRoutePattern(c),
    requestId: currentRequestId(),
  };
}

/** Map a thrown authorization/CSRF error to a sanitized response. */
export function toAuthErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message);
  }
  return jsonError(403, 'forbidden', 'Forbidden');
}

/**
 * Build the shared 405 response with a matching `Allow` header and body field,
 * used by both the `methodNotAllowed` middleware and the HEAD-only GET fallback
 * so the two never disagree on the advertised methods.
 */
export function methodNotAllowedResponse(allow: string): Response {
  return jsonError(405, 'method_not_allowed', 'Method Not Allowed', { allow }, { allow });
}

/**
 * Build a per-route CSRF middleware for API routes, applied to every unsafe
 * method (anything but GET/HEAD/OPTIONS). The origin check runs with or
 * without a session (see `checkRequestOrigin`): an anonymous cross-site POST to
 * a sign-in or sign-up route is login CSRF, so it is refused like any other.
 * A request with a session must also carry its CSRF token. A rejection returns
 * a 403 JSON envelope and short-circuits the chain.
 *
 * A session the resolver marked as header-authenticated (`authMethod` of
 * `bearer` or `api-token`) passes both checks: a browser never attaches such a
 * credential to a cross-site request on its own, so CSRF cannot apply, and a
 * CLI or API client has no `Origin` or CSRF token to send. A cookie session,
 * or one without the marker, keeps both checks.
 */
export function createCsrfMiddleware(): AppMiddlewareHandler {
  return async (c, next) => {
    if (!isUnsafeMethod(c.req.method)) return next();
    const session = c.get('session') ?? null;
    if (session !== null && isHeaderAuthenticatedSession(session)) return next();
    const request = c.req.raw;
    const origin = checkRequestOrigin(request, session, c.var.origin.origin);
    if (!origin.allowed) {
      return jsonError(origin.status, origin.code, origin.message);
    }
    if (session === null) return next();
    try {
      assertCsrfToken(session, request.headers.get(CSRF_HEADER));
    } catch (error) {
      return toAuthErrorResponse(error);
    }
    return next();
  };
}

/**
 * Build an authorization-gate middleware: it calls `authorize(context)` where
 * `context` is built from Hono's `c.var`. A result of exactly `true` allows the
 * chain to continue; any other result (false, throw, rejection, truthy
 * non-boolean) short-circuits with a 403 JSON envelope. A missing `authorize`
 * (default-deny) always short-circuits.
 */
export function createAuthorizeMiddleware(
  authorize: Authorize | undefined,
  reportError?: RequestErrorReporter,
): AppMiddlewareHandler {
  if (authorize === undefined) {
    return async (_c, _next) => jsonError(403, 'forbidden', 'Forbidden');
  }
  return async (c, next) => {
    const ctx = createRequestContextFromStore(c, c.var);
    try {
      const allowed = await authorize(ctx);
      if (allowed !== true) {
        return jsonError(403, 'forbidden', 'Forbidden');
      }
    } catch (error) {
      // Still a deny, but a throwing authorize is a fault (a policy store
      // outage), not a decision, so it is reported rather than swallowed.
      if (reportError !== undefined)
        detach(reportError(error, requestErrorInfo(c, 'authorize')), escalate);
      return jsonError(403, 'forbidden', 'Forbidden');
    }
    return next();
  };
}
