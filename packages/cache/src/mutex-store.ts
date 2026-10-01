/**
 * Mutex store implementations: an in-process memory default and a Valkey
 * backend over the core {@link import('jsails/cache').MutexStore} contract.
 *
 * ## In-process limitation
 *
 * The {@link MemoryMutexStore} guarantees mutual exclusion within a single
 * process only. In a multi-process deployment — separate `jsails work`
 * workers, or a parent process that enqueues a job and a worker that executes
 * it — the in-memory map is not shared, so two processes can both "acquire" the
 * same key concurrently. A multi-process deployment must use
 * {@link ValkeyMutexStore}, which provides the same contract backed by a shared
 * Valkey `SET key value NX PX ttl` atomic operation.
 */

import { MutexError, type MutexStore } from 'jsails/cache';
import {
  createLazyValkeyClient,
  resolveValkeyPrefix,
  sanitizeBackendError,
  type LazyValkeyClient,
} from 'jsails/plugin-sdk';
import type { ValkeyRedisClient, ValkeyStoreDependencies } from './cache-store.js';

/** Default prefix for Valkey-backed mutex keys. */
const DEFAULT_MUTEX_PREFIX = 'jsails:mutex';

/** Options for {@link MemoryMutexStore}. */
export interface MemoryMutexStoreOptions {
  /** Injectable clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Options for {@link ValkeyMutexStore}.
 *
 * The store provides cross-process mutual exclusion via the atomic `SET NX PX`
 * operation on a shared Valkey backend, unlike the in-process-only memory
 * store. Construction is fully lazy: no client is created and no URL is read
 * until the first `acquire`/`release`.
 */
export interface ValkeyMutexStoreOptions {
  /** Valkey URL. Falls back to `VALKEY_URL`. */
  readonly valkeyUrl?: string;
  /** Key prefix. Defaults to `jsails:mutex`. */
  readonly prefix?: string;
  /** Invoked with a sanitized error when a client fails after connecting. */
  readonly onError?: (error: Error) => void;
}

/** Validate an `acquire`/`release` key, value-free. */
function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new MutexError('invalid_key', 'key must be a non-empty string');
  }
}

/** Validate an `acquire` TTL, value-free. */
function assertTtl(ttlMs: unknown): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new MutexError('invalid_ttl', 'ttlMs must be a positive finite number');
  }
}

/**
 * In-memory mutex store backed by a `Map<key, expiresAt>`.
 * `acquire` is a synchronous check-and-set (atomic in-process): if the key is
 * absent or expired, it sets the expiry and returns `true`; otherwise it
 * returns `false`. `release` deletes the key. `close` clears the map and is
 * idempotent.
 *
 * This store holds no external resources and needs no connection. Construct
 * with `new MemoryMutexStore({ now? })`.
 */
export class MemoryMutexStore implements MutexStore {
  readonly #now: () => number;
  readonly #entries = new Map<string, number>();

  constructor(options: MemoryMutexStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('MemoryMutexStore requires an options object');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.#now = options.now ?? (() => Date.now());
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    assertKey(key);
    assertTtl(ttlMs);
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && this.#now() < expiresAt) {
      return false;
    }
    this.#entries.set(key, this.#now() + ttlMs);
    return true;
  }

  async release(key: string): Promise<void> {
    assertKey(key);
    this.#entries.delete(key);
  }

  async close(): Promise<void> {
    this.#entries.clear();
  }
}

/**
 * Valkey-backed mutex store with the same lazy-connection discipline as
 * {@link ValkeyCacheStore}. The store provides cross-process mutual exclusion:
 * `acquire` uses the atomic `SET key value NX PX ttlMs` command, so competing
 * processes sharing a Valkey instance see the same lock state. The in-process
 * {@link MemoryMutexStore} cannot provide that guarantee.
 *
 * Construction is inert — no client is created and no URL is read until the
 * first `acquire`/`release`. The URL is resolved with precedence `valkeyUrl` ->
 * `VALKEY_URL` and validated as an explicit `redis://`/`rediss://` URL
 * (value-free on failure). Commands use a finite retry budget and fail fast.
 * `close` disconnects the owned client exactly once and is a no-op when no
 * client was ever created. After close, every operation throws
 * `MutexError('closed', ...)`.
 */
export class ValkeyMutexStore implements MutexStore {
  readonly #client: LazyValkeyClient<ValkeyRedisClient>;
  readonly #prefix: string;

  constructor(options: ValkeyMutexStoreOptions = {}, dependencies?: ValkeyStoreDependencies) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('ValkeyMutexStore requires an options object');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.#prefix = resolveValkeyPrefix(options.prefix, DEFAULT_MUTEX_PREFIX);
    this.#client = createLazyValkeyClient<ValkeyRedisClient>({
      valkeyUrl: options.valkeyUrl,
      onError: options.onError,
      dependencies,
      label: 'mutex backend',
      makeError,
      makeClosedError: () => new MutexError('closed', 'mutex store is closed'),
    });
  }

  #keyFor(key: string): string {
    return `${this.#prefix}:${key}`;
  }

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    assertKey(key);
    assertTtl(ttlMs);
    const client = await this.#client.get();
    try {
      const result = await client.set(this.#keyFor(key), '1', 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch (error) {
      throw sanitizeBackendError(error, 'mutex backend', makeError);
    }
  }

  async release(key: string): Promise<void> {
    assertKey(key);
    const client = await this.#client.get();
    try {
      await client.del(this.#keyFor(key));
    } catch (error) {
      throw sanitizeBackendError(error, 'mutex backend', makeError);
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}

/**
 * The mutex store's error factory for sanitized backend failures. The errno
 * code is folded into the message; `MutexError.code` stays the category.
 */
function makeError(message: string): MutexError {
  return new MutexError('unavailable', message);
}
