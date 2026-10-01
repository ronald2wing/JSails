/**
 * Hono environment types for the JSails HTTP pipeline.
 *
 * `HttpVariables` holds per-request values set by pipeline middleware via
 * `c.set(...)`. The terminal handler maps `c.var` plus `c.req.*` to the
 * sovereign {@link RequestContext} — a single adapter that lives in
 * `request-pipeline.ts` so Hono's `Context` never leaks into the authoring
 * surface.
 *
 * This module has zero runtime deps — only `import type` from Hono and the
 * JSails contracts — so `routing/middleware.ts` can import from it with no
 * cycle risk.
 */

import type { Context, MiddlewareHandler } from 'hono';

import type { ServiceRegistry } from '../extensions/services.js';
import type { AssetUrlResolver, RequestContext, Session } from '../contracts/http.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import type { ClientAddress, RequestOrigin } from '../security/request-origin.js';

/**
 * A {@link RequestContext} built for this request, with the inputs that can
 * change between pipeline stages. It is reused while all three are unchanged:
 * a middleware that swaps the session, or a different route's chain, gets a
 * fresh one.
 */
export interface CachedRequestContext {
  readonly context: RequestContext;
  readonly session: Session | null;
  readonly locale: string | undefined;
  readonly route: string;
}

/**
 * Per-request values stored on `c.var` by pipeline middleware stages.
 * `request` and `params` come from `c.req.*` and are not stored here. The
 * parsed URL and the built {@link RequestContext} are cached so the signals,
 * CSRF, authorize, and terminal stages of one request share a single copy.
 */
export interface HttpVariables {
  /**
   * The resolved session, or null when unauthenticated or not yet resolved.
   * Resolution is lazy: framework route chains (API, page, server-component)
   * resolve it on entry, so it is current wherever route middleware, authorize,
   * and handlers run. Code mounted through an HTTP extension hook awaits
   * `loadSession()` instead of reading this field.
   */
  session: Session | null;
  /**
   * Resolve the request's session on first call and return the same promise on
   * every later call, so a request costs at most one session-store lookup and
   * a request that never asks (a static file, the health probe) costs none.
   */
  loadSession?: () => Promise<Session | null>;
  /** Read-only service registry, when the host wired one in. */
  services?: ServiceRegistry;
  /**
   * The origin the request was addressed to, set by the first pipeline stage
   * before anything else runs (see `security/request-origin.ts`).
   */
  origin: RequestOrigin;
  /** The client that sent the request, set by the first pipeline stage. */
  client: ClientAddress;
  /** True when the request arrived carrying forwarding headers (before they were canonicalized). */
  relayed: boolean;
  /** Asset-URL resolver, when the host wired one in. */
  assetUrl?: AssetUrlResolver;
  /** Persistent-storage directory, when the host wired one in. */
  storagePath?: string;
  /** SEO runtime options, when the host wired them in. */
  seo?: SeoRuntimeOptions;
  /**
   * Set once the extension request scopes wrap this request, so a nested
   * scoped handler does not run them a second time (see `route-scopes.ts`).
   */
  requestScoped?: boolean;
  /** Resolved request locale, when the i18n plugin is active. */
  locale?: string;
  /** The request URL, parsed on first use (see `requestUrl` in `request-pipeline.ts`). */
  requestUrl?: URL;
  /** The request context, built on first use (see `createRequestContextFromStore`). */
  requestContext?: CachedRequestContext;
}

/** Hono env for the JSails pipeline. */
export type AppEnv = { Variables: HttpVariables };

/** Hono `Context` typed for the JSails pipeline. */
export type AppContext = Context<AppEnv>;

/** Hono `MiddlewareHandler` typed for the JSails pipeline. */
export type AppMiddlewareHandler = MiddlewareHandler<AppEnv>;
