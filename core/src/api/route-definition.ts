/**
 * Typed route-module definitions: `defineApi` and `definePage`.
 *
 * A filesystem API module may default-export a {@link defineApi} definition
 * instead of named method exports:
 *
 * ```ts
 * export default defineApi('/api/posts/:id', {
 *   access: ({ session }) => session !== null,
 *   GET: ({ params }) => Respond.json({ id: params.id }),
 * });
 * ```
 *
 * The path is the route of the file (assembly refuses any other), so the
 * handlers' `params` are typed from it: `:name` and `*name` segments become
 * string members. `access` is required: `publicAccess(reason)`, or a check
 * that admits a request only by resolving to exactly `true`. The definition
 * also carries the credential kinds the route accepts (`credentials`, by
 * default the session cookie and a header token; `[]` for a route that reads
 * neither, such as a signed webhook, which then gets no cross-site check),
 * its public cache declaration, request body (`body`,
 * read through `ctx.body`), deadline (`timeoutMs`, and `stream.timeoutMs`
 * for a streamed answer) and middleware, the last four checked at assembly.
 * A module using `defineApi` exports nothing else.
 *
 * A page module states its access with a `route` export:
 *
 * ```ts
 * export const route = definePage('/dashboard', {
 *   access: ({ session }) => session !== null,
 * });
 * ```
 *
 * A page without one is public and its loader decides, as before. A denied
 * page request renders the error page: 401 for an anonymous caller, 403 for
 * a signed-in one. `timeoutMs` replaces the app's
 * handler deadline for the page.
 *
 * Browser-safe: plain data, no runtime dependency.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { RouteContext } from '../contracts/http.js';
import type { RouteMiddleware } from '../routing/middleware.js';
import type { BodySpec } from '../server/route-limits.js';
import type { CacheControlDeclaration } from '../server/cache-control.js';
import { isCredentialList, type CredentialKind } from '../security/credentials.js';
import { toAccessRef, type AccessRef, type RouteAccess } from './access-ref.js';

/**
 * The path params a route pattern declares: `/posts/:id/*rest` gives
 * `{ id: string; rest: string }`.
 *
 * @public
 */
export type RouteParams<P extends string> = string extends P
  ? Record<string, string>
  : P extends `${infer Head}/${infer Tail}`
    ? SegmentParam<Head> & RouteParams<Tail>
    : SegmentParam<P>;

/** The param one path segment declares, if any. */
type SegmentParam<S extends string> = S extends `:${infer Name}{${string}}`
  ? { readonly [K in Name]: string }
  : S extends `:${infer Name}`
    ? { readonly [K in Name]: string }
    : S extends `*${infer Name}`
      ? Name extends ''
        ? unknown
        : { readonly [K in Name]: string }
      : unknown;

/**
 * The request context of a `defineApi` handler, its params typed from the
 * route pattern.
 *
 * @public
 */
export interface ApiContext<P extends string> extends Omit<RouteContext, 'params'> {
  readonly params: RouteParams<P>;
}

/**
 * A `defineApi` method handler.
 *
 * @public
 */
export type ApiRouteHandler<P extends string> = (context: ApiContext<P>) => Awaitable<Response>;

/**
 * What a `defineApi` route declares.
 *
 * @public
 */
export interface ApiRouteSpec<P extends string> {
  readonly access: RouteAccess;
  /**
   * The credential kinds the route accepts (default: `['cookie', 'token']`).
   * An unsafe request to a route accepting `cookie` must come from the app's
   * own origin.
   */
  readonly credentials?: readonly CredentialKind[];
  /** A public cache declaration for the GET answers. */
  readonly cacheControl?: CacheControlDeclaration;
  /**
   * The request body the route reads (`ctx.body`) and its cap in bytes, or
   * `{ kind: 'none' }`; absent, the app-wide `maxBodyBytes` caps it.
   */
  readonly body?: BodySpec;
  /** Milliseconds the route has to answer (`0`: no deadline); absent, the app's `handlerTimeoutMs`. */
  readonly timeoutMs?: number;
  /** A streamed answer's idle bound: the most milliseconds between two chunks. */
  readonly stream?: { readonly timeoutMs: number };
  /** Middleware run in order before the handler, after the access chain. */
  readonly middleware?: readonly RouteMiddleware[];
  readonly GET?: ApiRouteHandler<P>;
  readonly HEAD?: ApiRouteHandler<P>;
  readonly POST?: ApiRouteHandler<P>;
  readonly PUT?: ApiRouteHandler<P>;
  readonly PATCH?: ApiRouteHandler<P>;
  readonly DELETE?: ApiRouteHandler<P>;
  readonly OPTIONS?: ApiRouteHandler<P>;
}

declare const apiBrand: unique symbol;
declare const pageBrand: unique symbol;

/**
 * A `defineApi` result: a module's default export.
 *
 * @public
 */
export interface ApiDefinition<P extends string = string> {
  readonly [apiBrand]: true;
  readonly path: P;
  readonly spec: ApiRouteSpec<P>;
}

/**
 * What a `definePage` route declares.
 *
 * @public
 */
export interface PageRouteSpec {
  readonly access: RouteAccess;
  /** Milliseconds the page has to answer (`0`: no deadline); absent, the app's `handlerTimeoutMs`. */
  readonly timeoutMs?: number;
}

/**
 * A `definePage` result: a page module's `route` export.
 *
 * @public
 */
export interface PageDefinition<P extends string = string> {
  readonly [pageBrand]: true;
  readonly path: P;
  readonly access: AccessRef;
  readonly timeoutMs?: number;
}

const apiDefinitions = new WeakSet<object>();
const pageDefinitions = new WeakSet<object>();

const API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/** The members a `defineApi` spec may carry. */
const API_SPEC_KEYS: ReadonlySet<string> = new Set([
  'access',
  'credentials',
  'cacheControl',
  'body',
  'timeoutMs',
  'stream',
  'middleware',
  ...API_METHODS,
]);

function checkPath(path: unknown, what: string): void {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError(`${what} needs the route path of its file, starting with /`);
  }
}

/**
 * Define a filesystem API route: export the result as the module's default.
 *
 * @throws TypeError for a path that is not absolute, a spec without an
 *   `access` or any method handler, an unknown member, a handler that is not
 *   a function, or `credentials` that are not distinct `'cookie'` and
 *   `'token'` entries.
 * @public
 */
export function defineApi<const P extends string>(
  path: P,
  spec: ApiRouteSpec<P>,
): ApiDefinition<P> {
  checkPath(path, 'defineApi');
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError('defineApi needs a route spec object');
  }
  const access = toAccessRef(spec.access);
  if (access === undefined) {
    throw new TypeError('defineApi needs access: publicAccess(reason) or a check function');
  }
  for (const key of Object.keys(spec)) {
    if (!API_SPEC_KEYS.has(key)) throw new TypeError('defineApi spec has an unknown member');
  }
  let handlers = 0;
  for (const method of API_METHODS) {
    const handler: unknown = spec[method];
    if (handler === undefined) continue;
    if (typeof handler !== 'function') {
      throw new TypeError('defineApi method handlers must be functions');
    }
    handlers += 1;
  }
  if (handlers === 0) throw new TypeError('defineApi needs at least one method handler');
  if (spec.credentials !== undefined && !isCredentialList(spec.credentials)) {
    throw new TypeError("defineApi credentials must be distinct 'cookie' and 'token' entries");
  }
  const definition = Object.freeze({
    path,
    spec: Object.freeze({ ...spec, access }),
  }) as ApiDefinition<P>;
  apiDefinitions.add(definition);
  return definition;
}

/**
 * Define a page route's access: export the result as the page module's
 * `route`.
 *
 * @throws TypeError for a path that is not absolute or a spec without an
 *   `access`.
 * @public
 */
export function definePage<const P extends string>(
  path: P,
  spec: PageRouteSpec,
): PageDefinition<P> {
  checkPath(path, 'definePage');
  const access = spec === null || typeof spec !== 'object' ? undefined : toAccessRef(spec.access);
  if (access === undefined) {
    throw new TypeError('definePage needs access: publicAccess(reason) or a check function');
  }
  const definition = Object.freeze({
    path,
    access,
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
  }) as PageDefinition<P>;
  pageDefinitions.add(definition);
  return definition;
}

/** Whether `value` is a {@link defineApi} result. */
export function isApiDefinition(value: unknown): value is ApiDefinition {
  return typeof value === 'object' && value !== null && apiDefinitions.has(value);
}

/** Whether `value` is a {@link definePage} result. */
export function isPageDefinition(value: unknown): value is PageDefinition {
  return typeof value === 'object' && value !== null && pageDefinitions.has(value);
}
