/**
 * The HTTP registrar: how code outside the filesystem adds routes.
 *
 * {@link createHttpRoutes} builds one registrar per owner (the app, or one
 * plugin). The plugin host decides what the owner may do (`allow`: mount a
 * fetch handler, add a guard, add a response transform; `confine`: the path
 * prefixes its routes must stay under) and the registrar enforces it at
 * registration, stamping every contribution with the owner and its origin.
 * Assembly (`createApp`) compiles the contributions into the route table and
 * the router; nothing is wired while the registrar collects.
 *
 * - `add(spec)`: a route with its methods, path, `access` (required: there is
 *   no default; `publicAccess(reason)` or a check), its surface kind
 *   (`route`, or an `admin` screen or `webhook` receiver), the credential kinds it
 *   accepts (`credentials`, the session cookie unless stated; `[]` for a
 *   route that reads none, which then gets no cross-site check), public
 *   cache declaration, request body (`body`), deadline (`timeoutMs`, and a
 *   streamed answer's idle bound `stream.timeoutMs`), its own middleware, and
 *   a handler of the route's request context. It runs inside the route
 *   boundary, after the claim and the access chain.
 * - `mount(prefix, handler, options)`: a web-standard fetch handler
 *   (`(request) => Response`, a Hono app's `fetch`) answering every method
 *   at and under the literal `prefix`, which no other route may lie under.
 *   It runs inside the boundary with the frame ambient and sees the request
 *   as sent, its full path included, its body bounded by the mount's `body`
 *   (else the app-wide cap). Never granted to a managed plugin.
 * - `guard(guard)`: a wall of the guard tier, in front of every route and
 *   public file.
 * - `transform(kinds, fn)`: rewrites the answers of routes of those kinds
 *   (`api`, which a registrar route is, `page`, `component`, `mount`), after
 *   their handler; it cannot answer in a route's place. Framework routes are
 *   never transformed, so naming their kind fails.
 *
 * Paths use the router's syntax (`/reports/:id`, `/files/*`). A GET route
 * also answers HEAD, so HEAD is never listed.
 */

import { toAccessRef, type AccessRef, type RouteAccess } from '../api/access-ref.js';
import type { Awaitable } from '../contracts/awaitable.js';
import type { ApiMethod, RouteContext } from '../contracts/http.js';
import type { RouteMiddleware } from '../routing/middleware.js';
import { isCredentialList, type CredentialKind } from '../security/credentials.js';
import { checkBodySpec, type BodySpec, checkStreamSpec, isTimeoutMs } from './route-limits.js';
import { extractCacheControlDeclaration, type CacheControlDeclaration } from './cache-control.js';
import type { Guard } from './request-frame.js';
import type { ResponseTransform } from './route-boundary.js';
import {
  isDynamicSegment,
  ownerSlot,
  patternSlot,
  RouteErrors,
  TRANSFORMABLE_KINDS,
  type RouteOrigin,
  type TransformableKind,
} from './route-meta.js';

/**
 * A method a registrar route may list (a GET route also answers HEAD).
 *
 * @public
 */
export type RouteMethod = Exclude<ApiMethod, 'HEAD'>;

/**
 * The surface kinds a registrar route may state (`route` unless it says
 * otherwise): an `admin` screen or a `webhook` receiver. The access matrix
 * holds each kind to its own rules (no admin surface accepts a token); the
 * other kinds are the framework's own routes.
 *
 * @public
 */
export type RegistrarSurfaceKind = 'route' | 'admin' | 'webhook';

/**
 * A route a registrar adds.
 *
 * @public
 */
export interface RouteSpec {
  readonly methods: readonly RouteMethod[];
  readonly path: string;
  readonly access: RouteAccess;
  /** What the route is as a surface (default `route`). */
  readonly surface?: RegistrarSurfaceKind;
  /**
   * The credential kinds the route accepts (default `['cookie']`); `[]` reads
   * none and gets no cross-site check.
   */
  readonly credentials?: readonly CredentialKind[];
  /** A public cache declaration for the route's GET answers. */
  readonly cache?: CacheControlDeclaration;
  /** The route's own middleware, outermost first. */
  readonly middleware?: readonly RouteMiddleware[];
  /**
   * The request body the route reads (`ctx.body`), and its cap in bytes (at
   * most 100 MiB), or `{ kind: 'none' }`. Absent, the app-wide `maxBodyBytes`
   * caps it.
   */
  readonly body?: BodySpec;
  /** Milliseconds the route has to answer (`0`: no deadline); absent, the app's `handlerTimeoutMs`. */
  readonly timeoutMs?: number;
  /** A streamed answer's idle bound: the most milliseconds between two chunks. */
  readonly stream?: { readonly timeoutMs: number };
  handler(context: RouteContext): Awaitable<Response>;
}

/**
 * Options of a mounted fetch handler.
 *
 * @public
 */
export interface MountOptions {
  readonly access: RouteAccess;
  /**
   * The credential kinds the handler accepts (default `['cookie']`); `[]`
   * reads none and gets no cross-site check.
   */
  readonly credentials?: readonly CredentialKind[];
  /** The request body the handler reads, and its cap; absent, the app-wide `maxBodyBytes`. */
  readonly body?: BodySpec;
  /** Milliseconds the handler has to answer (`0`: no deadline); absent, the app's `handlerTimeoutMs`. */
  readonly timeoutMs?: number;
}

/**
 * A web-standard fetch handler, such as a Hono app's `fetch`.
 *
 * @public
 */
export type FetchHandler = (request: Request) => Awaitable<Response>;

/**
 * The registrar an owner adds routes, mounts, guards and transforms through.
 *
 * @public
 */
export interface HttpRoutes {
  add(spec: RouteSpec): void;
  mount(prefix: string, handler: FetchHandler, options: MountOptions): void;
  guard(guard: Guard): void;
  transform(kinds: readonly TransformableKind[], transform: ResponseTransform): void;
}

/**
 * What an owner may register beyond routes.
 *
 * @public
 */
export interface HttpRouteGrants {
  readonly mount: boolean;
  readonly guard: boolean;
  readonly transform: boolean;
}

/**
 * Options for {@link createHttpRoutes}.
 *
 * @public
 */
export interface HttpRoutesOptions {
  /** The owner's name: `app`, or the plugin's name. */
  readonly owner: string;
  readonly origin: RouteOrigin;
  /** Path prefixes every route and mount must stay under; absent means anywhere. */
  readonly confine?: readonly string[];
  readonly allow: HttpRouteGrants;
}

/**
 * A route as the registrar collected it.
 *
 * @public
 */
export interface RouteContribution {
  readonly type: 'route';
  readonly owner: string;
  readonly origin: RouteOrigin;
  readonly methods: readonly RouteMethod[];
  readonly path: string;
  readonly access: AccessRef;
  readonly surface: RegistrarSurfaceKind;
  readonly credentials: readonly CredentialKind[];
  readonly cache?: CacheControlDeclaration;
  readonly middleware: readonly RouteMiddleware[];
  readonly body?: BodySpec;
  readonly timeoutMs?: number;
  readonly stream?: { readonly timeoutMs: number };
  readonly handler: (context: RouteContext) => Awaitable<Response>;
}

/**
 * A mount as the registrar collected it.
 *
 * @public
 */
export interface MountContribution {
  readonly type: 'mount';
  readonly owner: string;
  readonly origin: RouteOrigin;
  readonly prefix: string;
  readonly access: AccessRef;
  readonly credentials: readonly CredentialKind[];
  readonly body?: BodySpec;
  readonly timeoutMs?: number;
  readonly handler: FetchHandler;
}

/**
 * A transform as the registrar collected it.
 *
 * @public
 */
export interface TransformContribution {
  readonly owner: string;
  readonly origin: RouteOrigin;
  readonly kinds: readonly TransformableKind[];
  readonly transform: ResponseTransform;
}

/**
 * Everything one or more registrars collected, in registration order.
 *
 * @public
 */
export interface HttpContributions {
  readonly routes: readonly (RouteContribution | MountContribution)[];
  readonly transforms: readonly TransformContribution[];
  readonly guards: readonly Guard[];
}

/**
 * A registrar and what it collected.
 *
 * @public
 */
export interface HttpRoutesRegistrar {
  readonly routes: HttpRoutes;
  contributions(): HttpContributions;
}

const REGISTRAR_SURFACES: ReadonlySet<string> = new Set<RegistrarSurfaceKind>([
  'route',
  'admin',
  'webhook',
]);

const ROUTE_METHODS: ReadonlySet<string> = new Set<RouteMethod>([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/**
 * A registrar for one owner: every route and mount it adds is checked
 * against `options` (path shape, confinement, grants) and stamped with the
 * owner and origin.
 *
 * @throws `route.invalid_path`, `route.invalid_route`,
 *   `route.outside_confinement`, `route.not_granted` from the registrar's
 *   methods, value-free.
 * @public
 */
export function createHttpRoutes(options: HttpRoutesOptions): HttpRoutesRegistrar {
  const { owner, origin, allow } = options;
  const confine = options.confine?.map((prefix) => checkPath(owner, prefix));
  const routes: (RouteContribution | MountContribution)[] = [];
  const transforms: TransformContribution[] = [];
  const guards: Guard[] = [];

  const invalid = (problem: InvalidRouteProblem): Error =>
    new RouteErrors.Error('invalid_route', { owner: ownerSlot(owner), problem });

  const confined = (path: string): void => {
    if (confine === undefined) return;
    if (confine.some((prefix) => within(path, prefix))) return;
    throw new RouteErrors.Error('outside_confinement', {
      pattern: patternSlot(path),
      owner: ownerSlot(owner),
    });
  };

  const granted = (capability: 'mount' | 'guard' | 'transform'): void => {
    if (!allow[capability]) {
      throw new RouteErrors.Error('not_granted', { owner: ownerSlot(owner), capability });
    }
  };

  const registrar: HttpRoutes = {
    add(spec) {
      if (spec === null || typeof spec !== 'object') throw invalid('missing_handler');
      const path = checkPath(owner, spec.path);
      confined(path);
      const access = toAccessRef(spec.access);
      if (access === undefined) throw invalid('missing_access');
      const methods: unknown = spec.methods;
      if (
        !Array.isArray(methods) ||
        methods.length === 0 ||
        !methods.every((method) => typeof method === 'string' && ROUTE_METHODS.has(method)) ||
        new Set(methods).size !== methods.length
      ) {
        throw invalid('invalid_methods');
      }
      if (typeof spec.handler !== 'function') throw invalid('missing_handler');
      const surface: unknown = spec.surface ?? 'route';
      if (typeof surface !== 'string' || !REGISTRAR_SURFACES.has(surface)) {
        throw invalid('invalid_surface');
      }
      const credentials = checkCredentials(spec.credentials, () => invalid('invalid_credentials'));
      const middleware: unknown = spec.middleware ?? [];
      if (!Array.isArray(middleware) || !middleware.every((entry) => typeof entry === 'function')) {
        throw invalid('invalid_middleware');
      }
      let cache: CacheControlDeclaration | undefined;
      if (spec.cache !== undefined) {
        if (!methods.includes('GET')) throw invalid('invalid_cache');
        try {
          cache = extractCacheControlDeclaration(path, { cacheControl: spec.cache });
        } catch {
          throw invalid('invalid_cache');
        }
      }
      const limits = checkLimits(spec, invalid);
      let stream: { readonly timeoutMs: number } | undefined;
      if (spec.stream !== undefined) {
        stream = checkStreamSpec(spec.stream);
        if (stream === undefined) throw invalid('invalid_timeout');
      }
      const handler = spec.handler.bind(spec);
      routes.push(
        Object.freeze({
          type: 'route',
          owner,
          origin,
          methods: Object.freeze([...(methods as RouteMethod[])]),
          path,
          access,
          surface: surface as RegistrarSurfaceKind,
          credentials,
          ...(cache === undefined ? {} : { cache }),
          middleware: Object.freeze([...(middleware as RouteMiddleware[])]),
          ...limits,
          ...(stream === undefined ? {} : { stream }),
          handler,
        }),
      );
    },
    mount(prefix, handler, mountOptions) {
      granted('mount');
      const path = checkPath(owner, prefix);
      if (path === '/') {
        throw new RouteErrors.Error('invalid_path', {
          owner: ownerSlot(owner),
          problem: 'root_mount',
        });
      }
      if (path.split('/').some(isDynamicSegment)) {
        throw new RouteErrors.Error('invalid_path', {
          owner: ownerSlot(owner),
          problem: 'dynamic_mount',
        });
      }
      confined(path);
      if (typeof handler !== 'function') throw invalid('missing_handler');
      if (mountOptions === null || typeof mountOptions !== 'object') {
        throw invalid('missing_access');
      }
      const access = toAccessRef(mountOptions.access);
      if (access === undefined) throw invalid('missing_access');
      const credentials = checkCredentials(mountOptions.credentials, () =>
        invalid('invalid_credentials'),
      );
      const limits = checkLimits(mountOptions, invalid);
      routes.push(
        Object.freeze({
          type: 'mount',
          owner,
          origin,
          prefix: path,
          access,
          credentials,
          ...limits,
          handler,
        }),
      );
    },
    guard(guard) {
      granted('guard');
      if (typeof guard !== 'function') throw invalid('missing_handler');
      guards.push(guard);
    },
    transform(kinds, transform) {
      granted('transform');
      if (!isTransformKinds(kinds)) throw invalid('invalid_transform_kinds');
      if (typeof transform !== 'function') throw invalid('missing_handler');
      transforms.push(
        Object.freeze({ owner, origin, kinds: Object.freeze([...kinds]), transform }),
      );
    },
  };

  return Object.freeze({
    routes: Object.freeze(registrar),
    contributions: () =>
      Object.freeze({
        routes: Object.freeze([...routes]),
        transforms: Object.freeze([...transforms]),
        guards: Object.freeze([...guards]),
      }),
  });
}

type InvalidRouteProblem =
  | 'missing_access'
  | 'invalid_methods'
  | 'invalid_surface'
  | 'invalid_credentials'
  | 'missing_handler'
  | 'invalid_middleware'
  | 'invalid_cache'
  | 'invalid_body'
  | 'invalid_timeout'
  | 'invalid_transform_kinds';

/**
 * Whether `value` is a non-empty list of distinct {@link TransformableKind}s.
 */
export function isTransformKinds(value: unknown): value is readonly TransformableKind[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every((kind) => typeof kind === 'string' && TRANSFORMABLE_KINDS.has(kind))
  );
}

/**
 * The validated `body` and `timeoutMs` of a route or mount spec, each present
 * only when declared.
 */
function checkLimits(
  spec: { readonly body?: unknown; readonly timeoutMs?: unknown },
  invalid: (problem: InvalidRouteProblem) => Error,
): { readonly body?: BodySpec; readonly timeoutMs?: number } {
  let body: BodySpec | undefined;
  if (spec.body !== undefined) {
    body = checkBodySpec(spec.body);
    if (body === undefined) throw invalid('invalid_body');
  }
  if (spec.timeoutMs !== undefined && !isTimeoutMs(spec.timeoutMs)) {
    throw invalid('invalid_timeout');
  }
  return {
    ...(body === undefined ? {} : { body }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
  };
}

/** The credentials a registrar route or mount accepts unless it states them. */
const DEFAULT_CREDENTIALS: readonly CredentialKind[] = Object.freeze(['cookie'] as const);

/** `value` as a frozen credential list: the session cookie when absent. */
function checkCredentials(value: unknown, invalid: () => Error): readonly CredentialKind[] {
  if (value === undefined) return DEFAULT_CREDENTIALS;
  if (!isCredentialList(value)) throw invalid();
  return Object.freeze([...value]);
}

/** Whether `path` is `prefix` or under it. */
function within(path: string, prefix: string): boolean {
  return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * `value` as a registrable path: absolute, no trailing slash (but `/`), no
 * empty segment, no backslash, query, fragment or control character.
 */
export function checkPath(owner: string, value: unknown): string {
  const fail = (
    problem: 'not_absolute' | 'trailing_slash' | 'forbidden_character' | 'empty_segment',
  ): Error => new RouteErrors.Error('invalid_path', { owner: ownerSlot(owner), problem });
  if (typeof value !== 'string' || !value.startsWith('/')) throw fail('not_absolute');
  if (/[\\?#\s\u0000-\u001f\u007f]/.test(value)) throw fail('forbidden_character');
  if (value !== '/' && value.endsWith('/')) throw fail('trailing_slash');
  if (value.includes('//')) throw fail('empty_segment');
  return value;
}
