/**
 * The Valkey-backed {@link LeaseStore}, for exclusion across processes.
 *
 * A lease is the key `<prefix>:k:<key>` holding `<token>:<fence>` with a `PX`
 * expiry; the fence comes from one `INCR` counter, `<prefix>:fence`, so it
 * grows with every acquisition. Acquire, renew and release are each one Lua
 * script, so the check and the write are one server operation: a holder whose
 * lease expired cannot extend or delete the next holder's.
 *
 * Leases belong on a server that does not evict keys: under an eviction
 * policy a live lease could vanish. The first acquisition reads
 * `maxmemory-policy` (best effort; a server that refuses `CONFIG` is not
 * questioned further) and warns once when it is not `noeviction`. A
 * deployment whose cache server evicts gives the leases their own server
 * (`cachePlugin({ leases: { url } })`).
 */

import {
  CacheErrors,
  assertCacheKey,
  assertLease,
  assertTtlMs,
  type Lease,
  type LeaseStore,
} from 'jsails/cache';
import type { ValkeyClient, ValkeyConnections, ValkeyScript } from 'jsails/plugin-sdk';

import { newLeaseToken } from './memory-lease-store.js';
import { assertConnections, backendError, commandClient, resolvePrefix } from './valkey-backend.js';

/** The store's key segment inside the app key prefix. */
const LEASE_KEY_SEGMENT = 'lease';

/**
 * `KEYS[1]` the lease key, `KEYS[2]` the fence counter, `ARGV[1]` the token,
 * `ARGV[2]` the TTL in ms. Returns the fence, or nil while the key is held.
 */
const ACQUIRE_SCRIPT = `-- jsails:lease-acquire
if redis.call('EXISTS', KEYS[1]) == 1 then
  return false
end
local fence = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. fence, 'PX', ARGV[2])
return fence
`;

/** `KEYS[1]` the lease key, `ARGV[1]` `<token>:<fence>`, `ARGV[2]` the TTL in ms. */
const RENEW_SCRIPT = `-- jsails:lease-renew
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** `KEYS[1]` the lease key, `ARGV[1]` `<token>:<fence>`. */
const RELEASE_SCRIPT = `-- jsails:lease-release
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** What the eviction check warns, once per store. */
export const LEASE_EVICTION_WARNING: string =
  "the lease store's Valkey server may evict keys (maxmemory-policy is not noeviction), " +
  'so a live lease can be lost; give leases a server that does not evict';

/**
 * Options for {@link ValkeyLeaseStore}.
 *
 * @public
 */
export interface ValkeyLeaseStoreOptions {
  /** The Valkey connections the leases live on; the store never closes them. */
  readonly connections: ValkeyConnections;
  /** Key prefix. Defaults to `<app key prefix>:lease`. */
  readonly prefix?: string;
  /** Receives the eviction warning. Defaults to `process.emitWarning`. */
  readonly onWarning?: (message: string) => void;
}

/**
 * Valkey-backed lease store. Construction opens no connection; `close` stops
 * the store (later calls reject `cache.closed`) and leaves the connections open.
 *
 * @public
 */
export class ValkeyLeaseStore implements LeaseStore {
  readonly #connections: ValkeyConnections;
  readonly #prefix: string;
  readonly #acquire: ValkeyScript;
  readonly #renew: ValkeyScript;
  readonly #release: ValkeyScript;
  readonly #onWarning: (message: string) => void;
  #checkedEviction = false;
  #closed = false;

  constructor(options: ValkeyLeaseStoreOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new CacheErrors.Error('invalid_option', { option: 'ValkeyLeaseStore' });
    }
    if (options.onWarning !== undefined && typeof options.onWarning !== 'function') {
      throw new CacheErrors.Error('invalid_option', { option: 'onWarning' });
    }
    this.#connections = assertConnections(options.connections);
    this.#prefix = resolvePrefix(
      options.prefix,
      `${this.#connections.prefix}:${LEASE_KEY_SEGMENT}`,
    );
    this.#onWarning = options.onWarning ?? ((message) => process.emitWarning(message));
    this.#acquire = this.#connections.script({ lua: ACQUIRE_SCRIPT });
    this.#renew = this.#connections.script({ lua: RENEW_SCRIPT });
    this.#release = this.#connections.script({ lua: RELEASE_SCRIPT });
  }

  async acquire(key: string, ttlMs: number): Promise<Lease | null> {
    assertCacheKey(key);
    assertTtlMs(ttlMs);
    this.#assertOpen();
    if (!this.#checkedEviction) {
      const client = await commandClient(this.#connections, 'lease');
      if (!this.#checkedEviction) {
        this.#checkedEviction = true;
        await this.#checkEviction(client);
      }
    }
    const token = newLeaseToken();
    const fence = await this.#run(
      this.#acquire,
      [this.#keyFor(key), `${this.#prefix}:fence`],
      [token, ttlMs],
    );
    if (fence === null) return null;
    const value = Number(fence);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw backendError('lease', undefined);
    }
    return Object.freeze({ key, token, fence: value });
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    assertLease(lease);
    assertTtlMs(ttlMs);
    this.#assertOpen();
    const result = await this.#run(this.#renew, [this.#keyFor(lease.key)], [owner(lease), ttlMs]);
    return Number(result) === 1;
  }

  async release(lease: Lease): Promise<boolean> {
    assertLease(lease);
    this.#assertOpen();
    const result = await this.#run(this.#release, [this.#keyFor(lease.key)], [owner(lease)]);
    return Number(result) === 1;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CacheErrors.Error('closed', { store: 'lease' });
  }

  #keyFor(key: string): string {
    return `${this.#prefix}:k:${key}`;
  }

  async #run(
    script: ValkeyScript,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    try {
      return await script.run(keys, args);
    } catch (error) {
      throw backendError('lease', error);
    }
  }

  async #checkEviction(client: ValkeyClient): Promise<void> {
    let reply: unknown;
    try {
      reply = await client.config('GET', 'maxmemory-policy');
    } catch {
      // Managed servers often refuse CONFIG; the check is advice, not a gate.
      return;
    }
    const policy = Array.isArray(reply) ? reply[1] : undefined;
    if (typeof policy === 'string' && policy !== 'noeviction') {
      try {
        this.#onWarning(LEASE_EVICTION_WARNING);
      } catch {
        // A throwing observer must not fail the acquisition it reports on.
      }
    }
  }
}

/** The stored value that identifies `lease`. */
function owner(lease: Lease): string {
  return `${lease.token}:${String(lease.fence)}`;
}
