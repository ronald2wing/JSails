/**
 * Cache store implementations: the in-memory default and the Valkey backend,
 * both over the core {@link import('jsails/cache').CacheStore} contract.
 *
 * - {@link MemoryCacheStore} is the zero-config default: an in-memory store
 *   with an injectable clock (no connection), used for tests, demos, and
 *   single-process deployments.
 * - {@link ValkeyCacheStore} is a Valkey-backed store over ioredis. It is
 *   fully lazy: importing this module loads no ioredis, constructing the store
 *   opens no connection, and the client is created and connected on the first
 *   operation only. Keys are namespaced under a prefix, commands use a finite
 *   retry budget and fail fast, and every error surfaced to the caller is a
 *   value-free {@link CacheError} — a connection URL may embed credentials and
 *   is never echoed.
 */

import { CacheError, type CacheStore } from 'jsails/cache';
import {
  createLazyValkeyClient,
  isPositiveInteger,
  resolveValkeyPrefix,
  sanitizeBackendError,
  type LazyValkeyClient,
  type ValkeyClientDependencies,
} from 'jsails/plugin-sdk';

/** Parse a stored counter; a malformed value counts as zero (never throws). */
export function parseCount(value: string): number {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

/**
 * `INCR` plus a first-increment `PEXPIRE`, evaluated server-side so the pair is
 * atomic. `KEYS[1]` is the counter key, `ARGV[1]` the window TTL in ms.
 */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/** Default key prefix for the Valkey-backed store. */
const DEFAULT_CACHE_PREFIX = 'jsails:cache';

/** Default cap on live entries in a {@link MemoryCacheStore}. */
const DEFAULT_MEMORY_CACHE_MAX_ENTRIES = 10_000;

/** Options for {@link MemoryCacheStore}. */
export interface MemoryCacheStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Maximum live entries. Expired entries are swept first; if the store is
   * still over the cap, the oldest insertions are evicted. Defaults to 10 000.
   */
  readonly maxEntries?: number;
}

/**
 * In-memory cache store. It holds no external resources: `close` drops the
 * entries and any in-flight bookkeeping, and is idempotent. Construct with
 * `new MemoryCacheStore({ now?, maxEntries? })`.
 *
 * Entries are bounded: a TTL alone does not free memory, because an expired
 * entry is only removed when its own key is read. A store fed unique keys
 * (query-string cache keys, rate-limit buckets) would otherwise grow for the
 * process lifetime, so `set` sweeps expired entries and then evicts the oldest
 * insertions once the cap is reached.
 */
export class MemoryCacheStore implements CacheStore {
  readonly #now: () => number;
  readonly #maxEntries: number;
  #writesSinceSweep = 0;
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(options: MemoryCacheStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('MemoryCacheStore requires an options object');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (options.maxEntries !== undefined && !isPositiveInteger(options.maxEntries)) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    this.#now = options.now ?? (() => Date.now());
    this.#maxEntries = options.maxEntries ?? DEFAULT_MEMORY_CACHE_MAX_ENTRIES;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: this.#now() + ttlMs });
    this.#enforceCap();
  }

  /**
   * Keep the store within `maxEntries`. Expired entries go first (they are
   * dead weight regardless of the cap); if the store is still over, the oldest
   * insertions are dropped. `Map` preserves insertion order, so the first keys
   * are the oldest.
   *
   * The full expiry sweep is O(maxEntries), so at capacity it runs once per
   * `maxEntries / 10` writes rather than on every write; in between, a write
   * over the cap evicts the single oldest entry in O(1).
   */
  #enforceCap(): void {
    if (this.#entries.size <= this.#maxEntries) {
      return;
    }
    this.#writesSinceSweep += 1;
    if (this.#writesSinceSweep >= Math.max(1, Math.ceil(this.#maxEntries / 10))) {
      this.#writesSinceSweep = 0;
      const now = this.#now();
      for (const [key, entry] of this.#entries) {
        if (now >= entry.expiresAt) {
          this.#entries.delete(key);
        }
      }
    }
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) {
        break;
      }
      this.#entries.delete(key);
    }
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string> {
    return rememberWith(this, this.#inFlight, key, ttlMs, loader);
  }

  /**
   * Increment synchronously so concurrent callers cannot interleave a
   * read-then-write. The TTL is set only when the counter is created, which
   * keeps the window fixed rather than sliding on every hit.
   */
  async increment(key: string, ttlMs: number): Promise<number> {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (entry === undefined || now >= entry.expiresAt) {
      this.#entries.set(key, { value: '1', expiresAt: now + ttlMs });
      return 1;
    }
    const next = parseCount(entry.value) + 1;
    this.#entries.set(key, { value: String(next), expiresAt: entry.expiresAt });
    return next;
  }

  async close(): Promise<void> {
    this.#entries.clear();
    this.#inFlight.clear();
  }
}

/** Options for {@link ValkeyCacheStore}. */
export interface ValkeyCacheStoreOptions {
  /** Valkey URL. Falls back to `VALKEY_URL`. */
  readonly valkeyUrl?: string;
  /** Key prefix. Defaults to `jsails:cache`. */
  readonly prefix?: string;
  /** Invoked with a sanitized error when a client fails after connecting. */
  readonly onError?: (error: Error) => void;
}

/** The slice of an ioredis client the Valkey-backed stores depend on. */
export interface ValkeyRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/**
 * Test seam shared by the Valkey-backed cache and mutex stores: the ioredis
 * constructor, injectable so tests run without a live Valkey. It is a
 * module-internal export (not re-exported from the package entry).
 */
export type ValkeyStoreDependencies = ValkeyClientDependencies<ValkeyRedisClient>;

/**
 * Valkey-backed cache store over ioredis.
 *
 * Construction is fully lazy: no client is created and no URL is read until the
 * first `get`/`set`/`delete`/`remember`. The URL is resolved with the precedence
 * `valkeyUrl` -> `VALKEY_URL` and validated as an explicit `redis://`/`rediss://`
 * URL (value-free on failure). Commands use a finite retry budget and fail fast
 * rather than queueing while the backend is unreachable. `close` disconnects the
 * owned client exactly once and is a no-op when no client was ever created.
 */
export class ValkeyCacheStore implements CacheStore {
  readonly #client: LazyValkeyClient<ValkeyRedisClient>;
  readonly #prefix: string;
  readonly #inFlight = new Map<string, Promise<string>>();

  constructor(options: ValkeyCacheStoreOptions = {}, dependencies?: ValkeyStoreDependencies) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('ValkeyCacheStore requires an options object');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.#prefix = resolveValkeyPrefix(options.prefix, DEFAULT_CACHE_PREFIX);
    this.#client = createLazyValkeyClient<ValkeyRedisClient>({
      valkeyUrl: options.valkeyUrl,
      onError: options.onError,
      dependencies,
      label: 'cache backend',
      makeError,
      makeClosedError: () => new CacheError('closed', 'cache store is closed'),
    });
  }

  #keyFor(key: string): string {
    return `${this.#prefix}:${key}`;
  }

  async get(key: string): Promise<string | null> {
    const client = await this.#client.get();
    try {
      return await client.get(this.#keyFor(key));
    } catch (error) {
      throw sanitizeBackendError(error, 'cache backend', makeError);
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const client = await this.#client.get();
    try {
      await client.set(this.#keyFor(key), value, 'PX', ttlMs);
    } catch (error) {
      throw sanitizeBackendError(error, 'cache backend', makeError);
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.#client.get();
    try {
      await client.del(this.#keyFor(key));
    } catch (error) {
      throw sanitizeBackendError(error, 'cache backend', makeError);
    }
  }

  async remember(key: string, ttlMs: number, loader: () => Promise<string>): Promise<string> {
    return rememberWith(this, this.#inFlight, key, ttlMs, loader);
  }

  /**
   * Atomic increment via a Lua script: `INCR` and `PEXPIRE` run as one server
   * operation, so concurrent callers across processes cannot both read the
   * pre-increment value. The TTL is applied only when the counter is created
   * (`INCR` returned 1), keeping the window fixed.
   */
  async increment(key: string, ttlMs: number): Promise<number> {
    const client = await this.#client.get();
    try {
      const result = await client.eval(INCREMENT_SCRIPT, 1, this.#keyFor(key), String(ttlMs));
      return parseCount(String(result));
    } catch (error) {
      throw sanitizeBackendError(error, 'cache backend', makeError);
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

/**
 * The cache store's error factory for sanitized backend failures. The errno
 * code is folded into the message; `CacheError.code` stays the category.
 */
function makeError(message: string): CacheError {
  return new CacheError('unavailable', message);
}

/** Shared get-or-load with in-process in-flight dedupe for both stores. */
async function rememberWith(
  store: Pick<CacheStore, 'get' | 'set'>,
  inFlight: Map<string, Promise<string>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<string>,
): Promise<string> {
  const cached = await store.get(key);
  if (cached !== null) {
    return cached;
  }
  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const promise = (async () => {
    const value = await loader();
    await store.set(key, value, ttlMs);
    return value;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}
