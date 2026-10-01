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
 *
 * ## Leases
 *
 * Both stores implement the optional lease methods of the contract
 * (`acquireLease`/`renewLease`/`releaseLease`). A lease stores a random owner
 * token as the entry's value, and renew/release are compare-and-set on that
 * token, so a holder whose lock already expired cannot extend or delete the
 * next holder's lock. The plain `release(key)` stays an unconditional delete
 * for callers that never took a token.
 */

import { randomBytes } from 'node:crypto';

import { MutexError, type LeaseMutexStore } from 'jsails/cache';
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

/** Validate a lease token, value-free. */
function assertToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new MutexError('invalid_key', 'token must be a non-empty string');
  }
}

/** A fresh, unguessable owner token. */
function newLeaseToken(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Compare-and-delete: `KEYS[1]` is the lock key, `ARGV[1]` the owner token.
 * Deletes only while the token still owns the key.
 */
const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Compare-and-expire: `KEYS[1]` is the lock key, `ARGV[1]` the owner token,
 * `ARGV[2]` the new TTL in ms. Extends only while the token still owns the key.
 */
const RENEW_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** Validate an `acquire` TTL, value-free. */
function assertTtl(ttlMs: unknown): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new MutexError('invalid_ttl', 'ttlMs must be a positive finite number');
  }
}

/**
 * In-memory mutex store backed by a `Map<key, { expiresAt, token }>`.
 * `acquire` is a synchronous check-and-set (atomic in-process): if the key is
 * absent or expired, it sets the expiry and returns `true`; otherwise it
 * returns `false`. `release` deletes the key; the lease methods compare the
 * owner token first. `close` clears the map and is idempotent.
 *
 * This store holds no external resources and needs no connection. Construct
 * with `new MemoryMutexStore({ now? })`.
 */
export class MemoryMutexStore implements LeaseMutexStore {
  readonly #now: () => number;
  readonly #entries = new Map<string, { expiresAt: number; token: string | null }>();

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
    return this.#take(key, ttlMs, null);
  }

  async release(key: string): Promise<void> {
    assertKey(key);
    this.#entries.delete(key);
  }

  async acquireLease(key: string, ttlMs: number): Promise<string | undefined> {
    assertKey(key);
    assertTtl(ttlMs);
    const token = newLeaseToken();
    return this.#take(key, ttlMs, token) ? token : undefined;
  }

  async renewLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    assertKey(key);
    assertToken(token);
    assertTtl(ttlMs);
    const entry = this.#owned(key, token);
    if (entry === undefined) {
      return false;
    }
    entry.expiresAt = this.#now() + ttlMs;
    return true;
  }

  async releaseLease(key: string, token: string): Promise<boolean> {
    assertKey(key);
    assertToken(token);
    if (this.#owned(key, token) === undefined) {
      return false;
    }
    this.#entries.delete(key);
    return true;
  }

  #take(key: string, ttlMs: number, token: string | null): boolean {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (entry !== undefined && now < entry.expiresAt) {
      return false;
    }
    this.#entries.set(key, { expiresAt: now + ttlMs, token });
    return true;
  }

  /** The live entry for `key` when `token` owns it. */
  #owned(key: string, token: string): { expiresAt: number; token: string | null } | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.token !== token || this.#now() >= entry.expiresAt) {
      return undefined;
    }
    return entry;
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
export class ValkeyMutexStore implements LeaseMutexStore {
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

  async acquireLease(key: string, ttlMs: number): Promise<string | undefined> {
    assertKey(key);
    assertTtl(ttlMs);
    const token = newLeaseToken();
    const client = await this.#client.get();
    try {
      const result = await client.set(this.#keyFor(key), token, 'PX', ttlMs, 'NX');
      return result === 'OK' ? token : undefined;
    } catch (error) {
      throw sanitizeBackendError(error, 'mutex backend', makeError);
    }
  }

  async renewLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    assertKey(key);
    assertToken(token);
    assertTtl(ttlMs);
    return this.#compareAndRun(RENEW_LEASE_SCRIPT, key, token, String(Math.ceil(ttlMs)));
  }

  async releaseLease(key: string, token: string): Promise<boolean> {
    assertKey(key);
    assertToken(token);
    return this.#compareAndRun(RELEASE_LEASE_SCRIPT, key, token);
  }

  async #compareAndRun(script: string, key: string, ...args: string[]): Promise<boolean> {
    const client = await this.#client.get();
    try {
      const result = await client.eval(script, 1, this.#keyFor(key), ...args);
      return Number(result) === 1;
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
