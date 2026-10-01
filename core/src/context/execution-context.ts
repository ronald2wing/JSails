/**
 * The execution context: the one ambient value every unit of work (a request,
 * a job attempt, a static-export render, an extension's setup) runs inside.
 *
 * An {@link ExecutionContext} is immutable: the span the work runs as
 * ({@link TraceContext}), the request id when the work is a request or was
 * started by one, and a map of typed values under {@link ContextKey}s (the
 * request locale, the current tenant, the application scope facades resolve
 * against, a server component's nesting frame). Changing a value makes a new
 * context for a callback ({@link withContext}); nothing mutates the context a
 * caller or a sibling promise already holds.
 *
 * There is exactly one `AsyncLocalStorage` behind it, and it lives on
 * `globalThis` (keyed by `Symbol.for`) together with the key registry, so two
 * loaded copies of `jsails` (an app's and a plugin's nested one) read and
 * write one context: a tenant set through either copy is the tenant the
 * other's query guard sees. A key's name is its identity in this process and
 * in a carrier, so declaring a name again returns the key already declared;
 * the eslint `context` fragment bans any other `AsyncLocalStorage` in the
 * framework's sources, apart from the data layer's own transaction scopes.
 *
 * A key declared with a `propagate` codec travels in a {@link ContextCarrier}
 * (`carrier.ts`) into a job or another process; one without stays in this
 * process.
 *
 * Server-only (`node:async_hooks`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { ContextErrors } from './context-errors.js';
import { createRootTrace, type TraceContext } from './trace-context.js';

declare const KEY_VALUE: unique symbol;

/**
 * How a key's value travels in a carrier. `encode` returns the text to carry,
 * or `undefined` to leave the value out; `decode` returns the value, or
 * `undefined` when the text is not one (the restore then fails with
 * `context.invalid_value`). Carried text comes from a queue or another
 * process, so `decode` validates it as input.
 *
 * @public
 */
export interface ContextCodec<T> {
  encode(value: T): string | undefined;
  decode(text: string): T | undefined;
}

/**
 * Options of {@link createContextKey}.
 *
 * @public
 */
export interface ContextKeyOptions<T> {
  /** Carry the value into jobs and other processes through this codec. */
  readonly propagate?: ContextCodec<T>;
}

/**
 * A typed slot in the execution context. Its `name` is its identity.
 *
 * @public
 */
export interface ContextKey<T> {
  readonly name: string;
  /** True when the value travels in a carrier. */
  readonly propagated: boolean;
  /** Type-only: the value type this key holds. */
  readonly [KEY_VALUE]?: T;
}

/**
 * The values of an execution context, read with {@link getContext}.
 *
 * @public
 */
export interface ContextValues {
  readonly size: number;
}

/**
 * One unit of work's ambient state. Immutable.
 *
 * @public
 */
export interface ExecutionContext {
  /** The span this work runs as. */
  readonly trace: TraceContext;
  /** The id of the request this work is, or was started by. */
  readonly requestId: string | undefined;
  /** The keyed values; read them with {@link getContext}. */
  readonly values: ContextValues;
}

/**
 * A key and the value to give it.
 *
 * @public
 */
export type ContextEntry<T> = readonly [key: ContextKey<T>, value: T];

/**
 * What {@link createExecutionContext} builds a context from.
 *
 * @public
 */
export interface ExecutionContextInit {
  /** The span; a new trace when absent. */
  readonly trace?: TraceContext;
  /** A well-formed request id ({@link isRequestId}). */
  readonly requestId?: string;
  readonly values?: readonly ContextEntry<unknown>[];
}

/** A key's registration: the key and, for a propagated key, its codec. */
export interface ContextKeyRecord {
  readonly key: ContextKey<unknown>;
  readonly codec: ContextCodec<unknown> | undefined;
}

/**
 * Values a unit of work settles after its context was entered: the request
 * locale a request's claim resolves once its route is known. It returns
 * `undefined` until they are settled, and the same entries afterwards.
 */
export type SettledValues = () => ReadonlyMap<ContextKey<unknown>, unknown> | undefined;

/** The state every loaded copy of `jsails` shares. */
interface ContextShared {
  readonly storage: AsyncLocalStorage<ExecutionContext>;
  readonly keys: Map<string, ContextKeyRecord>;
  /** The settled-value source of each context that has one, by identity. */
  readonly settled: WeakMap<ExecutionContext, SettledValues>;
}

const SHARED_KEY = Symbol.for('jsails.executionContext.v2');
const holder = globalThis as unknown as Record<symbol, ContextShared | undefined>;
const shared: ContextShared = (holder[SHARED_KEY] ??= {
  storage: new AsyncLocalStorage<ExecutionContext>(),
  keys: new Map(),
  settled: new WeakMap(),
});
const storage = shared.storage;

const KEY_NAME = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * The shape an inbound `X-Request-Id` must have (Hono's `requestId()` rule):
 * word characters, `-` and `=`, at most 255 long.
 */
const REQUEST_ID = /^[\w\-=]{1,255}$/;

/**
 * Whether `value` is a well-formed request id.
 *
 * @public
 */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

/**
 * Declare a context key. `name` (1 to 64 of `a-z 0-9 . _ -`, starting with a
 * letter; namespace it, as in `jsails.locale`) is the key's identity: declaring
 * it again, from this or another loaded copy of `jsails`, returns the key
 * already declared, and a carrier names the value by it.
 *
 * @throws `context.invalid_key_name` for a malformed name, and
 *   `context.key_conflict` when the name is already declared with the other
 *   propagation.
 * @public
 */
export function createContextKey<T>(
  name: string,
  options: ContextKeyOptions<T> = {},
): ContextKey<T> {
  if (typeof name !== 'string' || !KEY_NAME.test(name)) {
    throw new ContextErrors.Error('invalid_key_name');
  }
  const propagated = options.propagate !== undefined;
  const existing = shared.keys.get(name);
  if (existing !== undefined) {
    if (existing.key.propagated !== propagated) {
      throw new ContextErrors.Error('key_conflict', { key: name });
    }
    return existing.key as ContextKey<T>;
  }
  const key: ContextKey<T> = Object.freeze({ name, propagated });
  shared.keys.set(name, {
    key,
    codec: options.propagate,
  });
  return key;
}

/** The registration of the key named `name`, if one is declared in this process. */
export function contextKeyRecord(name: string): ContextKeyRecord | undefined {
  return shared.keys.get(name);
}

/**
 * Pair `key` with `value` for {@link createExecutionContext} and
 * {@link extendContext}.
 *
 * @public
 */
export function contextEntry<T>(key: ContextKey<T>, value: T): ContextEntry<T> {
  return [key, value];
}

const EMPTY_VALUES: ReadonlyMap<ContextKey<unknown>, unknown> = new Map();

function valuesOf(context: ExecutionContext): ReadonlyMap<ContextKey<unknown>, unknown> {
  return context.values as unknown as ReadonlyMap<ContextKey<unknown>, unknown>;
}

function withEntries(
  base: ReadonlyMap<ContextKey<unknown>, unknown>,
  entries: readonly ContextEntry<unknown>[],
): ContextValues {
  if (entries.length === 0) return base;
  const values = new Map(base);
  for (const [key, value] of entries) {
    if (value === undefined) values.delete(key);
    else values.set(key, value);
  }
  return values;
}

function freezeContext(
  trace: TraceContext,
  requestId: string | undefined,
  values: ContextValues,
  settled: SettledValues | undefined,
): ExecutionContext {
  const context: ExecutionContext = Object.freeze({ trace, requestId, values });
  if (settled !== undefined) shared.settled.set(context, settled);
  return context;
}

/**
 * A new execution context. Without a `trace` it starts a new trace.
 *
 * @throws `context.invalid_request_id` for a malformed `requestId`.
 * @public
 */
export function createExecutionContext(init: ExecutionContextInit = {}): ExecutionContext {
  if (init.requestId !== undefined && !isRequestId(init.requestId)) {
    throw new ContextErrors.Error('invalid_request_id');
  }
  return freezeContext(
    init.trace ?? createRootTrace(),
    init.requestId,
    withEntries(EMPTY_VALUES, init.values ?? []),
    undefined,
  );
}

/**
 * `context` with a source of values settled after it is entered, so one
 * context entry serves a unit of work whose values are not all known up
 * front (a request enters its context before its route resolves the locale).
 * A key set on the context, or on any context derived from it, wins over a
 * settled value; every context derived from the result keeps the source.
 */
export function withSettledValues(
  context: ExecutionContext,
  settled: SettledValues,
): ExecutionContext {
  return freezeContext(context.trace, context.requestId, context.values, settled);
}

/**
 * `base` with `entries` set; an entry whose value is `undefined` removes the
 * key. The trace and request id are kept.
 *
 * @public
 */
export function extendContext(
  base: ExecutionContext,
  entries: readonly ContextEntry<unknown>[],
): ExecutionContext {
  if (entries.length === 0) return base;
  return freezeContext(
    base.trace,
    base.requestId,
    withEntries(valuesOf(base), entries),
    shared.settled.get(base),
  );
}

/**
 * Run `fn` inside `context`, for its synchronous body and every async
 * continuation it starts. Replaces the caller's context whole: nothing of it
 * is visible inside.
 *
 * @public
 */
export function runInContext<T>(context: ExecutionContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Run `fn` in the current context with `key` set to `value` (`undefined`
 * removes it). Outside any context it runs in a new one, with a new trace.
 *
 * @public
 */
export function withContext<V, T>(key: ContextKey<V>, value: V | undefined, fn: () => T): T {
  const current = storage.getStore();
  const entries: readonly ContextEntry<unknown>[] = [[key, value]];
  const next =
    current === undefined
      ? createExecutionContext({ values: entries })
      : extendContext(current, entries);
  return storage.run(next, fn);
}

/**
 * The context this code runs in, or `undefined` outside every unit of work
 * (module evaluation, a top-level script).
 *
 * @public
 */
export function currentContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/**
 * The value of `key` in `context` (the current context by default), or
 * `undefined` when it is unset or there is no context.
 *
 * @public
 */
export function getContext<T>(
  key: ContextKey<T>,
  context: ExecutionContext | undefined = storage.getStore(),
): T | undefined {
  if (context === undefined) return undefined;
  const own = valuesOf(context).get(key);
  if (own !== undefined) return own as T;
  return shared.settled.get(context)?.()?.get(key) as T | undefined;
}

/**
 * Every key of `context` with its value: the keys set on it in insertion
 * order, then the settled values no set key shadows.
 */
export function contextEntries(
  context: ExecutionContext,
): Iterable<readonly [ContextKey<unknown>, unknown]> {
  const own = valuesOf(context);
  const settled = shared.settled.get(context)?.();
  if (settled === undefined || settled.size === 0) return own.entries();
  return [...own.entries(), ...[...settled].filter(([key]) => !own.has(key))];
}
