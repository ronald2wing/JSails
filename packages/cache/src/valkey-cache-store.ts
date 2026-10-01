/**
 * The Valkey-backed {@link CacheStore}, over the app's shared `command`
 * connection.
 *
 * Every entry is stored as one tag byte and the payload: `s` and the UTF-8 of
 * a string, or `b` and the raw bytes, so a value reads back with the type it
 * was written with. A value without a known tag (written by something else)
 * reads as a miss. `add` is `SET … PX … NX`, atomic on the server. Keys live
 * under `<app key prefix>:cache:` by default. The connection connects on the
 * first operation and runs the provider's policy (no offline queue, a reply
 * deadline), so an unreachable server rejects `cache.unavailable` promptly.
 * Eviction follows the server's `maxmemory-policy`, which an evictable cache
 * tolerates.
 */

import { CacheErrors, type CacheStore, type CacheValue } from 'jsails/cache';
import type { ValkeyClient, ValkeyConnections } from 'jsails/plugin-sdk';

import { rootCacheView, type CacheKeyspace } from './cache-view.js';
import { assertConnections, backendError, commandClient, resolvePrefix } from './valkey-backend.js';

/** The store's key segment inside the app key prefix. */
const CACHE_KEY_SEGMENT = 'cache';

const STRING_TAG = 0x73;
const BYTES_TAG = 0x62;

/**
 * Options for {@link ValkeyCacheStore}.
 *
 * @public
 */
export interface ValkeyCacheStoreOptions {
  /** The app's Valkey connections; the store never closes them. */
  readonly connections: ValkeyConnections;
  /** Key prefix. Defaults to `<app key prefix>:cache`. */
  readonly prefix?: string;
}

/** A value as stored: its tag byte, then its payload. */
export function encodeCacheValue(value: CacheValue): Buffer {
  if (typeof value === 'string') {
    return Buffer.concat([Buffer.of(STRING_TAG), Buffer.from(value, 'utf8')]);
  }
  return Buffer.concat([Buffer.of(BYTES_TAG), value]);
}

/** A stored value back as written, or `null` for an absent or foreign one. */
export function decodeCacheValue(raw: Buffer | null): CacheValue | null {
  if (raw === null || raw.length === 0) return null;
  if (raw[0] === STRING_TAG) return raw.toString('utf8', 1);
  if (raw[0] === BYTES_TAG) return new Uint8Array(raw.subarray(1));
  return null;
}

class ValkeyKeyspace implements CacheKeyspace {
  readonly #connections: ValkeyConnections;
  readonly #prefix: string;
  closed = false;

  constructor(connections: ValkeyConnections, prefix: string) {
    this.#connections = connections;
    this.#prefix = `${prefix}:`;
  }

  async #run<T>(operation: (client: ValkeyClient) => Promise<T>): Promise<T> {
    const client = await commandClient(this.#connections, 'cache');
    try {
      return await operation(client);
    } catch (error) {
      throw backendError('cache', error);
    }
  }

  get(key: string): Promise<CacheValue | null> {
    return this.#run(async (client) =>
      decodeCacheValue(await client.getBuffer(this.#prefix + key)),
    );
  }

  getMany(keys: readonly string[]): Promise<(CacheValue | null)[]> {
    return this.#run(async (client) => {
      const values = await client.mgetBuffer(keys.map((key) => this.#prefix + key));
      return values.map((value) => decodeCacheValue(value));
    });
  }

  set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    return this.#run(async (client) => {
      await client.set(this.#prefix + key, encodeCacheValue(value), 'PX', ttlMs);
    });
  }

  add(key: string, value: CacheValue, ttlMs: number): Promise<boolean> {
    return this.#run(
      async (client) =>
        (await client.set(this.#prefix + key, encodeCacheValue(value), 'PX', ttlMs, 'NX')) === 'OK',
    );
  }

  delete(key: string): Promise<void> {
    return this.#run(async (client) => {
      await client.del(this.#prefix + key);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Valkey-backed cache store. Construction opens no connection; `close` stops
 * the store (later calls reject `cache.closed`) and leaves the app's
 * connections open.
 *
 * @public
 */
export class ValkeyCacheStore implements CacheStore {
  readonly #root: CacheStore;

  constructor(options: ValkeyCacheStoreOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new CacheErrors.Error('invalid_option', { option: 'ValkeyCacheStore' });
    }
    const connections = assertConnections(options.connections);
    const prefix = resolvePrefix(options.prefix, `${connections.prefix}:${CACHE_KEY_SEGMENT}`);
    this.#root = rootCacheView(new ValkeyKeyspace(connections, prefix));
  }

  get(key: string): Promise<CacheValue | null> {
    return this.#root.get(key);
  }

  getMany(keys: readonly string[]): Promise<(CacheValue | null)[]> {
    return this.#root.getMany(keys);
  }

  set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    return this.#root.set(key, value, ttlMs);
  }

  add(key: string, value: CacheValue, ttlMs: number): Promise<boolean> {
    return this.#root.add(key, value, ttlMs);
  }

  delete(key: string): Promise<void> {
    return this.#root.delete(key);
  }

  namespace(name: string): CacheStore {
    return this.#root.namespace(name);
  }

  close(): Promise<void> {
    return this.#root.close();
  }
}
