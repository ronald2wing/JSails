/**
 * Fixed-window counters for the package's rate limiter, kept apart from every
 * cache: a counter lives in its own bounded map or under its own Valkey
 * prefix, so a flood of limiter keys can never evict a cache entry and cache
 * pressure can never reset a limit. Not exported from the package: the
 * security cluster's `RateLimitStore` replaces this module, the limiter, and
 * `throttle` together.
 */

import type { ValkeyConnections, ValkeyScript } from 'jsails/plugin-sdk';

import { ExpiryHeap } from './expiry-heap.js';
import { backendError, resolvePrefix } from './valkey-backend.js';

/** Counts hits per key; the first hit of a key starts its TTL. */
export interface WindowCounter {
  /** Add one hit and return the new count. */
  increment(key: string, ttlMs: number): Promise<number>;
}

/** Default cap on live counters in a {@link MemoryWindowCounter}. */
const DEFAULT_MAX_COUNTERS = 10_000;

/** The Valkey counters' key segment inside the app key prefix. */
const RATE_LIMIT_KEY_SEGMENT = 'ratelimit';

/** `INCR` plus a first-hit `PEXPIRE`, atomic on the server. */
const INCREMENT_SCRIPT = `-- jsails:window-increment
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

interface Counter {
  count: number;
  readonly expiresAt: number;
}

/**
 * In-process counters, at most `maxCounters` of them. Past the cap, expired
 * counters go first, then counters hit only once (oldest first): resetting
 * one of those grants at most one extra hit, whereas evicting a counter near
 * its limit would hand an attacker who floods fresh keys a full new window.
 * Only when no count-1 counter is left does the oldest counter go. The counter
 * just written is never evicted. Expired counters are found through an expiry
 * heap, so a write at the cap costs O(log n), not a scan.
 */
export class MemoryWindowCounter implements WindowCounter {
  readonly #now: () => number;
  readonly #maxCounters: number;
  readonly #counters = new Map<string, Counter>();
  /** Keys of counters at one hit, in creation order. */
  readonly #singletons = new Set<string>();
  readonly #expiries = new ExpiryHeap();

  constructor(now: () => number, maxCounters: number = DEFAULT_MAX_COUNTERS) {
    this.#now = now;
    this.#maxCounters = maxCounters;
  }

  get size(): number {
    return this.#counters.size;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const now = this.#now();
    const counter = this.#counters.get(key);
    if (counter !== undefined && now < counter.expiresAt) {
      counter.count += 1;
      this.#singletons.delete(key);
      return counter.count;
    }
    this.#drop(key);
    this.#counters.set(key, { count: 1, expiresAt: now + ttlMs });
    this.#singletons.add(key);
    this.#expiries.push(now + ttlMs, key);
    this.#enforceCap(key, now);
    this.#expiries.compact(this.#counters.size, () => this.#pairs());
    return 1;
  }

  #drop(key: string): void {
    this.#counters.delete(key);
    this.#singletons.delete(key);
  }

  #enforceCap(written: string, now: number): void {
    if (this.#counters.size <= this.#maxCounters) return;
    this.#expiries.drain(now, (key) => {
      const counter = this.#counters.get(key);
      if (counter !== undefined && counter.expiresAt <= now) this.#drop(key);
    });
    this.#evictFrom(this.#singletons, written);
    this.#evictFrom(this.#counters.keys(), written);
  }

  #evictFrom(keys: Iterable<string>, written: string): void {
    for (const key of keys) {
      if (this.#counters.size <= this.#maxCounters) return;
      if (key !== written) this.#drop(key);
    }
  }

  *#pairs(): Iterable<readonly [string, number]> {
    for (const [key, counter] of this.#counters) yield [key, counter.expiresAt];
  }
}

/** Counters shared by every process on the app's Valkey, under `<app>:ratelimit`. */
export class ValkeyWindowCounter implements WindowCounter {
  readonly #increment: ValkeyScript;
  readonly #prefix: string;

  constructor(connections: ValkeyConnections, prefix?: string) {
    this.#prefix = resolvePrefix(prefix, `${connections.prefix}:${RATE_LIMIT_KEY_SEGMENT}`);
    this.#increment = connections.script({ lua: INCREMENT_SCRIPT });
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    let reply: unknown;
    try {
      reply = await this.#increment.run([`${this.#prefix}:${key}`], [ttlMs]);
    } catch (error) {
      throw backendError('rate_limit', error);
    }
    const count = Number(reply);
    if (!Number.isSafeInteger(count) || count < 1) throw backendError('rate_limit', undefined);
    return count;
  }
}
