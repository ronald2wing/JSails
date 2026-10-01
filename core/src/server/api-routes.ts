/**
 * Filesystem API route registration.
 *
 * Each compiled API module is loaded and validated once through the route
 * module importer, then registered as one route per path it answers (its
 * manifest path, the optional catch-all's base, and each locale alias), all
 * methods behind one compiled route boundary (`route-boundary.ts`).
 *
 * Two module shapes:
 * - a `defineApi(path, spec)` default export, whose `access`, `credentials`,
 *   `cacheControl`, `body`, `timeoutMs`, `stream` and `middleware` are the
 *   route's and whose handlers take the request context alone. Its path must
 *   be the file's route, and the module exports nothing else;
 * - named method exports (`GET`, `POST`, ... as `(request, context)`
 *   handlers) with its access as an `access` export (`publicAccess(reason)`
 *   or a check) or an `authorize` check, never both, and optional
 *   `middleware`, `cacheControl`, `body` and `timeoutMs` exports. A check
 *   allows only on an exact `true`. It accepts the session cookie and a
 *   header token.
 *
 * A module stating no access fails assembly (`surface.missing_access`): there
 * is no app-wide default.
 *
 * Either way the module's middleware runs after the access chain. A GET
 * route answers HEAD with the module's `HEAD` handler, or its `GET`; a module
 * with only `HEAD` answers a real GET with 405 and `Allow: HEAD`. A `body`
 * or `timeoutMs` that is not a valid declaration fails assembly
 * (`route.invalid_definition`).
 */

import { toAccessRef, type AccessRef } from '../api/access-ref.js';
import { isApiDefinition, type ApiRouteSpec } from '../api/route-definition.js';
import type { Awaitable } from '../contracts/awaitable.js';
import type { ApiMethod, RouteContext } from '../contracts/http.js';
import { loadRouteModule } from '../routing/route-module.js';
import { validateMiddlewareList, type RouteMiddleware } from '../routing/middleware.js';
import type { RouteManifestEntry } from '../routing/routes.js';
import { checkBodySpec, type BodySpec, checkStreamSpec, isTimeoutMs } from './route-limits.js';
import { extractCacheControlDeclaration, type CacheControlDeclaration } from './cache-control.js';
import { HTTP_METHODS, methodNotAllowedResponse } from './request-pipeline.js';
import { SurfaceErrors, type CredentialKind } from '../security/surfaces.js';
import { patternSlot, RouteErrors } from './route-meta.js';
import { resolveRoutePaths, type LocaleRouteOptions } from './route-paths.js';
import type { RegisterRoute } from './route-boundary.js';

/** A method handler of either module shape, as the boundary calls it. */
type MethodHandler = (request: Request, context: RouteContext) => Awaitable<Response>;

/** What one API module declares, validated once when it loads. */
interface ApiModulePlan {
  readonly handlers: ReadonlyMap<ApiMethod, MethodHandler>;
  readonly access: AccessRef;
  readonly credentials: readonly CredentialKind[];
  readonly cache: CacheControlDeclaration | undefined;
  readonly body: BodySpec | undefined;
  readonly timeoutMs: number | undefined;
  readonly stream: { readonly timeoutMs: number } | undefined;
  readonly middleware: readonly RouteMiddleware[];
}

/** The credentials a filesystem API route accepts unless its definition states them. */
const API_CREDENTIALS: readonly CredentialKind[] = Object.freeze(['cookie', 'token'] as const);

/** The app-level inputs every API route shares. */
export interface ApiRouteOptions {
  readonly localeOptions: LocaleRouteOptions | undefined;
}

/** Load one API module and register every path it answers. */
export async function registerApiRoutes(
  register: RegisterRoute,
  entry: RouteManifestEntry,
  options: ApiRouteOptions,
): Promise<void> {
  const plan = await loadRouteModule('api', entry.file, (exports) => planModule(entry, exports));
  const middleware = plan.middleware;
  const get = plan.handlers.get('GET');
  const head = plan.handlers.get('HEAD');
  const methods = [...plan.handlers.keys()];
  // A module that answers no method exposes nothing, so it registers no route
  // and no surface: every request to its path is the router's 404.
  if (methods.length === 0) return;

  const terminal = (request: Request, context: RouteContext): Awaitable<Response> => {
    const method = request.method;
    if (method === 'HEAD' || method === 'GET') {
      const handler = method === 'HEAD' ? (head ?? get) : get;
      if (handler === undefined) return methodNotAllowedResponse('HEAD');
      return handler(request, context);
    }
    // The router dispatches only the methods the route registered.
    return (plan.handlers.get(method as ApiMethod) as MethodHandler)(request, context);
  };

  for (const pattern of resolveRoutePaths(entry, options.localeOptions)) {
    register(
      {
        kind: 'api',
        pattern,
        methods,
        access: plan.access,
        credentials: plan.credentials,
        surface: 'api',
        ...(plan.cache === undefined ? {} : { cache: plan.cache }),
        ...(plan.body === undefined ? {} : { body: plan.body }),
        ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
        ...(plan.stream === undefined ? {} : { stream: plan.stream }),
        owner: 'app',
        origin: 'app',
      },
      {
        middleware,
        terminal: (routed, context) => terminal(routed.request, context),
      },
    );
  }
}

/** Validate an API module's exports into its plan. */
function planModule(entry: RouteManifestEntry, exports: Record<string, unknown>): ApiModulePlan {
  const definition = exports.default;
  if (isApiDefinition(definition)) return planDefinition(entry, definition, exports);
  const handlers = new Map<ApiMethod, MethodHandler>();
  for (const method of HTTP_METHODS) {
    const exported = exports[method];
    if (exported === undefined) continue;
    if (typeof exported !== 'function') {
      throw new Error(`API route "${entry.route}" exports "${method}" as a non-function value`);
    }
    handlers.set(method, exported as MethodHandler);
  }
  return {
    handlers,
    access: moduleAccess(entry, exports),
    credentials: API_CREDENTIALS,
    cache: extractCacheControlDeclaration(entry.route, exports),
    body: bodyOf(entry, exports.body),
    timeoutMs: timeoutOf(entry, exports.timeoutMs),
    stream: undefined,
    middleware: middlewareOf(entry, exports.middleware),
  };
}

/** The plan of a `defineApi` module, whose definition must be its only export. */
function planDefinition(
  entry: RouteManifestEntry,
  definition: { readonly path: string; readonly spec: ApiRouteSpec<string> },
  exports: Record<string, unknown>,
): ApiModulePlan {
  const pattern = patternSlot(entry.route);
  if (Object.keys(exports).some((name) => name !== 'default')) {
    throw new RouteErrors.Error('invalid_definition', { pattern, problem: 'mixed_exports' });
  }
  if (definition.path !== entry.route) {
    throw new RouteErrors.Error('pattern_mismatch', { pattern });
  }
  const { spec } = definition;
  const handlers = new Map<ApiMethod, MethodHandler>();
  for (const method of HTTP_METHODS) {
    const handler = spec[method];
    if (handler !== undefined) {
      handlers.set(method, (_request, context) => handler(context));
    }
  }
  return {
    handlers,
    access: toAccessRef(spec.access) as AccessRef,
    credentials: spec.credentials ?? API_CREDENTIALS,
    cache: extractCacheControlDeclaration(entry.route, { cacheControl: spec.cacheControl }),
    body: bodyOf(entry, spec.body),
    timeoutMs: timeoutOf(entry, spec.timeoutMs),
    stream: streamOf(entry, spec.stream),
    middleware: middlewareOf(entry, spec.middleware),
  };
}

/**
 * The access a method-export module states: its `access` export (a reference
 * or a check) or its `authorize` check. Exporting both, a value of neither
 * shape, or none fails assembly.
 */
function moduleAccess(entry: RouteManifestEntry, exports: Record<string, unknown>): AccessRef {
  const pattern = patternSlot(entry.route);
  const { access, authorize } = exports;
  if (access !== undefined && authorize !== undefined) {
    throw new RouteErrors.Error('invalid_definition', { pattern, problem: 'conflicting_access' });
  }
  if (authorize !== undefined && typeof authorize !== 'function') {
    throw new RouteErrors.Error('invalid_definition', { pattern, problem: 'invalid_access' });
  }
  const stated = access ?? authorize;
  if (stated === undefined) {
    throw new SurfaceErrors.Error('missing_access', { pattern, owner: 'app' });
  }
  const ref = toAccessRef(stated);
  if (ref === undefined) {
    throw new RouteErrors.Error('invalid_definition', { pattern, problem: 'invalid_access' });
  }
  return ref;
}

/** The module's `body` declaration, validated; `undefined` when it declares none. */
function bodyOf(entry: RouteManifestEntry, value: unknown): BodySpec | undefined {
  if (value === undefined) return undefined;
  const body = checkBodySpec(value);
  if (body === undefined) throw invalidRoute(entry, 'invalid_body');
  return body;
}

/** The module's `timeoutMs` declaration, validated; `undefined` when it declares none. */
function timeoutOf(entry: RouteManifestEntry, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!isTimeoutMs(value)) throw invalidRoute(entry, 'invalid_timeout');
  return value;
}

/** The definition's `stream` declaration, validated; `undefined` when it declares none. */
function streamOf(
  entry: RouteManifestEntry,
  value: unknown,
): { readonly timeoutMs: number } | undefined {
  if (value === undefined) return undefined;
  const stream = checkStreamSpec(value);
  if (stream === undefined) throw invalidRoute(entry, 'invalid_timeout');
  return stream;
}

/** The value-free failure of an invalid `body`, `timeoutMs` or `stream` declaration. */
function invalidRoute(
  entry: RouteManifestEntry,
  problem: 'invalid_body' | 'invalid_timeout',
): Error {
  return new RouteErrors.Error('invalid_definition', {
    pattern: patternSlot(entry.route),
    problem,
  });
}

/** A module's middleware list, validated structurally. */
function middlewareOf(entry: RouteManifestEntry, value: unknown): readonly RouteMiddleware[] {
  return (
    validateMiddlewareList(
      value,
      (message) => new Error(`API route "${entry.route}" ${message}`),
    ) ?? []
  );
}
