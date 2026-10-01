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
 * The declaration covers only a successful (or deliberately cacheable)
 * answer to an anonymous request: an error status, a request that resolved a
 * session, and a request carrying `Authorization` stay private, because a
 * shared cache would replay a transient failure or one caller's
 * representation to everyone.
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
 *   forces `Cache-Control: private, no-store` even if the route or a hook
 *   already set a public header, adds `Cookie` to `Vary`, and drops
 *   `Surrogate-Control` so a shared cache never stores session data.
 * - Otherwise sets `Cache-Control: private, no-store` unless the handler already
 *   set one.
 */
export function applyDefaultCacheControl(headers: Headers): void {
  // Session-derived data must never be served from a shared cache, overriding
  // any route-level public declaration, so the surrogate directive goes too.
  // `Vary` is extended, not replaced: the handler's own entries (`Origin` on a
  // CORS response) still describe the representation.
  if (headers.has('set-cookie')) {
    headers.set('cache-control', 'private, no-store');
    headers.delete('surrogate-control');
    appendVary(headers, 'Cookie');
    return;
  }

  if (headers.has('cache-control')) return;

  headers.set('cache-control', 'private, no-store');
}

/**
 * Add `field` to the response's `Vary` list unless it is already there
 * (compared case-insensitively) or the list is `*`, which already varies on
 * everything.
 */
export function appendVary(headers: Headers, field: string): void {
  const current = headers.get('vary');
  if (current === null || current.trim() === '') {
    headers.set('vary', field);
    return;
  }
  const fields = current.split(',').map((entry) => entry.trim().toLowerCase());
  if (fields.includes('*') || fields.includes(field.toLowerCase())) return;
  headers.set('vary', `${current}, ${field}`);
}

/**
 * Statuses a declared public policy may apply to: the successful answers and
 * the permanent ones a shared cache may store by default (RFC 9111 §4.2.2).
 * Anything else — a 5xx, a 401/403, a temporary redirect — is a transient or
 * caller-specific answer that must not be replayed to every visitor.
 */
const PUBLIC_CACHEABLE_STATUSES: ReadonlySet<number> = new Set([
  200, 203, 204, 206, 301, 308, 404, 410,
]);

/**
 * Apply public caching headers to a response based on a route's
 * `cacheControl` declaration. Called by the route handler (not the global
 * middleware) when a page or API module exports `cacheControl`.
 *
 * Returns a new Response with updated headers. The original response is
 * never mutated. Does nothing — leaving the response to the default-deny
 * `private, no-store` — for non-GET/HEAD requests, responses that already set
 * Cache-Control, responses carrying a Set-Cookie header, a status outside
 * {@link PUBLIC_CACHEABLE_STATUSES}, requests that resolved a session, and
 * requests carrying an `Authorization` header: the handler may have rendered
 * per-user data that a shared cache would otherwise replay to everyone.
 */
export interface WrapPublicResponseOptions {
  readonly declaration: CacheControlDeclaration;
  readonly method: string;
  /** The session the request resolved, if any; a session forces private. */
  readonly session?: unknown;
  /** The request's headers; an `Authorization` header forces private. */
  readonly requestHeaders: Headers;
}

export function wrapPublicResponse(
  response: Response,
  { declaration, method, session = null, requestHeaders }: WrapPublicResponseOptions,
): Response {
  // Only GET and HEAD are eligible for public shared-cache storage.
  if (method !== 'GET' && method !== 'HEAD') return response;

  // A transient failure or a caller-specific status must not be stored for
  // the declared lifetime and served to every visitor.
  if (!PUBLIC_CACHEABLE_STATUSES.has(response.status)) return response;

  // A header-authenticated request (a bearer token, Basic credentials) may
  // be answered with that caller's data even when no session resolved.
  if (requestHeaders.has('authorization')) return response;

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
