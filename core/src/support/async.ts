/**
 * The `Async` namespace: sleep, retry, debounce, throttle, memoize, bounded concurrency, timeouts, and benchmarking over plain promises.
 */

import {
  assertPositiveInteger,
  assertNonNegativeInteger,
  type ArgumentErrorFactory,
} from '../validation/primitives.js';
import {
  debounce as esDebounce,
  memoize as esMemoize,
  throttle as esThrottle,
} from 'es-toolkit/function';
import { createLimiter } from './concurrency.js';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { Awaitable } from '../contracts/awaitable.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const ASYNC_ERRORS = {
  expected_positive_integer: {
    kind: 'internal',
    message: '{operation}: expected a positive integer',
    context: { operation: 'identifier' },
  },
  expected_non_negative_integer: {
    kind: 'internal',
    message: '{operation}: expected a non-negative integer',
    context: { operation: 'identifier' },
  },
  expected_function: {
    kind: 'internal',
    message: '{operation}: expected a function',
    context: { operation: 'identifier' },
  },
  expected_non_negative_number: {
    kind: 'internal',
    message: '{operation}: expected a non-negative finite number',
    context: { operation: 'identifier' },
  },
  expected_array: {
    kind: 'internal',
    message: '{operation}: expected an array',
    context: { operation: 'identifier' },
  },
  invalid_backoff: {
    kind: 'internal',
    message: 'Async.retry: expected backoff to be an array',
  },
  invalid_delay: {
    kind: 'internal',
    message: 'Async.retry: expected delay to be a number or a function',
  },
  retries_exhausted: {
    kind: 'internal',
    message: 'Async.retry: exhausted attempts',
  },
  timeout_too_long: {
    kind: 'internal',
    message: 'Async.timeout: expected a delay of at most 2147483647 ms',
    suggestion: 'a longer wait needs a scheduled job, not a timer',
  },
} as const;

/**
 * The `Async` namespace's codes, `async.*`: an argument of the wrong type or
 * range. Each is the calling code's bug; none echoes the value.
 *
 * @public
 */
export const AsyncErrors: ErrorRegistry<'async', typeof ASYNC_ERRORS> = defineErrors(
  'async',
  ASYNC_ERRORS,
);

const asyncError: ArgumentErrorFactory<
  'expected_positive_integer' | 'expected_non_negative_integer'
> = (problem, operation) => new AsyncErrors.Error(problem, { operation });

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertFunction(value: unknown, operation: string): asserts value is Function {
  if (typeof value !== 'function') {
    throw new AsyncErrors.Error('expected_function', { operation: `Async.${operation}` });
  }
}

function assertNonNegativeNumber(value: unknown, operation: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AsyncErrors.Error('expected_non_negative_number', {
      operation: `Async.${operation}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Own helpers
// ---------------------------------------------------------------------------

/**
 * Resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  assertNonNegativeNumber(ms, 'sleep');
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Alias of `sleep`. */
export function delay(ms: number): Promise<void> {
  return sleep(ms);
}

/**
 * Wraps a function so it runs at most once.
 * Subsequent calls return the first call's result.
 */
export function once<F extends (...args: never[]) => unknown>(fn: F): F {
  assertFunction(fn, 'once');
  let called = false;
  let result: ReturnType<F>;
  return ((...args: never[]) => {
    if (!called) {
      called = true;
      result = fn(...args) as ReturnType<F>;
    }
    return result;
  }) as unknown as F;
}

// ---------------------------------------------------------------------------
// Wraps: es-toolkit (debounce / throttle / memoize)
// ---------------------------------------------------------------------------

export interface DebounceOptions {
  readonly leading?: boolean;
  readonly trailing?: boolean;
}

export interface ThrottleOptions {
  readonly leading?: boolean;
  readonly trailing?: boolean;
}

function toEsDebounceOptions(opts?: DebounceOptions): Record<string, unknown> {
  if (!opts) return {};
  const edges: string[] = [];
  if (opts.leading) edges.push('leading');
  if (opts.trailing !== false) edges.push('trailing');
  return { edges };
}

function toEsThrottleOptions(opts?: ThrottleOptions): Record<string, unknown> {
  if (!opts) return {};
  const edges: string[] = [];
  if (opts.leading !== false) edges.push('leading');
  if (opts.trailing !== false) edges.push('trailing');
  return { edges };
}

export function debounce<F extends (...args: never[]) => void>(
  fn: F,
  waitMs: number,
  options?: DebounceOptions,
): F & { cancel: () => void } {
  assertFunction(fn, 'debounce');
  assertNonNegativeNumber(waitMs, 'debounce');
  return esDebounce(
    fn as unknown as (...args: unknown[]) => void,
    waitMs,
    toEsDebounceOptions(options),
  ) as unknown as F & {
    cancel: () => void;
  };
}

export function throttle<F extends (...args: never[]) => void>(
  fn: F,
  waitMs: number,
  options?: ThrottleOptions,
): F & { cancel: () => void } {
  assertFunction(fn, 'throttle');
  assertNonNegativeNumber(waitMs, 'throttle');
  return esThrottle(
    fn as unknown as (...args: unknown[]) => void,
    waitMs,
    toEsThrottleOptions(options),
  ) as unknown as F & {
    cancel: () => void;
  };
}

export function memoize<F extends (...args: never[]) => unknown>(
  fn: F,
  options?: { cache?: Map<unknown, ReturnType<F>> },
): F & { cache: Map<unknown, ReturnType<F>> } {
  assertFunction(fn, 'memoize');
  // es-toolkit's generic constraint `F extends (...args: any) => any` differs
  // from our stricter constraint. The runtime behavior is identical; cast
  // through unknown to bridge.
  return (esMemoize as unknown as (f: Function, o?: unknown) => Function)(
    fn,
    options,
  ) as unknown as F & {
    cache: Map<unknown, ReturnType<F>>;
  };
}

// ---------------------------------------------------------------------------
// Own: exponential retry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Total retries after the first attempt (default 10). */
  readonly retries?: number;
  /** Exponential backoff factor (exponential retry). */
  readonly factor?: number;
  /** First backoff delay in ms (exponential retry). */
  readonly minTimeout?: number;
  /** Backoff cap in ms (exponential retry). */
  readonly maxTimeout?: number;
  /** Randomize each backoff delay (exponential retry). */
  readonly randomize?: boolean;
  /**
   * Explicit per-attempt delays (the Laravel array form). Supplying this runs
   * exactly `backoff.length + 1` attempts, waiting `backoff[attempt - 1]` ms
   * before each retry. Takes precedence over the exponential options.
   */
  backoff?: readonly number[];
  /**
   * Delay before a retry: a fixed number of ms, or a function of the failed
   * attempt (1-based) and the error. Used when `backoff` is absent.
   */
  readonly delay?: number | ((attempt: number, error: unknown) => number);
  /**
   * Retry only when this resolves `true` (the Laravel `$when` guard). Receives
   * the failed attempt number (1-based) and the error.
   */
  readonly shouldRetry?: (error: unknown, attempt: number) => Awaitable<boolean>;
  /** Called after a failed attempt, before the delay; may be async. */
  readonly onFailedAttempt?: (error: unknown, attempt: number) => Awaitable<void>;
  /**
   * Injectable sleep used for the explicit-backoff path (test seam). Defaults
   * to {@link sleep}.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Retry `fn` on failure.
 *
 * `fn` receives the 1-based attempt number. Two scheduling modes:
 * - exponential (default): an owned exponential loop with `factor` /
 *   `minTimeout` / `maxTimeout` / `randomize`;
 * - explicit (`backoff`, `delay`, `shouldRetry`, or `sleep` supplied): a short
 *   loop that honors the array/callable delay, the per-error guard, and the
 *   injected sleep — the Laravel `retry()` shape.
 */
export function retry<T>(fn: (attempt: number) => Promise<T>, options?: RetryOptions): Promise<T> {
  assertFunction(fn, 'retry');
  if (options?.retries !== undefined)
    assertNonNegativeInteger(options.retries, 'Async.retry', asyncError);
  if (options?.backoff !== undefined) {
    if (!Array.isArray(options.backoff)) {
      throw new AsyncErrors.Error('invalid_backoff');
    }
    for (const delay of options.backoff) assertNonNegativeNumber(delay, 'retry');
  }
  if (
    options?.delay !== undefined &&
    typeof options.delay !== 'number' &&
    typeof options.delay !== 'function'
  ) {
    throw new AsyncErrors.Error('invalid_delay');
  }
  if (typeof options?.delay === 'number') assertNonNegativeNumber(options.delay, 'retry');
  if (options?.shouldRetry !== undefined) assertFunction(options.shouldRetry, 'retry');
  if (options?.sleep !== undefined) assertFunction(options.sleep, 'retry');

  const explicit =
    options?.backoff !== undefined ||
    options?.delay !== undefined ||
    options?.shouldRetry !== undefined ||
    options?.sleep !== undefined;

  if (!explicit) {
    return runExponentialRetry(fn, options ?? {});
  }

  return runExplicitRetry(fn, options ?? {});
}

/** The exponential retry loop. */
async function runExponentialRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const retries = options.retries ?? 10;
  const factor = options.factor ?? 2;
  const minTimeout = options.minTimeout ?? 1000;
  const maxTimeout = options.maxTimeout ?? Number.POSITIVE_INFINITY;
  const randomize = options.randomize ?? false;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt > retries) throw error;
      if (options.onFailedAttempt !== undefined) {
        await options.onFailedAttempt(error, attempt);
      }
      const exponential = Math.min(minTimeout * factor ** (attempt - 1), maxTimeout);
      const wait = randomize ? Math.random() * exponential : exponential;
      if (wait > 0) await sleep(wait);
    }
  }
}

/** The explicit-backoff retry loop (Laravel `retry()` semantics). */
async function runExplicitRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts =
    options.backoff !== undefined ? options.backoff.length + 1 : (options.retries ?? 10) + 1;
  const sleepFn = options.sleep ?? sleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts) throw error;
      if (options.shouldRetry !== undefined) {
        const allowed = await options.shouldRetry(error, attempt);
        if (!allowed) throw error;
      }
      if (options.onFailedAttempt !== undefined) {
        await options.onFailedAttempt(error, attempt);
      }
      const wait =
        options.backoff?.[attempt - 1] ??
        (typeof options.delay === 'function'
          ? options.delay(attempt, error)
          : (options.delay ?? 0));
      if (wait > 0) await sleepFn(wait);
    }
  }

  throw new AsyncErrors.Error('retries_exhausted');
}

// ---------------------------------------------------------------------------
// Own: concurrency limiter
// ---------------------------------------------------------------------------

export function limit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  assertPositiveInteger(concurrency, 'Async.limit', asyncError);
  const run = createLimiter(concurrency);
  return <T>(fn: () => Promise<T>): Promise<T> => {
    if (typeof fn !== 'function') {
      return Promise.reject(
        new AsyncErrors.Error('expected_function', { operation: 'Async.limit' }),
      );
    }
    return run(fn);
  };
}

// ---------------------------------------------------------------------------
// Own: concurrency mapping
// ---------------------------------------------------------------------------

export interface MapConcurrentOptions {
  readonly concurrency?: number;
  readonly stopOnError?: boolean;
}

export function mapConcurrent<T, U>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<U>,
  options?: MapConcurrentOptions,
): Promise<U[]> {
  if (!Array.isArray(items)) {
    throw new AsyncErrors.Error('expected_array', { operation: 'Async.mapConcurrent' });
  }
  assertFunction(mapper, 'mapConcurrent');
  if (options?.concurrency !== undefined) {
    assertPositiveInteger(options.concurrency, 'Async.mapConcurrent', asyncError);
  }
  return runConcurrent(items, mapper, options?.concurrency, options?.stopOnError ?? true);
}

async function runConcurrent<T, U>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<U>,
  concurrency: number | undefined,
  stopOnError: boolean,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  const errors: unknown[] = [];
  const limiter = concurrency === undefined ? undefined : createLimiter(concurrency);

  const run = async (item: T, index: number): Promise<void> => {
    try {
      results[index] = await mapper(item, index);
    } catch (error) {
      if (stopOnError) throw error;
      errors.push(error);
    }
  };

  const tasks = items.map((item, index) =>
    limiter === undefined ? run(item, index) : limiter(() => run(item, index)),
  );
  await Promise.all(tasks);

  if (errors.length > 0) throw new AggregateError(errors);
  return results;
}

// ---------------------------------------------------------------------------
// Native
// ---------------------------------------------------------------------------

export interface TimeoutHandle {
  readonly signal: AbortSignal;
  /** Cancel the timer; safe to call more than once. */
  clear(): void;
}

/** The largest delay `setTimeout` supports without clamping. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * A timeout signal with explicit cleanup.
 *
 * The timer is **unref'd by default**, matching native `AbortSignal.timeout`:
 * it never keeps the process alive. Pass `{ keepAlive: true }` for a ref'd
 * timer that does keep the event loop alive until it fires or `clear()` is
 * called — the form for request-scoped work whose only pending handle is the
 * request itself. The abort reason is a `TimeoutError` `DOMException`.
 *
 * Always call `clear()` when the operation settles; the handle is the only way
 * to release the timer early.
 */
export function timeout(ms: number, options?: { keepAlive?: boolean }): TimeoutHandle {
  assertNonNegativeNumber(ms, 'timeout');
  if (ms > MAX_TIMEOUT_MS) {
    throw new AsyncErrors.Error('timeout_too_long');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, ms);

  if (options?.keepAlive !== true) {
    const refable = timer as unknown as { unref?: () => void };
    refable.unref?.();
  }

  let cleared = false;
  return {
    signal: controller.signal,
    clear() {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
    },
  };
}

export interface BenchmarkResult<T> {
  readonly result: T;
  readonly durationMs: number;
}

/**
 * Run a function and measure its wall-clock duration.
 *
 * Errors propagate unchanged; the timer is only returned with a successful
 * result. Uses `performance.now()`.
 */
export async function benchmark<T>(fn: () => Awaitable<T>): Promise<BenchmarkResult<T>> {
  assertFunction(fn, 'benchmark');
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Async: Readonly<{
  sleep: typeof sleep;
  delay: typeof delay;
  once: typeof once;
  debounce: typeof debounce;
  throttle: typeof throttle;
  memoize: typeof memoize;
  retry: typeof retry;
  limit: typeof limit;
  mapConcurrent: typeof mapConcurrent;
  timeout: typeof timeout;
  benchmark: typeof benchmark;
}> = Object.freeze({
  sleep,
  delay,
  once,
  debounce,
  throttle,
  memoize,
  retry,
  limit,
  mapConcurrent,
  timeout,
  benchmark,
});
