import { isNonNegativeInteger, isPositiveInteger } from '../internal/primitive-guards.js';
import { debounce as esDebounce, memoize as esMemoize, throttle as esThrottle } from 'es-toolkit';
import { createLimiter } from '../internal/concurrency.js';

import { SupportError } from './errors.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export class AsyncError extends SupportError {
  readonly code = 'invalid_argument';
}

// ---------------------------------------------------------------------------
// Validation helpers (value-free — never echo the offending value)
// ---------------------------------------------------------------------------

function assertFunction(value: unknown, operation: string): asserts value is Function {
  if (typeof value !== 'function') {
    throw new AsyncError(`Async.${operation}: expected a function`);
  }
}

function assertNonNegativeNumber(value: unknown, operation: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AsyncError(`Async.${operation}: expected a non-negative finite number`);
  }
}

function assertPositiveInteger(value: unknown, operation: string): asserts value is number {
  if (!isPositiveInteger(value)) {
    throw new AsyncError(`Async.${operation}: expected a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, operation: string): asserts value is number {
  if (!isNonNegativeInteger(value)) {
    throw new AsyncError(`Async.${operation}: expected a non-negative integer`);
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
  leading?: boolean;
  trailing?: boolean;
}

export interface ThrottleOptions {
  leading?: boolean;
  trailing?: boolean;
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
  retries?: number;
  /** Exponential backoff factor (exponential retry). */
  factor?: number;
  /** First backoff delay in ms (exponential retry). */
  minTimeout?: number;
  /** Backoff cap in ms (exponential retry). */
  maxTimeout?: number;
  /** Randomize each backoff delay (exponential retry). */
  randomize?: boolean;
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
  delay?: number | ((attempt: number, error: unknown) => number);
  /**
   * Retry only when this resolves `true` (the Laravel `$when` guard). Receives
   * the failed attempt number (1-based) and the error.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Called after a failed attempt, before the delay; may be async. */
  onFailedAttempt?: (error: unknown, attempt: number) => void | Promise<void>;
  /**
   * Injectable sleep used for the explicit-backoff path (test seam). Defaults
   * to {@link sleep}.
   */
  sleep?: (ms: number) => Promise<void>;
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
  if (options?.retries !== undefined) assertNonNegativeInteger(options.retries, 'retry');
  if (options?.backoff !== undefined) {
    if (!Array.isArray(options.backoff)) {
      throw new AsyncError('Async.retry: expected backoff to be an array');
    }
    for (const delay of options.backoff) assertNonNegativeNumber(delay, 'retry');
  }
  if (
    options?.delay !== undefined &&
    typeof options.delay !== 'number' &&
    typeof options.delay !== 'function'
  ) {
    throw new AsyncError('Async.retry: expected delay to be a number or a function');
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

  throw new AsyncError('Async.retry: exhausted attempts');
}

// ---------------------------------------------------------------------------
// Own: concurrency limiter
// ---------------------------------------------------------------------------

export function limit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  assertPositiveInteger(concurrency, 'limit');
  const run = createLimiter(concurrency);
  return <T>(fn: () => Promise<T>): Promise<T> => {
    if (typeof fn !== 'function') {
      return Promise.reject(new AsyncError('Async.limit: expected a function'));
    }
    return run(fn);
  };
}

// ---------------------------------------------------------------------------
// Own: concurrency mapping
// ---------------------------------------------------------------------------

export interface MapConcurrentOptions {
  concurrency?: number;
  stopOnError?: boolean;
}

export function mapConcurrent<T, U>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<U>,
  options?: MapConcurrentOptions,
): Promise<U[]> {
  if (!Array.isArray(items)) {
    throw new AsyncError('Async.mapConcurrent: items must be an array');
  }
  assertFunction(mapper, 'mapConcurrent');
  if (options?.concurrency !== undefined) {
    assertPositiveInteger(options.concurrency, 'mapConcurrent');
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
    throw new AsyncError(`Async.timeout: expected a delay no greater than ${MAX_TIMEOUT_MS}`);
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
  result: T;
  durationMs: number;
}

/**
 * Run a function and measure its wall-clock duration.
 *
 * Errors propagate unchanged; the timer is only returned with a successful
 * result. Uses `performance.now()`.
 */
export async function benchmark<T>(fn: () => T | Promise<T>): Promise<BenchmarkResult<T>> {
  assertFunction(fn, 'benchmark');
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}

// ---------------------------------------------------------------------------
// Frozen namespace
// ---------------------------------------------------------------------------

export const Async = Object.freeze({
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
