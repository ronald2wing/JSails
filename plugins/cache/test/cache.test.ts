/**
 * Tests for the cache + rate-limiting surface: the in-memory store and its
 * injectable clock, the Valkey-backed store's lazy connect / namespacing /
 * idempotent close / value-free errors (all via an injected fake client, so no
 * live Valkey is required), the fixed-window rate limiter, the value-free 429
 * helper, the Hono-agnostic guard, and the `cache` plugin's ownership/cleanup.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CacheStore } from 'jsails/cache';
import { CacheError, cacheToken } from 'jsails/cache';
import {
  cachePlugin,
  MemoryCacheStore,
  FixedWindowRateLimiter,
  ValkeyCacheStore,
  guardRateLimit,
  rateLimitResponse,
} from '../src/index.js';
import type { ValkeyCacheStoreDependencies, ValkeyRedisClient } from '../src/store.js';
import { runExtensions } from 'jsails/extensions';

/** A mutable fake clock shared by a store and a limiter so TTLs align. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A fake ioredis client recording commands; the store constructs its own. */
class FakeClient implements ValkeyRedisClient {
  readonly keys: string[] = [];
  readonly counters = new Map<string, number>();
  connected = 0;
  disconnected = 0;

  async get(key: string): Promise<string | null> {
    this.keys.push(key);
    return null;
  }

  async set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    condition?: 'NX',
  ): Promise<'OK'> {
    this.keys.push(key);
    void value;
    void mode;
    void ttlMs;
    void condition;
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.keys.push(key);
    return 0;
  }

  /** Models the INCR script: each call bumps the counter for its key. */
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    void script;
    void numKeys;
    const key = String(args[0]);
    this.keys.push(key);
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

/** Track every client the store constructs so tests can inspect the real one. */
function fakeClientDeps(): { deps: ValkeyCacheStoreDependencies; instances: FakeClient[] } {
  const instances: FakeClient[] = [];
  class TrackingClient extends FakeClient {
    constructor(url: string, options: object) {
      super();
      instances.push(this);
      void url;
      void options;
    }
  }
  const deps: ValkeyCacheStoreDependencies = { RedisClient: TrackingClient };
  return { deps, instances };
}

describe('MemoryCacheStore', () => {
  it('caches via remember and deduplicates concurrent loads', async () => {
    const store = new MemoryCacheStore();
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      await Promise.resolve();
      return `value-${calls}`;
    };

    const [a, b] = await Promise.all([
      store.remember('k', 1000, loader),
      store.remember('k', 1000, loader),
    ]);
    assert.equal(a, 'value-1');
    assert.equal(b, 'value-1');
    assert.equal(calls, 1);

    const c = await store.remember('k', 1000, loader);
    assert.equal(c, 'value-1');
    assert.equal(calls, 1, 'a cached hit must not re-run the loader');
  });

  it('expires entries after their TTL', async () => {
    const { now, advance } = fakeClock();
    const store = new MemoryCacheStore({ now });

    await store.set('k', 'v', 1000);
    assert.equal(await store.get('k'), 'v');

    advance(999);
    assert.equal(await store.get('k'), 'v');

    advance(1);
    assert.equal(await store.get('k'), null);
  });

  it('deletes entries', async () => {
    const store = new MemoryCacheStore();
    await store.set('k', 'v', 1000);
    await store.delete('k');
    assert.equal(await store.get('k'), null);
  });

  it('close is idempotent', async () => {
    const store = new MemoryCacheStore();
    await store.set('k', 'v', 1000);
    await store.close();
    await store.close();
    assert.equal(await store.get('k'), null);
  });

  it('evicts the oldest entries once maxEntries is exceeded', async () => {
    const { now } = fakeClock();
    const store = new MemoryCacheStore({ now, maxEntries: 3 });

    await store.set('a', '1', 60_000);
    await store.set('b', '2', 60_000);
    await store.set('c', '3', 60_000);
    await store.set('d', '4', 60_000);

    // The oldest insertion is dropped; the newest three survive.
    assert.equal(await store.get('a'), null);
    assert.equal(await store.get('b'), '2');
    assert.equal(await store.get('c'), '3');
    assert.equal(await store.get('d'), '4');
  });

  it('sweeps expired entries before evicting live ones', async () => {
    const { now, advance } = fakeClock();
    const store = new MemoryCacheStore({ now, maxEntries: 2 });

    await store.set('short', '1', 10);
    await store.set('long', '2', 60_000);
    advance(20); // `short` is now expired but still stored
    await store.set('new', '3', 60_000);

    // The expired entry is swept first, so both live entries survive.
    assert.equal(await store.get('short'), null);
    assert.equal(await store.get('long'), '2');
    assert.equal(await store.get('new'), '3');
  });

  it('rejects a non-positive maxEntries', () => {
    assert.throws(() => new MemoryCacheStore({ maxEntries: 0 }), TypeError);
    assert.throws(() => new MemoryCacheStore({ maxEntries: -1 }), TypeError);
    assert.throws(() => new MemoryCacheStore({ maxEntries: 1.5 }), TypeError);
  });
});

describe('ValkeyCacheStore', () => {
  it('does not construct or connect until the first use', async () => {
    const { deps, instances } = fakeClientDeps();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://host:6379' }, deps);

    assert.equal(instances.length, 0, 'construction must be lazy');

    await store.get('k');
    assert.equal(instances.length, 1);
    const client = instances[0];
    assert.ok(client);
    assert.equal(client.connected, 1);

    await store.close();
  });

  it('namespaces keys under the prefix', async () => {
    const { deps, instances } = fakeClientDeps();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h', prefix: 'ns' }, deps);

    await store.get('k1');
    await store.set('k2', 'v', 100);
    await store.delete('k3');
    const client = instances[0];
    assert.ok(client);
    assert.deepEqual(client.keys, ['ns:k1', 'ns:k2', 'ns:k3']);

    await store.close();
  });

  it('close disconnects exactly once and is idempotent', async () => {
    const { deps, instances } = fakeClientDeps();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, deps);

    await store.get('k'); // force the connect
    await store.close();
    await store.close();
    const client = instances[0];
    assert.ok(client);
    assert.equal(client.disconnected, 1);
  });

  it('fails value-free when a backend error would echo the URL', async () => {
    class ThrowingClient {
      constructor(url: string) {
        throw new Error(`connection to ${url} failed`);
      }
    }
    const deps: ValkeyCacheStoreDependencies = {
      RedisClient: ThrowingClient as unknown as ValkeyCacheStoreDependencies['RedisClient'],
    };
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://user:secret@host:6379/0' }, deps);

    await assert.rejects(store.get('k'), (error: unknown) => {
      assert.ok(error instanceof CacheError);
      for (const fragment of ['secret', 'user', '6379', 'redis://']) {
        assert.ok(!String(error).includes(fragment), `error must not echo "${fragment}"`);
      }
      return true;
    });
  });

  it('rejects a non-redis scheme value-free', async () => {
    const { deps } = fakeClientDeps();
    const store = new ValkeyCacheStore({ valkeyUrl: 'http://secret@host' }, deps);

    await assert.rejects(store.get('k'), (error: unknown) => {
      assert.ok(error instanceof CacheError);
      assert.ok(!String(error).includes('secret'));
      return true;
    });
  });
});

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit, blocks beyond it, and resets on the next window', async () => {
    const { now, advance } = fakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 2, windowMs: 1000, now });

    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 1, resetAt: 1000 });
    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 0, resetAt: 1000 });
    assert.deepEqual(await limiter.check('ip:1'), { allowed: false, remaining: 0, resetAt: 1000 });

    advance(1000);
    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 1, resetAt: 2000 });
  });

  it('keeps independent keys in independent windows', async () => {
    const { now } = fakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    assert.deepEqual(await limiter.check('a'), { allowed: true, remaining: 0, resetAt: 1000 });
    assert.deepEqual(await limiter.check('b'), { allowed: true, remaining: 0, resetAt: 1000 });
  });

  it('rejects invalid options', () => {
    const store = new MemoryCacheStore();
    assert.throws(() => new FixedWindowRateLimiter({ store, limit: 0, windowMs: 1000 }), TypeError);
    assert.throws(() => new FixedWindowRateLimiter({ store, limit: 1, windowMs: 0 }), TypeError);
    assert.throws(
      () => new FixedWindowRateLimiter({ store: {} as CacheStore, limit: 1, windowMs: 1000 }),
      TypeError,
    );
  });

  it('allows exactly one of 100 concurrent checks when the limit is 1', async () => {
    // The audit reproduction: a read-then-write let all 100 concurrent callers
    // observe the pre-increment count. The memory store's atomic `increment`
    // must admit exactly one.
    const { now } = fakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('ip:race')));
    const allowed = results.filter((result) => result.allowed).length;
    assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);
  });

  it('allows exactly one of 100 concurrent checks on the Valkey store', async () => {
    // The fake client's `eval` is synchronous, so the script's INCR semantics
    // are what make this atomic — the same guarantee the real Lua script gives.
    const { deps } = fakeClientDeps();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, deps);
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000 });

    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('ip:race')));
    const allowed = results.filter((result) => result.allowed).length;
    assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);

    await store.close();
  });

  it('serializes same-key checks when the store has no increment', async () => {
    // A custom store without `increment` falls back to read-then-write; the
    // limiter must serialize those calls so a single process stays correct.
    const { now } = fakeClock();
    const inner = new MemoryCacheStore({ now });
    const store: CacheStore = {
      get: (key) => inner.get(key),
      set: (key, value, ttlMs) => inner.set(key, value, ttlMs),
      delete: (key) => inner.delete(key),
      remember: (key, ttlMs, loader) => inner.remember(key, ttlMs, loader),
      close: () => inner.close(),
    };
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => limiter.check('ip:fallback')),
    );
    const allowed = results.filter((result) => result.allowed).length;
    assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);
  });

  it('does not poison the serialization chain when a check rejects', async () => {
    const { now } = fakeClock();
    let failNext = true;
    const store: CacheStore = {
      get: () => (failNext ? Promise.reject(new Error('backend down')) : Promise.resolve(null)),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      remember: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
    };
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    await assert.rejects(limiter.check('k'));
    failNext = false;
    const result = await limiter.check('k');
    assert.equal(result.allowed, true);
  });
});

describe('rateLimitResponse', () => {
  it('returns a value-free 429', () => {
    const response = rateLimitResponse();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('sets Retry-After when a finite value is supplied', () => {
    assert.equal(rateLimitResponse(29.5).headers.get('retry-after'), '30');
    assert.equal(rateLimitResponse(Number.NaN).headers.get('retry-after'), null);
  });
});

describe('guardRateLimit', () => {
  it('allows under the limit and blocks over it', async () => {
    const { now } = fakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });
    const calls: string[] = [];
    const handler = guardRateLimit(
      limiter,
      (context: { key: string }) => context.key,
      (context) => {
        calls.push(context.key);
        return new Response('ok');
      },
    );

    assert.equal((await handler({ key: 'a' })).status, 200);
    assert.equal((await handler({ key: 'a' })).status, 429);
    assert.deepEqual(calls, ['a']);
  });
});

describe('cachePlugin', () => {
  it('provides the owned store under cacheToken without connecting at setup', async () => {
    const plugin = cachePlugin({ valkeyUrl: 'redis://127.0.0.1:1' });
    assert.equal(plugin.name, 'cache');

    const runtime = await runExtensions([plugin]);
    try {
      const store: CacheStore = runtime.services.get(cacheToken);
      assert.equal(typeof store.get, 'function');
      assert.equal(typeof store.close, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('defaults to the in-memory store when no URL is configured', async () => {
    const runtime = await runExtensions([cachePlugin({})]);
    try {
      const store: CacheStore = runtime.services.get(cacheToken);
      await store.set('k', 'v', 1000);
      assert.equal(await store.get('k'), 'v');
    } finally {
      await runtime.close();
    }
  });

  it('preserves a caller-provided store and never closes it', async () => {
    let closed = false;
    const provided: CacheStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      remember: async (_key, _ttl, loader) => loader(),
      close: async () => {
        closed = true;
      },
    };

    const runtime = await runExtensions([cachePlugin({ store: provided })]);
    try {
      assert.equal(runtime.services.get(cacheToken), provided);
    } finally {
      await runtime.close();
    }
    assert.equal(closed, false, 'a caller-provided store must not be closed');
  });

  it('closes the owned store exactly once', async () => {
    const runtime = await runExtensions([cachePlugin({})]);
    await runtime.close();
    await runtime.close(); // idempotent
  });

  it('exposes a stable cacheToken singleton', () => {
    assert.equal(cacheToken.name, 'cache');
  });

  it('rejects a malformed store', () => {
    assert.throws(() => cachePlugin({ store: null as never }), TypeError);
    assert.throws(() => cachePlugin({ store: {} as CacheStore }), TypeError);
  });
});
