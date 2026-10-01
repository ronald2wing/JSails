/**
 * Cache store tests: the in-memory store's TTL, eviction, and in-flight
 * dedupe, and the Valkey-backed store's lazy connect, namespacing, idempotent
 * close, and value-free errors — all through an injected fake client, so no
 * live Valkey is required.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CacheError } from 'jsails/cache';
import { createFakeClock } from 'jsails/testing';
import { MemoryCacheStore, ValkeyCacheStore } from '../src/index.js';
import type { ValkeyStoreDependencies } from '../src/cache-store.js';
import { fakeClientDependencies } from './fake-valkey-client.js';

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
    const { now, advance } = createFakeClock();
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
    const { now } = createFakeClock();
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
    const { now, advance } = createFakeClock();
    const store = new MemoryCacheStore({ now, maxEntries: 2 });

    await store.set('short', '1', 10);
    await store.set('long', '2', 60_000);
    advance(20); // `short` is expired but still stored
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
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://host:6379' }, dependencies);

    assert.equal(instances.length, 0, 'construction must be lazy');

    await store.get('k');
    assert.equal(instances.length, 1);
    const client = instances[0];
    assert.ok(client);
    assert.equal(client.connected, 1);

    await store.close();
  });

  it('namespaces keys under the prefix', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h', prefix: 'ns' }, dependencies);

    await store.get('k1');
    await store.set('k2', 'v', 100);
    await store.delete('k3');
    const client = instances[0];
    assert.ok(client);
    assert.deepEqual(client.keys, ['ns:k1', 'ns:k2', 'ns:k3']);

    await store.close();
  });

  it('defaults the prefix to jsails:cache', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, dependencies);

    await store.get('k');
    assert.deepEqual(instances[0]?.keys, ['jsails:cache:k']);

    await store.close();
  });

  it('close disconnects exactly once and is idempotent', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, dependencies);

    await store.get('k'); // force the connect
    await store.close();
    await store.close();
    const client = instances[0];
    assert.ok(client);
    assert.equal(client.disconnected, 1);
  });

  it('rejects operations after close', async () => {
    const { dependencies } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, dependencies);

    await store.close();
    await assert.rejects(store.get('k'), CacheError);
  });

  it('disconnects a client whose connect finished after close', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, dependencies);

    const pending = store.get('k');
    await store.close();
    await assert.rejects(pending, CacheError);
    assert.equal(instances[0]?.disconnected, 1, 'the racing client must not leak');
  });

  it('retries the connect after a failure', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, dependencies);
    let attempts = 0;
    class FlakyClient extends dependencies.RedisClient {
      constructor(url: string, options: object) {
        super(url, options);
        attempts += 1;
        if (attempts === 1) {
          this.connect = async () => {
            throw new Error('refused');
          };
        }
      }
    }
    const flaky = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, { RedisClient: FlakyClient });

    await assert.rejects(flaky.get('k'), CacheError);
    await flaky.get('k');
    assert.equal(attempts, 2, 'a failed connect is not memoized');
    assert.equal(instances.length, 2);

    await flaky.close();
    await store.close();
  });

  it('fails value-free when a backend error would echo the URL', async () => {
    class ThrowingClient {
      constructor(url: string) {
        throw new Error(`connection to ${url} failed`);
      }
    }
    const dependencies: ValkeyStoreDependencies = {
      RedisClient: ThrowingClient as unknown as ValkeyStoreDependencies['RedisClient'],
    };
    const store = new ValkeyCacheStore(
      { valkeyUrl: 'redis://user:secret@host:6379/0' },
      dependencies,
    );

    await assert.rejects(store.get('k'), (error: unknown) => {
      assert.ok(error instanceof CacheError);
      for (const fragment of ['secret', 'user', '6379', 'redis://']) {
        assert.ok(!String(error).includes(fragment), `error must not echo "${fragment}"`);
      }
      return true;
    });
  });

  it('reports a backend failure as unavailable with the errno in the message, never the URL', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyCacheStore(
      { valkeyUrl: 'redis://user:secret@host:6379/0' },
      dependencies,
    );

    await store.get('k');
    const failure = new Error('connection to redis://user:secret@host:6379/0 lost');
    (failure as NodeJS.ErrnoException).code = 'ECONNRESET';
    instances[0]!.throwOnOperation = failure;

    await assert.rejects(store.get('k'), (error: unknown) => {
      assert.ok(error instanceof CacheError);
      assert.equal(error.code, 'unavailable');
      assert.ok(error.message.includes('ECONNRESET'));
      assert.ok(!error.message.includes('secret'));
      return true;
    });

    await store.close();
  });

  it('rejects a non-redis scheme value-free', async () => {
    const { dependencies } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'http://secret@host' }, dependencies);

    await assert.rejects(store.get('k'), (error: unknown) => {
      assert.ok(error instanceof CacheError);
      assert.ok(!String(error).includes('secret'));
      return true;
    });
  });

  it('rejects malformed options', () => {
    assert.throws(() => new ValkeyCacheStore(null as never), TypeError);
    assert.throws(() => new ValkeyCacheStore({ onError: 42 as never }), TypeError);
    assert.throws(() => new ValkeyCacheStore({ prefix: '' }), TypeError);
  });
});
