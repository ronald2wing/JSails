/**
 * The request-scope contract: resolve first, then bind.
 *
 * An extension registers a {@link RequestScopeSpec} through
 * `configureRequestScope`. Its `resolve` runs once per request, inside the
 * request's claim (`request-frame.ts`), after the identity and the locale are
 * settled and before the access chain, route middleware, and the handler. It
 * answers with a {@link ScopeBinding} (what to make ambient, and the cache
 * partition it adds), a `Response` (the scope answers the request itself, such
 * as a redirect to a tenant's canonical host), or `undefined` (nothing to
 * bind). Resolving is apart from binding so the claim can finish every
 * decision before any of the request's code runs, render an error page inside
 * the same bindings, and report a late failure inside them too.
 *
 * Each scope states statically how it affects a cached response
 * ({@link ScopeCacheClass}): a `partition` scope splits the cache by a value it
 * names (a tenant read from the host), a `private` one makes any response it
 * binds personal, and a `transparent` one never changes what a response
 * holds. A `partition` scope must bind with a partition and the other two must
 * not; a binding that breaks its class fails the request.
 *
 * Scopes resolve in registration order; a later scope sees the bindings of
 * the earlier ones (its `resolve` runs inside them), and the first scope's
 * binding is the outermost. A scope that needs teardown after the response
 * cannot be expressed as a binding and is out of contract.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { Session } from '../contracts/http.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { ClientAddress, RequestOrigin } from '../security/request-origin.js';

/**
 * How a scope affects a cached response: `partition` adds a cache dimension
 * (its binding names it), `private` makes every response it binds personal,
 * `transparent` changes nothing a response holds.
 *
 * @public
 */
export type ScopeCacheClass = 'partition' | 'private' | 'transparent';

/**
 * One cache dimension a scope adds: its `name`, the request's `value`, and
 * where the value was read. Only a value read from the `host` or the `path`
 * can key a response shared between visitors.
 *
 * @public
 */
export interface CachePartition {
  readonly name: string;
  readonly value: string;
  readonly from: 'host' | 'path' | 'session' | 'header';
}

/**
 * What a resolved scope makes ambient: `run` calls `fn` inside the scope's
 * value (an `AsyncLocalStorage` key, such as the tenant) and returns what it
 * returned. A `partition` scope also names its {@link CachePartition}.
 *
 * @public
 */
export interface ScopeBinding {
  run<T>(fn: () => T): T;
  readonly partition?: CachePartition;
}

/**
 * What a scope's `resolve` reads: the request, its route's URL and params,
 * the settled identity and locale, and the resolved origin and client.
 *
 * @public
 */
export interface ScopeRequest {
  readonly request: Request;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** The request's session, or `null` when it carries no credential or none resolved. */
  readonly identity: Session | null;
  readonly locale: string | undefined;
  readonly origin: RequestOrigin;
  readonly client: ClientAddress;
}

/**
 * A request scope an extension registers with `configureRequestScope`.
 *
 * @public
 */
export interface RequestScopeSpec {
  /** A unique identifier (`a-z`, digits, `.`, `_`, `-`), used in diagnostics. */
  readonly name: string;
  readonly cache: ScopeCacheClass;
  resolve(request: ScopeRequest): Awaitable<ScopeBinding | Response | undefined>;
}

const REQUEST_SCOPE_ERRORS = {
  invalid_scope: {
    kind: 'internal',
    message: 'request scope {index} is rejected: {problem}',
    context: {
      index: 'count',
      problem: ['not_object', 'invalid_name', 'invalid_cache', 'missing_resolve'],
    },
    suggestion: 'a request scope is { name, cache, resolve }',
  },
  duplicate_scope: {
    kind: 'internal',
    message: 'request scope {scope} is registered twice',
    context: { scope: 'identifier' },
  },
  invalid_binding: {
    kind: 'internal',
    message: 'request scope {scope} resolved to an invalid binding: {problem}',
    context: {
      scope: 'identifier',
      problem: ['not_binding', 'missing_partition', 'unexpected_partition', 'invalid_partition'],
    },
    suggestion:
      'return a { run } binding, a Response or undefined; only a partition scope names a partition',
  },
} as const;

/**
 * The request-scope codes, `request_scope.*`: a malformed or duplicate scope
 * at assembly, and a binding that breaks its scope's cache class at request
 * time.
 *
 * @public
 */
export const RequestScopeErrors: ErrorRegistry<'request_scope', typeof REQUEST_SCOPE_ERRORS> =
  defineErrors('request_scope', REQUEST_SCOPE_ERRORS);

const SCOPE_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const CACHE_CLASSES: ReadonlySet<string> = new Set(['partition', 'private', 'transparent']);
const PARTITION_SOURCES: ReadonlySet<string> = new Set(['host', 'path', 'session', 'header']);

/** Validate the `requestScopes` option: frozen specs with unique names. */
export function resolveRequestScopes(value: unknown): readonly RequestScopeSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RequestScopeErrors.Error('invalid_scope', { index: 0, problem: 'not_object' });
  }
  const names = new Set<string>();
  return Object.freeze(
    value.map((entry: unknown, index) => {
      const spec = validateScope(entry, index);
      if (names.has(spec.name)) {
        throw new RequestScopeErrors.Error('duplicate_scope', { scope: spec.name });
      }
      names.add(spec.name);
      return spec;
    }),
  );
}

/** One validated, frozen copy of a registered scope. */
export function validateScope(entry: unknown, index: number): RequestScopeSpec {
  const problem = (kind: 'not_object' | 'invalid_name' | 'invalid_cache' | 'missing_resolve') =>
    new RequestScopeErrors.Error('invalid_scope', { index, problem: kind });
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw problem('not_object');
  }
  const { name, cache, resolve } = entry as Record<string, unknown>;
  if (typeof name !== 'string' || !SCOPE_NAME.test(name)) throw problem('invalid_name');
  if (typeof cache !== 'string' || !CACHE_CLASSES.has(cache)) throw problem('invalid_cache');
  if (typeof resolve !== 'function') throw problem('missing_resolve');
  const spec = entry as RequestScopeSpec;
  return Object.freeze({
    name,
    cache: cache as ScopeCacheClass,
    resolve: (request: ScopeRequest) => spec.resolve(request),
  });
}

/**
 * The binding a scope resolved to, checked against its cache class, or the
 * `Response` it answered with, or `undefined` for nothing to bind.
 */
export function checkScopeResult(
  spec: RequestScopeSpec,
  result: unknown,
): ScopeBinding | Response | undefined {
  if (result === undefined || result instanceof Response) return result;
  const invalid = (
    problem: 'not_binding' | 'missing_partition' | 'unexpected_partition' | 'invalid_partition',
  ) => new RequestScopeErrors.Error('invalid_binding', { scope: spec.name, problem });
  if (result === null || typeof result !== 'object') throw invalid('not_binding');
  const binding = result as { run?: unknown; partition?: unknown };
  if (typeof binding.run !== 'function') throw invalid('not_binding');
  if (binding.partition === undefined) {
    if (spec.cache === 'partition') throw invalid('missing_partition');
    return result as ScopeBinding;
  }
  if (spec.cache !== 'partition') throw invalid('unexpected_partition');
  if (!isPartition(binding.partition)) throw invalid('invalid_partition');
  return result as ScopeBinding;
}

function isPartition(value: unknown): value is CachePartition {
  if (value === null || typeof value !== 'object') return false;
  const { name, value: partitionValue, from } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    typeof partitionValue === 'string' &&
    typeof from === 'string' &&
    PARTITION_SOURCES.has(from)
  );
}
