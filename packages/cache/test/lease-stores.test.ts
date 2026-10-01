/**
 * The lease stores: both pass the lease contract's conformance cases (the
 * Valkey one over the fake Valkey and its Lua scripts), a lease survives any
 * pressure on the cache, and the Valkey store's own behaviour: key layout,
 * the fence counter, the once-per-store eviction warning, and value-free
 * failures.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { CacheErrors } from 'jsails/cache';
import { createFakeClock, leaseStoreConformance } from 'jsails/testing';

import {
  MemoryCacheStore,
  MemoryLeaseStore,
  ValkeyCacheStore,
  ValkeyLeaseStore,
} from '../src/index.js';
import { LEASE_EVICTION_WARNING } from '../src/valkey-lease-store.js';
import { FakeValkeyServer, fakeValkey } from './fake-valkey-client.js';

for (const entry of leaseStoreConformance(async () => {
  const clock = createFakeClock();
  const store = new MemoryLeaseStore({ now: clock.now });
  return {
    store,
    advance: async (ms) => {
      clock.advance(ms);
    },
    close: () => store.close(),
  };
})) {
  test(`MemoryLeaseStore conformance: ${entry.name}`, () => entry.run());
}

for (const entry of leaseStoreConformance(async () => {
  const clock = createFakeClock();
  const { connections } = fakeValkey({ server: new FakeValkeyServer(clock.now) });
  const store = new ValkeyLeaseStore({ connections });
  return {
    store,
    advance: async (ms) => {
      clock.advance(ms);
    },
    close: async () => {
      await store.close();
      await connections.close();
    },
  };
})) {
  test(`ValkeyLeaseStore conformance: ${entry.name}`, () => entry.run());
}

describe('a lease under cache pressure', () => {
  it('flooding the memory cache with ten times its capacity never drops a live lease', async () => {
    const cache = new MemoryCacheStore({ maxBytes: 4096, maxEntries: 100 });
    const leases = new MemoryLeaseStore();
    const lease = await leases.acquire('job:nightly', 3_600_000);
    assert.ok(lease !== null);
    for (let write = 0; write < 1000; write += 1) {
      await cache.set(`flood:${String(write)}`, 'x'.repeat(40), 3_600_000);
    }
    assert.equal(await leases.acquire('job:nightly', 3_600_000), null, 'the lease still holds');
    assert.equal(await leases.renew(lease, 3_600_000), true);
  });

  it('flooding the Valkey cache never touches a lease key', async () => {
    const { connections, server } = fakeValkey();
    const cache = new ValkeyCacheStore({ connections });
    const leases = new ValkeyLeaseStore({ connections });
    const lease = await leases.acquire('job:nightly', 3_600_000);
    assert.ok(lease !== null);
    for (let write = 0; write < 200; write += 1) {
      await cache.set(`job:nightly:${String(write)}`, 'x', 60_000);
    }
    await cache.delete('job:nightly');
    assert.ok(server.read('app:test:lease:k:job:nightly') !== undefined);
    assert.equal(await leases.release(lease), true);
    await connections.close();
  });
});

describe('MemoryLeaseStore', () => {
  it('sweeps expired leases on acquire, so abandoned keys do not accumulate', async () => {
    const clock = createFakeClock();
    const store = new MemoryLeaseStore({ now: clock.now });
    for (let index = 0; index < 500; index += 1) {
      await store.acquire(`abandoned:${String(index)}`, 10);
    }
    clock.advance(20);
    const fresh = await store.acquire('fresh', 10);
    assert.ok(fresh !== null);
    assert.ok(fresh.fence > 500);
  });

  it('a renewal moves the expiry the sweep uses', async () => {
    const clock = createFakeClock();
    const store = new MemoryLeaseStore({ now: clock.now });
    const lease = await store.acquire('job', 100);
    assert.ok(lease !== null);
    clock.advance(80);
    assert.equal(await store.renew(lease, 100), true);
    clock.advance(80);
    await store.acquire('other', 100);
    assert.equal(await store.acquire('job', 100), null, 'the sweep kept the renewed lease');
  });

  it('refuses malformed options', () => {
    for (const options of [null, [], { now: 1 }]) {
      assert.throws(
        () => new MemoryLeaseStore(options as never),
        (error: unknown) => CacheErrors.is(error, 'invalid_option'),
      );
    }
  });
});

describe('ValkeyLeaseStore', () => {
  it('keeps leases under <app prefix>:lease with one fence counter', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyLeaseStore({ connections });
    const first = await store.acquire('a', 60_000);
    const second = await store.acquire('b', 60_000);
    assert.ok(first !== null && second !== null);
    assert.deepEqual(server.liveKeys(), [
      'app:test:lease:fence',
      'app:test:lease:k:a',
      'app:test:lease:k:b',
    ]);
    assert.equal(server.read('app:test:lease:k:a')?.toString(), `${first.token}:1`);
    assert.deepEqual([first.fence, second.fence], [1, 2]);
    await connections.close();
  });

  it('honours an explicit prefix', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyLeaseStore({ connections, prefix: 'locks' });
    await store.acquire('a', 60_000);
    assert.deepEqual(server.liveKeys(), ['locks:fence', 'locks:k:a']);
    await connections.close();
  });

  it('runs each operation as one script with an integer TTL', async () => {
    const clock = createFakeClock();
    const { connections, server } = fakeValkey({ server: new FakeValkeyServer(clock.now) });
    const store = new ValkeyLeaseStore({ connections });
    const lease = await store.acquire('a', 1500);
    assert.ok(lease !== null);
    assert.equal(server.ttlOf('app:test:lease:k:a'), 1500);
    await store.renew(lease, 2500);
    assert.equal(server.ttlOf('app:test:lease:k:a'), 2500);
    await store.release(lease);
    assert.deepEqual(
      server.commands.filter((command) => command !== 'config'),
      ['eval', 'eval', 'eval'],
    );
    await connections.close();
  });

  it('warns once when the server may evict keys', async () => {
    const { connections, server } = fakeValkey();
    server.maxmemoryPolicy = 'allkeys-lru';
    const warnings: string[] = [];
    const store = new ValkeyLeaseStore({
      connections,
      onWarning: (message) => warnings.push(message),
    });
    await Promise.all([store.acquire('a', 60_000), store.acquire('b', 60_000)]);
    await store.acquire('c', 60_000);
    assert.deepEqual(warnings, [LEASE_EVICTION_WARNING]);
    assert.equal(server.commands.filter((command) => command === 'config').length, 1);
    await connections.close();
  });

  it('does not warn for noeviction, a refused CONFIG, or a throwing observer', async () => {
    for (const policy of ['noeviction', undefined, 'volatile-lru']) {
      const { connections, server } = fakeValkey();
      server.maxmemoryPolicy = policy;
      const warnings: string[] = [];
      const store = new ValkeyLeaseStore({
        connections,
        onWarning: (message) => {
          warnings.push(message);
          throw new Error('observer failed');
        },
      });
      assert.ok((await store.acquire('a', 60_000)) !== null);
      assert.equal(warnings.length, policy === 'volatile-lru' ? 1 : 0);
      await connections.close();
    }
  });

  it('turns a backend failure into a value-free cache.unavailable', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyLeaseStore({ connections });
    const lease = await store.acquire('a', 60_000);
    assert.ok(lease !== null);
    server.failWith = new Error('NOAUTH s3cr3t');
    for (const run of [
      () => store.acquire('b', 1000),
      () => store.renew(lease, 1000),
      () => store.release(lease),
    ]) {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'unavailable'));
        assert.deepEqual(error.context, { store: 'lease' });
        assert.ok(!error.message.includes('s3cr3t'));
        return true;
      });
    }
    await connections.close();
  });

  it('reports a provider that cannot connect as cache.unavailable', async () => {
    const { connections } = fakeValkey();
    const store = new ValkeyLeaseStore({ connections });
    await connections.close();
    await assert.rejects(store.acquire('a', 1000), (error: unknown) =>
      CacheErrors.is(error, 'unavailable'),
    );
  });

  it('refuses a malformed fence reply', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyLeaseStore({ connections });
    server.put('app:test:lease:fence', Buffer.from('not a number'), 60_000);
    await assert.rejects(store.acquire('a', 1000), (error: unknown) =>
      CacheErrors.is(error, 'unavailable'),
    );
    await connections.close();
  });

  it('refuses malformed options', () => {
    const { connections } = fakeValkey();
    for (const options of [
      null,
      [],
      {},
      { connections, onWarning: 'loud' },
      { connections, prefix: 'two words' },
    ]) {
      assert.throws(
        () => new ValkeyLeaseStore(options as never),
        (error: unknown) => CacheErrors.is(error, 'invalid_option'),
      );
    }
  });
});
