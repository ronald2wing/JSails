/**
 * A fake ioredis client for the Valkey-backed store tests: records every key
 * it is handed, models the atomic `INCR` script and `SET NX`, and can be made
 * to fail every operation. The stores construct their own instances through
 * the injected constructor, so `fakeClientDependencies` also tracks them.
 */

import type { ValkeyRedisClient, ValkeyStoreDependencies } from '../src/cache-store.js';

export class FakeValkeyClient implements ValkeyRedisClient {
  readonly keys: string[] = [];
  readonly counters = new Map<string, number>();
  connected = 0;
  disconnected = 0;
  /** The result of `set(key, value, 'PX', ttlMs, 'NX')`. */
  setResult: 'OK' | null = 'OK';
  /** When set, every operation throws this error instead of succeeding. */
  throwOnOperation: Error | null = null;

  #fail(): void {
    if (this.throwOnOperation !== null) {
      throw this.throwOnOperation;
    }
  }

  async get(key: string): Promise<string | null> {
    this.keys.push(key);
    this.#fail();
    return null;
  }

  async set(
    key: string,
    _value: string,
    _mode: 'PX',
    _ttlMs: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    this.keys.push(key);
    this.#fail();
    return condition === 'NX' ? this.setResult : 'OK';
  }

  async del(key: string): Promise<number> {
    this.keys.push(key);
    this.#fail();
    return 0;
  }

  /** Models the INCR script: each call bumps the counter for its key. */
  async eval(_script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    const key = String(args[0]);
    this.keys.push(key);
    this.#fail();
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async connect(): Promise<unknown> {
    this.connected += 1;
    return undefined;
  }

  async disconnect(): Promise<void> {
    this.disconnected += 1;
  }

  on(): unknown {
    return undefined;
  }
}

/** Track every client a store constructs so tests can inspect the real one. */
export function fakeClientDependencies(): {
  dependencies: ValkeyStoreDependencies;
  instances: FakeValkeyClient[];
} {
  const instances: FakeValkeyClient[] = [];
  class TrackingClient extends FakeValkeyClient {
    constructor(_url: string, _options: object) {
      super();
      instances.push(this);
    }
  }
  return { dependencies: { RedisClient: TrackingClient }, instances };
}
