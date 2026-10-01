/**
 * What a route states about itself: the one per-route record of the request
 * pipeline.
 *
 * Every route the app serves registers a frozen {@link RouteMeta} in the
 * route table (`route-table.ts`): its kind, its pattern and methods, its
 * access, the credentials it accepts and its surface kind, its public cache
 * declaration, its request body and its deadline, and who registered it
 * (`owner`) from where (`origin`). Recording it registers its surface
 * descriptor (`security/surfaces.ts`); the route boundary enters the request
 * frame with it, the access chain decides from its descriptor, the failure
 * renderer picks its format from its kind, and the table's entries are the
 * list a reviewer reads to see every public surface of the app.
 *
 * The `route.*` codes are the registration failures: each fails assembly,
 * value-free (a pattern appears as a path relative to `/`; it is written by
 * the developer, never by a client).
 */

import type { AccessRef } from '../api/access-ref.js';
import type { CredentialKind, SurfaceKind } from '../security/surfaces.js';
import type { ApiMethod } from '../contracts/http.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { BodySpec } from './route-limits.js';
import type { CacheControlDeclaration } from './cache-control.js';

/**
 * The kind of a route: an API route (a filesystem API module, or a route a
 * registrar added), a page route, a server-component transport route, a
 * mounted fetch handler, or a framework route (introspection, health,
 * readiness).
 *
 * @public
 */
export type RouteKind = 'api' | 'page' | 'component' | 'mount' | 'framework';

/**
 * The route kinds a response transform may target: the routes whose answer is
 * app or plugin code. A framework route (introspection, health, readiness)
 * answers for the framework, so it is not one.
 *
 * @public
 */
export type TransformableKind = Extract<RouteKind, 'api' | 'page' | 'component' | 'mount'>;

/** Every {@link TransformableKind}. */
export const TRANSFORMABLE_KINDS: ReadonlySet<string> = new Set<TransformableKind>([
  'api',
  'page',
  'component',
  'mount',
]);

/**
 * Where a route's code comes from: the app (its filesystem routes and its own
 * registrar), a code plugin (configured in the app's code), a managed plugin
 * (activated from the database), or the framework.
 *
 * @public
 */
export type RouteOrigin = 'app' | 'code-plugin' | 'managed-plugin' | 'framework';

/**
 * What a route states about itself. `pattern` is the registered path
 * (`/posts/:id`), never the concrete one.
 *
 * @public
 */
export interface RouteMeta {
  readonly kind: RouteKind;
  readonly pattern: string;
  /** The methods the route answers (a GET route also answers HEAD). */
  readonly methods: readonly ApiMethod[];
  readonly access: AccessRef;
  /**
   * The credential kinds the route accepts: an unsafe request to a route
   * accepting `cookie` gets the access chain's cross-site check.
   */
  readonly credentials: readonly CredentialKind[];
  /** What the route is as a surface (`security/surfaces.ts`). */
  readonly surface: SurfaceKind;
  /** The route's public cache declaration, applied by the finalizer when the answer may be shared. */
  readonly cache?: CacheControlDeclaration;
  /**
   * The route's request body: the kind it reads and the most bytes it
   * accepts, or none. Absent, the app-wide `maxBodyBytes` caps it.
   */
  readonly body?: BodySpec;
  /**
   * Milliseconds the route has to answer, from entry to the returned
   * response; `0` disables the deadline. Absent, the app's
   * `handlerTimeoutMs` applies. Past it the request is answered 504.
   */
  readonly timeoutMs?: number;
  /**
   * For a streamed answer that is not live: the most milliseconds between
   * two chunks once the response was returned; past it the stream ends.
   */
  readonly stream?: { readonly timeoutMs: number };
  /** Who registered the route: `app`, `framework`, or the plugin's name. */
  readonly owner: string;
  readonly origin: RouteOrigin;
}

const ROUTE_ERRORS = {
  invalid_path: {
    kind: 'internal',
    message: 'a route of {owner} has an invalid path: {problem}',
    context: {
      owner: 'identifier',
      problem: [
        'not_absolute',
        'trailing_slash',
        'forbidden_character',
        'empty_segment',
        'root_mount',
        'dynamic_mount',
      ],
    },
    suggestion:
      'write an absolute path such as /reports/:id, without a query or fragment; mount under a literal prefix, never at /',
  },
  invalid_route: {
    kind: 'internal',
    message: 'a route of {owner} is rejected: {problem}',
    context: {
      owner: 'identifier',
      problem: [
        'missing_access',
        'invalid_methods',
        'invalid_surface',
        'invalid_credentials',
        'missing_handler',
        'invalid_middleware',
        'invalid_cache',
        'invalid_body',
        'invalid_timeout',
        'invalid_transform_kinds',
      ],
    },
    suggestion:
      'a route states methods, path, access (publicAccess(reason) or a check function) and a handler; its surface is route, admin or webhook; credentials list distinct cookie and token entries',
  },
  duplicate_route: {
    kind: 'internal',
    message: 'route {pattern} is registered twice for {method} (second by {owner})',
    context: { pattern: 'relative-path', method: 'identifier', owner: 'identifier' },
    suggestion: 'register each method and path once',
  },
  reserved_path: {
    kind: 'internal',
    message: 'route {pattern} of {owner} uses a path the framework reserves',
    context: { pattern: 'relative-path', owner: 'identifier' },
    suggestion:
      'the health and readiness paths, the introspection and component endpoints and the /_jsails namespace belong to the framework',
  },
  mount_overlap: {
    kind: 'internal',
    message: 'route {pattern} of {owner} overlaps the mount at {prefix}',
    context: { pattern: 'relative-path', prefix: 'relative-path', owner: 'identifier' },
    suggestion:
      'a mount answers every method and path under its prefix; move the route or the mount so neither is under the other',
  },
  outside_confinement: {
    kind: 'internal',
    message: 'route {pattern} of {owner} is outside the paths {owner} may register',
    context: { pattern: 'relative-path', owner: 'identifier' },
  },
  not_granted: {
    kind: 'internal',
    message: '{owner} may not register a {capability}',
    context: { owner: 'identifier', capability: ['mount', 'guard', 'transform'] },
  },
  managed_origin_refused: {
    kind: 'internal',
    message: 'route {pattern} comes from managed plugin {owner}, which this app does not run',
    context: { pattern: 'relative-path', owner: 'identifier' },
    suggestion: 'managed plugins serve routes only in an app whose plugins are managed',
  },
  managed_transform_refused: {
    kind: 'internal',
    message: 'a response transform comes from managed plugin {owner}, which this app does not run',
    context: { owner: 'identifier' },
    suggestion: 'managed plugins transform responses only in an app whose plugins are managed',
  },
  pattern_mismatch: {
    kind: 'internal',
    message: 'route {pattern} declares a different path than its file',
    context: { pattern: 'relative-path' },
    suggestion: 'pass defineApi/definePage the route path of the file that exports it',
  },
  invalid_definition: {
    kind: 'internal',
    message: 'route {pattern} has an invalid definition: {problem}',
    context: {
      pattern: 'relative-path',
      problem: [
        'mixed_exports',
        'invalid_route_export',
        'invalid_body',
        'invalid_timeout',
        'invalid_access',
        'conflicting_access',
      ],
    },
    suggestion:
      "a defineApi module default-exports only the definition; a page exports definePage as `route`; a method-export module exports access or authorize, not both; body is { kind: 'none' }, { kind: 'json' | 'form' | 'raw', maxBytes } or { kind: 'multipart', maxBytes, parts } and timeoutMs an integer from 0",
  },
  next_called_twice: {
    kind: 'internal',
    message: 'a middleware called next() more than once',
  },
  invalid_answer: {
    kind: 'internal',
    message: 'a route {stage} answered with something other than a Response',
    context: { stage: ['handler', 'middleware', 'transform', 'rate_limit'] },
  },
} as const;

/**
 * The route registration codes, `route.*`: an invalid path or route spec, a
 * method and pattern registered twice, a reserved path, a route under a
 * mount (or a mount under another), a path outside an
 * owner's confinement, a capability not granted, a managed plugin's route in
 * an app that runs none, a `defineApi`/`definePage` path that is not its
 * file's, a middleware calling `next()` twice, and a route stage answering
 * with something other than a `Response`.
 *
 * @public
 */
export const RouteErrors: ErrorRegistry<'route', typeof ROUTE_ERRORS> = defineErrors(
  'route',
  ROUTE_ERRORS,
);

/** Whether a pattern segment is a parameter (`:id`, `:slug{.+}`) or holds a wildcard. */
export function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(':') || segment.includes('*');
}

/** `pattern` as a `relative-path` slot: without its leading slash, `.` for the root. */
export function patternSlot(pattern: string): string {
  const relative = pattern.replace(/^\/+/, '');
  return relative === '' ? '.' : relative;
}

/** `owner` as an `identifier` slot (a name that is not one renders as `unnamed`). */
export function ownerSlot(owner: string): string {
  return /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/.test(owner) ? owner : 'unnamed';
}
