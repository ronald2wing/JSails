/**
 * Default-deny HTTP cache-control middleware.
 *
 * Every framework-owned response receives `Cache-Control: private, no-store`
 * unless a route module explicitly declares itself cacheable via an exported
 * `cacheControl` object. A route that opts in to public caching emits
 * `Cache-Control: public, max-age=0, s-maxage=<n>, stale-while-revalidate=<n>`
 * plus `Surrogate-Control: max-age=<n>, stale-while-revalidate=<n>` and
 * `Vary: Accept-Encoding` (never `Vary: Cookie`, which would fragment a shared
 * cache key). A response carrying a `Set-Cookie` header (session-derived data)
 * is always private, overriding any route-level declaration — stale user data
 * must never be served from a shared cache.
 *
 * The middleware runs after handlers so an explicit `Cache-Control` header set
 * by a route or extension is never overwritten, following the same discipline
 * as the security-headers middleware — except that `Set-Cookie` always wins, as
 * above, and also drops the surrogate directive.
 *
 * Non-GET requests (POST/PUT/PATCH/DELETE) are never eligible for public
 * caching regardless of the route's declaration, matching the HTTP caching
 * spec and the Web Cache Deception guard.
 */

import { JsailsError } from '../errors/jsails-error.js';

/**
 * A route module's declarative cache-control export.
 *
 * Example:
 * ```
 * export const cacheControl = { maxAge: 300, staleWhileRevalidate: 60 };
 * ```
 */
export interface CacheControlDeclaration {
  /** Seconds for s-maxage (shared cache TTL). Must be a positive integer. */
  readonly maxAge: number;
  /** Seconds for stale-while-revalidate. Defaults to 0 when omitted. */
  readonly staleWhileRevalidate?: number;
}

/**
 * Apply default-deny cache-control to a response that has not already declared
 * its own policy. Called by the global cache-control middleware after every
 * handler runs.
 *
 * - When the response carries a `Set-Cookie` header (session-derived data),
 *   forces `Cache-Control: private, no-store` and `Vary: Cookie` even if the
 *   route or a hook already set a public header, and drops `Surrogate-Control`
 *   so a shared cache never stores session data.
 * - Otherwise sets `Cache-Control: private, no-store` unless the handler already
 *   set one.
 */
export function applyDefaultCacheControl(headers: Headers): void {
  // Session-derived data must never be served from a shared cache, overriding
  // any route-level public declaration — the public `Vary: Accept-Encoding`
  // and `Surrogate-Control` set by wrapPublicResponse are withdrawn.
  if (headers.has('set-cookie')) {
    headers.set('cache-control', 'private, no-store');
    headers.delete('surrogate-control');
    headers.set('vary', 'Cookie');
    return;
  }

  if (headers.has('cache-control')) return;

  headers.set('cache-control', 'private, no-store');
}

/**
 * Apply public caching headers to a response based on a route's
 * `cacheControl` declaration. Called by the route handler (not the global
 * middleware) when a page or API module exports `cacheControl`.
 *
 * Returns a new Response with updated headers. The original response is
 * never mutated. Does nothing for non-GET/HEAD requests, responses that
 * already set Cache-Control, responses carrying a Set-Cookie header, or
 * requests that resolved a session — a session always forces private,
 * overriding any declaration, because the handler may have rendered
 * per-user data that a shared cache would otherwise replay to everyone.
 */
export interface WrapPublicResponseOptions {
  readonly declaration: CacheControlDeclaration;
  readonly method: string;
  /** The session the request resolved, if any; a session forces private. */
  readonly session?: unknown;
}

export function wrapPublicResponse(
  response: Response,
  { declaration, method, session = null }: WrapPublicResponseOptions,
): Response {
  // Only GET and HEAD are eligible for public shared-cache storage.
  if (method !== 'GET' && method !== 'HEAD') return response;

  // An explicit header set by the handler wins.
  if (response.headers.has('cache-control')) return response;

  // Session-derived data must never be served from a shared cache. A request
  // that authenticated carries `Cookie`, not `Set-Cookie`, so the resolved
  // session is the only signal that the response may be user-specific.
  if (response.headers.has('set-cookie')) return response;
  if (session !== null && session !== undefined) return response;

  const swr = declaration.staleWhileRevalidate ?? 0;
  const headers = new Headers(response.headers);
  headers.set(
    'cache-control',
    `public, max-age=0, s-maxage=${declaration.maxAge}, stale-while-revalidate=${swr}`,
  );
  headers.set('surrogate-control', `max-age=${declaration.maxAge}, stale-while-revalidate=${swr}`);
  if (!headers.has('vary')) {
    headers.set('vary', 'Accept-Encoding');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Stable codes carried by a {@link CacheControlError}. */
type CacheControlErrorCode =
  'invalid_declaration' | 'invalid_max_age' | 'invalid_stale_while_revalidate';

/** Raised for a malformed `cacheControl` export. Value-free: the message names the route and the failing field, never the value. */
class CacheControlError extends JsailsError {
  constructor(
    readonly code: CacheControlErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Validate a page or API module's optional `cacheControl` export and return
 * the declaration, throwing a value-free error on a bad shape.
 *
 * The error message names the route and the field that fails, never echoing
 * the value itself. This matches the discipline of the module-level authorize
 * and middleware extractors in the route registration functions.
 */
export function extractCacheControlDeclaration(
  route: string,
  mod: Record<string, unknown>,
): CacheControlDeclaration | undefined {
  const exported = mod['cacheControl'];
  if (exported === undefined) return undefined;

  if (typeof exported !== 'object' || exported === null) {
    throw new CacheControlError(
      'invalid_declaration',
      `route "${route}" exports "cacheControl" as a non-object value`,
    );
  }

  const cc = exported as Record<string, unknown>;
  const maxAge = cc.maxAge;
  if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge <= 0) {
    throw new CacheControlError(
      'invalid_max_age',
      `route "${route}" cacheControl.maxAge must be a positive integer`,
    );
  }

  const swr = cc.staleWhileRevalidate;
  if (swr !== undefined) {
    if (typeof swr !== 'number' || !Number.isInteger(swr) || swr < 0) {
      throw new CacheControlError(
        'invalid_stale_while_revalidate',
        `route "${route}" cacheControl.staleWhileRevalidate must be a non-negative integer`,
      );
    }
  }

  return { maxAge, staleWhileRevalidate: swr };
}
