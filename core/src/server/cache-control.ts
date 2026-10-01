/**
 * The one cache policy: who may store a response, decided once per response
 * by the finalizer (`output.ts`).
 *
 * Every response is `Cache-Control: private, no-store` unless one of two
 * things says otherwise: the handler set its own `Cache-Control`, or the
 * route declared itself publicly cacheable with an exported `cacheControl`
 * object and the answer qualifies. A qualifying answer gets
 * `Cache-Control: public, max-age=0, s-maxage=<n>, stale-while-revalidate=<n>`
 * and `Surrogate-Control: max-age=<n>, stale-while-revalidate=<n>`.
 *
 * An answer qualifies only when a shared cache could replay it to anyone who
 * sends the same URL: a GET or HEAD (never a mutation, the Web Cache
 * Deception guard), a status a cache may store by default (200, 203, 204,
 * 301, 308: never an error or a temporary redirect), no `Set-Cookie`, an
 * admission the access chain calls publicly cacheable (a public surface and
 * an anonymous caller: `isPubliclyCacheable`, the only access fact this
 * policy reads), or nothing claimed and no credential on the request, no
 * `Authorization` header, no bound
 * scope of cache class `private`, every cache partition taken from the host
 * or the path, a locale not read from a cookie,
 * no request `Cache-Control: no-store`, no `Vary: *`, and not a live stream.
 *
 * `Set-Cookie` always wins: it forces `private, no-store` over any
 * declaration or handler header, drops `Surrogate-Control`, and adds `Cookie`
 * to `Vary`. Every `Vary` write goes through {@link appendVary}, so a
 * handler's own entries (`Origin` on a CORS answer) are never lost.
 */

import { JsailsError } from '../errors/jsails-error.js';
import { isPubliclyCacheable, type Admitted } from '../security/access-record.js';
import type { ClaimedScope } from './request-frame.js';

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
 * Statuses a declared public policy may apply to: the successful and
 * permanent answers a shared cache may store by default (RFC 9111 §4.2.2),
 * minus 206 (a range is not the whole representation) and the negative
 * answers (404, 410), which would pin a transient miss for the declared
 * lifetime.
 */
const PUBLIC_STATUSES: ReadonlySet<number> = new Set([200, 203, 204, 301, 308]);

const NO_STORE = /(?:^|,)\s*no-store\s*(?:,|$)/i;

/** The response a policy is decided for: its status, its adopted headers, and its body kind. */
export interface CacheDraft {
  readonly status: number;
  readonly headers: Headers;
  /** The body never ends on its own (server-sent events). */
  readonly live: boolean;
}

/** What the policy reads about the request. */
export interface CacheRequestFacts {
  readonly request: Request;
  /**
   * Whether the request carries a credential the identity source reads; asked
   * only for an answer no claim stands behind.
   */
  readonly credentialed: () => boolean;
}

/** What an answer that may not be stored carries: the policy's default, and every failure's. */
export const PRIVATE_NO_STORE = 'private, no-store';

/**
 * Decide `draft`'s cache policy in place: `Set-Cookie` forces private; a
 * handler's own `Cache-Control` stands; a qualifying answer of a route that
 * declared `declaration` is public, provided the access chain's admission
 * (`admitted`) is publicly cacheable (a public surface, an anonymous
 * caller); everything else is `private, no-store`. A storable answer also
 * varies on the request headers its locale was negotiated from.
 */
export function decideCache(
  declaration: CacheControlDeclaration | undefined,
  draft: CacheDraft,
  claimed: ClaimedScope | undefined,
  admitted: Admitted | undefined,
  facts: CacheRequestFacts,
): void {
  const headers = draft.headers;
  if (headers.has('set-cookie')) {
    headers.set('cache-control', PRIVATE_NO_STORE);
    headers.delete('surrogate-control');
    appendVary(headers, 'Cookie');
    return;
  }
  if (!headers.has('cache-control')) {
    if (declaration === undefined || !mayBeShared(draft, claimed, admitted, facts)) {
      headers.set('cache-control', PRIVATE_NO_STORE);
      return;
    }
    const swr = declaration.staleWhileRevalidate ?? 0;
    headers.set(
      'cache-control',
      `public, max-age=0, s-maxage=${declaration.maxAge}, stale-while-revalidate=${swr}`,
    );
    headers.set(
      'surrogate-control',
      `max-age=${declaration.maxAge}, stale-while-revalidate=${swr}`,
    );
  }
  if (isStorable(headers)) {
    for (const field of claimed?.locale?.vary ?? []) appendVary(headers, field);
  }
}

/** True when the final policy lets some cache store the response. */
export function isStorable(headers: Headers): boolean {
  return !NO_STORE.test(headers.get('cache-control') ?? '');
}

/** Whether a shared cache may replay this answer to everyone asking for its URL. */
function mayBeShared(
  draft: CacheDraft,
  claimed: ClaimedScope | undefined,
  admitted: Admitted | undefined,
  { request, credentialed }: CacheRequestFacts,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!PUBLIC_STATUSES.has(draft.status) || draft.live) return false;
  if ((draft.headers.get('vary') ?? '').trim() === '*') return false;
  const requestHeaders = request.headers;
  if (requestHeaders.has('authorization')) return false;
  if (NO_STORE.test(requestHeaders.get('cache-control') ?? '')) return false;
  if (claimed === undefined) return !credentialed();
  if (admitted === undefined || !isPubliclyCacheable(admitted)) return false;
  if (claimed.privateScope) return false;
  if (claimed.locale?.cookie === true) return false;
  return claimed.partitions.every(
    (partition) => partition.from === 'host' || partition.from === 'path',
  );
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
