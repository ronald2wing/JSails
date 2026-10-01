/**
 * Fixed-window rate limiting.
 *
 * {@link FixedWindowRateLimiter} counts requests per key inside a fixed time
 * window. Each window maps to its own counter derived from `now`, so the
 * window is fixed (not sliding): a request in the next window starts a fresh
 * counter and the previous one expires on its own TTL. Counting is one atomic
 * increment, in process or, given the app's Valkey connections, on the server
 * across every process. A counter's key carries the limiter's `limit` and
 * `windowMs`, so two limiters of different shapes never share a count for one
 * key, and the counters never share storage with a cache.
 *
 * This module, `throttle`, and their counters are replaced by the security
 * cluster's `RateLimitStore`.
 */

import { CacheErrors } from 'jsails/cache';
import { isPositiveInteger, type ValkeyConnections } from 'jsails/plugin-sdk';

import { assertConnections } from './valkey-backend.js';
import { MemoryWindowCounter, ValkeyWindowCounter, type WindowCounter } from './window-counter.js';

/**
 * The outcome of a rate-limit check.
 *
 * @public
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  readonly allowed: boolean;
  /** Requests remaining in the current window when allowed; `0` when blocked. */
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets (derived from `now`). */
  readonly resetAt: number;
}

/**
 * A rate limiter.
 *
 * @public
 */
export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

/**
 * Options for {@link FixedWindowRateLimiter}.
 *
 * @public
 */
export interface RateLimiterOptions {
  /** Maximum allowed requests per window. Must be a positive integer. */
  readonly limit: number;
  /** Window length in milliseconds. Must be a positive integer. */
  readonly windowMs: number;
  /**
   * The app's Valkey connections, to count across processes (under
   * `<app key prefix>:ratelimit`). Without them the limiter counts in this
   * process only.
   */
  readonly connections?: ValkeyConnections;
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A fixed-window rate limiter.
 *
 * @public
 */
export class FixedWindowRateLimiter implements RateLimiter {
  readonly #counter: WindowCounter;
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: RateLimiterOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new CacheErrors.Error('invalid_option', { option: 'FixedWindowRateLimiter' });
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
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
    this.#counter =
      options.connections === undefined
        ? new MemoryWindowCounter(this.#now)
        : new ValkeyWindowCounter(assertConnections(options.connections));
  }

  async check(key: string): Promise<RateLimitResult> {
    if (typeof key !== 'string' || key.length === 0) throw new CacheErrors.Error('invalid_key');
    const current = this.#now();
    const windowStart = Math.floor(current / this.#windowMs) * this.#windowMs;
    const resetAt = windowStart + this.#windowMs;
    const bucketKey = `${key}:${String(this.#limit)}:${String(this.#windowMs)}:${String(windowStart)}`;
    const next = await this.#counter.increment(bucketKey, resetAt - current);
    return next <= this.#limit
      ? { allowed: true, remaining: this.#limit - next, resetAt }
      : { allowed: false, remaining: 0, resetAt };
  }
}

/**
 * Build a value-free `429 Too Many Requests` response. The body and headers
 * carry no request details. An optional `retryAfterSeconds` sets the
 * `Retry-After` header; a non-finite value is omitted.
 *
 * @public
 */
export function rateLimitResponse(retryAfterSeconds?: number): Response {
  const headers = new Headers();
  headers.set('content-type', 'text/plain; charset=utf-8');
  headers.set('cache-control', 'no-store');
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    headers.set('retry-after', String(Math.max(0, Math.ceil(retryAfterSeconds))));
  }
  return new Response('Too Many Requests', { status: 429, headers });
}

/**
 * A Hono-agnostic rate-limit guard: a middleware-shaped function that calls
 * `next` when the limiter allows the key derived from `context`, and returns a
 * value-free `429` otherwise. It imports no HTTP framework — the caller supplies
 * `keyFn` and `next`, so it composes with Hono, a plain handler, or any other
 * request model.
 *
 * The blocked response carries no `Retry-After`, because the guard does not own
 * a clock. A caller that wants one can bypass the guard, call `limiter.check`
 * directly, and pass the seconds until `resetAt` to {@link rateLimitResponse}.
 *
 * @public
 */
export function guardRateLimit<TContext>(
  limiter: RateLimiter,
  keyFn: (context: TContext) => string,
  next: (context: TContext) => Response | Promise<Response>,
): (context: TContext) => Promise<Response> {
  return async (context) => {
    const result = await limiter.check(keyFn(context));
    if (!result.allowed) {
      return rateLimitResponse();
    }
    return next(context);
  };
}
