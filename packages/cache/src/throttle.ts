/**
 * API-facing rate limiting built on {@link FixedWindowRateLimiter}: `throttle`
 * checks a key and returns either an allow decision or a value-free
 * `429 Too Many Requests` response with a `Retry-After` header derived from
 * the window's reset time.
 *
 * Composing with resource handlers is an early return in the handler:
 *
 * ```ts
 * const decision = await throttle({ key: `login:${sessionId}`, limit: 5, windowMs: 60_000 });
 * if (!decision.allowed) return decision.response;
 * ```
 *
 * Without `connections` the counts live in this process, which suits tests,
 * demos and single-process deployments; a multi-process deployment passes the
 * app's Valkey connections so every process shares them. Limiters are reused
 * across calls per connections, clock, limit and window, so the counts of one
 * shape persist between calls. The security cluster's `RateLimitStore`
 * replaces this module.
 */

import { CacheErrors } from 'jsails/cache';
import { isPositiveInteger, type ValkeyConnections } from 'jsails/plugin-sdk';

import { FixedWindowRateLimiter, rateLimitResponse } from './rate-limiter.js';

/**
 * Options for {@link throttle}.
 *
 * @public
 */
export interface ThrottleOptions {
  /** The rate-limit key (e.g. `login:<sessionId>` or `api:<ip>`). */
  readonly key: string;
  /** Maximum allowed requests per window. Must be a positive integer. */
  readonly limit: number;
  /** Window length in milliseconds. Must be a positive integer. */
  readonly windowMs: number;
  /** The app's Valkey connections, to count across processes. */
  readonly connections?: ValkeyConnections;
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The outcome of a throttle check.
 *
 * @public
 */
export interface ThrottleDecision {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Requests remaining in the current window when allowed; `0` when blocked. */
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets. */
  readonly resetAt: number;
  /**
   * A value-free `429 Too Many Requests` response carrying `Retry-After`, or
   * `null` when the request is allowed.
   */
  readonly response: Response | null;
}

/** The clock used when a call injects none; one function so it keys the cache. */
const systemNow = (): number => Date.now();

/** Stands in for "no connections" as a weak key. */
const IN_PROCESS: object = Object.freeze({});

/**
 * Limiters reused across calls, keyed by connections (or {@link IN_PROCESS}),
 * then clock, then `limit:windowMs`. Weak keys let a dropped provider or clock
 * take its limiters with it.
 */
const limiters = new WeakMap<object, WeakMap<() => number, Map<string, FixedWindowRateLimiter>>>();

/**
 * Check a rate-limit key and return a decision. Never throws for a normal
 * blocked request; invalid options throw `cache.invalid_option` (or
 * `cache.invalid_key`) at call time.
 *
 * @public
 */
export async function throttle(options: ThrottleOptions): Promise<ThrottleDecision> {
  assertOptions(options);
  const { key, limit, windowMs, connections } = options;
  const now = options.now ?? systemNow;

  const result = await limiterFor(connections, now, limit, windowMs).check(key);
  if (result.allowed) {
    return { allowed: true, remaining: result.remaining, resetAt: result.resetAt, response: null };
  }
  const retryAfterSeconds = Math.max(0, (result.resetAt - now()) / 1000);
  return {
    allowed: false,
    remaining: 0,
    resetAt: result.resetAt,
    response: rateLimitResponse(retryAfterSeconds),
  };
}

function assertOptions(options: ThrottleOptions): void {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new CacheErrors.Error('invalid_option', { option: 'throttle' });
  }
  if (typeof options.key !== 'string' || options.key.length === 0) {
    throw new CacheErrors.Error('invalid_key');
  }
  if (!isPositiveInteger(options.limit)) {
    throw new CacheErrors.Error('invalid_option', { option: 'limit' });
  }
  if (!isPositiveInteger(options.windowMs)) {
    throw new CacheErrors.Error('invalid_option', { option: 'windowMs' });
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new CacheErrors.Error('invalid_option', { option: 'now' });
  }
}

function limiterFor(
  connections: ValkeyConnections | undefined,
  now: () => number,
  limit: number,
  windowMs: number,
): FixedWindowRateLimiter {
  const owner = connections ?? IN_PROCESS;
  let byClock = limiters.get(owner);
  if (byClock === undefined) {
    byClock = new WeakMap();
    limiters.set(owner, byClock);
  }
  let byShape = byClock.get(now);
  if (byShape === undefined) {
    byShape = new Map();
    byClock.set(now, byShape);
  }
  const shape = `${String(limit)}:${String(windowMs)}`;
  let limiter = byShape.get(shape);
  if (limiter === undefined) {
    limiter = new FixedWindowRateLimiter({
      limit,
      windowMs,
      now,
      ...(connections === undefined ? {} : { connections }),
    });
    byShape.set(shape, limiter);
  }
  return limiter;
}
