/**
 * Mutex store tests: the in-memory store's acquire/release lifecycle, expiry
 * through an injectable clock, and value-free error paths; the Valkey-backed
 * store's lazy connection, atomic acquire via `SET NX PX`, prefixed keys,
 * idempotent close, and value-free backend errors through a fake client.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MutexError } from 'jsails/cache';
import { createFakeClock } from 'jsails/testing';
import { MemoryMutexStore, ValkeyMutexStore } from '../src/index.js';
import { fakeClientDependencies } from './fake-valkey-client.js';

describe('MemoryMutexStore', () => {
  it('acquire returns true on a free key', async () => {
    const store = new MemoryMutexStore();
    assert.equal(await store.acquire('task:daily-digest', 5000), true);
  });

  it('acquire returns false while held', async () => {
    const store = new MemoryMutexStore();
    assert.equal(await store.acquire('task:daily-digest', 5000), true);
    assert.equal(await store.acquire('task:daily-digest', 5000), false);
  });

  it('release frees a held key', async () => {
    const store = new MemoryMutexStore();
    assert.equal(await store.acquire('k', 5000), true);
    await store.release('k');
    assert.equal(await store.acquire('k', 5000), true);
  });

  it('release of an absent key is a no-op', async () => {
    const store = new MemoryMutexStore();
    await store.release('nonexistent');
    assert.equal(await store.acquire('nonexistent', 5000), true);
  });

  it('expiry frees a key automatically', async () => {
    const { now, advance } = createFakeClock();
    const store = new MemoryMutexStore({ now });

    assert.equal(await store.acquire('k', 1000), true);
    assert.equal(await store.acquire('k', 1000), false);

    advance(999);
    assert.equal(await store.acquire('k', 1000), false);

    advance(1);
    assert.equal(await store.acquire('k', 1000), true);
  });

  it('acquire after expiry re-sets the TTL', async () => {
    const { now, advance } = createFakeClock();
    const store = new MemoryMutexStore({ now });

    assert.equal(await store.acquire('k', 1000), true);
    advance(1000);
    // The key has expired; re-acquiring creates a fresh entry.
    assert.equal(await store.acquire('k', 500), true);
    advance(300);
    assert.equal(await store.acquire('k', 500), false);
    advance(200);
    assert.equal(await store.acquire('k', 500), true);
  });

  it('close clears all entries and is idempotent', async () => {
    const store = new MemoryMutexStore();
    assert.equal(await store.acquire('k1', 5000), true);
    assert.equal(await store.acquire('k2', 5000), true);

    await store.close();
    await store.close();
    assert.equal(await store.acquire('k1', 5000), true);
    assert.equal(await store.acquire('k2', 5000), true);
  });

  it('acquire rejects a value-free MutexError on an invalid key', async () => {
    const store = new MemoryMutexStore();

    for (const bad of ['', null, undefined, 123, {}, []]) {
      await assert.rejects(store.acquire(bad as string, 5000), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'invalid_key');
        return true;
      });
    }
  });

  it('acquire rejects a value-free MutexError on an invalid ttlMs', async () => {
    const store = new MemoryMutexStore();
    for (const value of [NaN, Infinity, -Infinity, 0, -1]) {
      await assert.rejects(store.acquire('k', value), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'invalid_ttl');
        return true;
      });
    }
  });

  it('release rejects a value-free MutexError on an invalid key', async () => {
    const store = new MemoryMutexStore();

    await assert.rejects(store.release(''), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'invalid_key');
      return true;
    });
  });

  it('rejects a non-object options argument', () => {
    assert.throws(() => new MemoryMutexStore(null as never), TypeError);
    assert.throws(() => new MemoryMutexStore([] as never), TypeError);
    assert.throws(() => new MemoryMutexStore('string' as never), TypeError);
    assert.throws(() => new MemoryMutexStore(42 as never), TypeError);
  });

  it('rejects now when it is not a function', () => {
    assert.throws(() => new MemoryMutexStore({ now: 'not-a-function' as never }), TypeError);
    assert.throws(() => new MemoryMutexStore({ now: 42 as never }), TypeError);
  });

  it('MutexError has the correct name and code', () => {
    const error = new MutexError('invalid_key', 'msg');
    assert.equal(error.name, 'MutexError');
    assert.equal(error.code, 'invalid_key');
    assert.equal(error.message, 'msg');
    assert.ok(error instanceof Error);
  });
});

describe('ValkeyMutexStore', () => {
  it('acquire returns true when the client returns OK', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://host:6379' }, dependencies);
    try {
      assert.equal(await store.acquire('task:send', 5000), true);
      assert.equal(instances.length, 1);
      assert.equal(instances[0]!.connected, 1);
    } finally {
      await store.close();
    }
  });

  it('acquire returns false when the client returns null', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://host:6379' }, dependencies);
    try {
      // Force the client connection first, then switch the set result.
      assert.equal(await store.acquire('task:send', 5000), true);
      instances[0]!.setResult = null;
      assert.equal(await store.acquire('task:send', 5000), false);
    } finally {
      await store.close();
    }
  });

  it('release calls del with the prefixed key', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore(
      { valkeyUrl: 'redis://h', prefix: 'app:mutex' },
      dependencies,
    );
    try {
      assert.equal(await store.acquire('k', 1000), true);
      const client = instances[0]!;
      client.keys.length = 0;
      await store.release('k');
      assert.deepEqual(client.keys, ['app:mutex:k']);
    } finally {
      await store.close();
    }
  });

  it('is fully lazy: no client constructed until the first operation', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://host:6379' }, dependencies);

    assert.equal(instances.length, 0, 'construction must be lazy');

    try {
      await store.acquire('k', 1000);
      assert.equal(instances.length, 1);
      assert.equal(instances[0]!.connected, 1);
    } finally {
      await store.close();
    }
  });

  it('close disconnects exactly once and is idempotent', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://h' }, dependencies);

    await store.acquire('k', 1000); // force the connect
    await store.close();
    await store.close();

    assert.equal(instances[0]!.disconnected, 1);
  });

  it('operations after close throw MutexError(closed)', async () => {
    const { dependencies } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://h' }, dependencies);

    await store.acquire('k', 1000); // force the connect
    await store.close();

    for (const operation of [store.acquire('k', 1000), store.release('k')]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'closed');
        return true;
      });
    }
  });

  it('close is a no-op when no client was ever created', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://h' }, dependencies);

    await store.close();
    assert.equal(instances.length, 0, 'no client should have been constructed');
  });

  it('missing URL throws a value-free MutexError', async () => {
    const { dependencies } = fakeClientDependencies();

    const saved = process.env.VALKEY_URL;
    delete process.env.VALKEY_URL;
    try {
      const store = new ValkeyMutexStore({}, dependencies);
      await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'unavailable');
        return true;
      });
    } finally {
      if (saved !== undefined) {
        process.env.VALKEY_URL = saved;
      }
    }
  });

  it('backend error surfaces as value-free MutexError(unavailable)', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore(
      { valkeyUrl: 'redis://user:secret@host:6379/0' },
      dependencies,
    );

    try {
      // Force connect first, then make the next operation throw.
      await store.acquire('k', 1000);
      const backendError = new Error('connection to redis://user:secret@host:6379/0 failed');
      (backendError as NodeJS.ErrnoException).code = 'ECONNREFUSED';
      instances[0]!.throwOnOperation = backendError;

      await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
        assert.ok(error instanceof MutexError);
        assert.equal(error.code, 'unavailable');
        const message = String(error);
        assert.ok(message.includes('ECONNREFUSED'), 'the errno code is kept in the message');
        for (const fragment of ['secret', 'user', '6379', 'redis://', 'host']) {
          assert.ok(!message.includes(fragment), `error must not echo "${fragment}"`);
        }
        return true;
      });
    } finally {
      await store.close();
    }
  });

  it('prefix override is respected', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore(
      { valkeyUrl: 'redis://h', prefix: 'custom:mutex' },
      dependencies,
    );
    try {
      await store.acquire('task:daily', 1000);
      assert.deepEqual(instances[0]!.keys, ['custom:mutex:task:daily']);
    } finally {
      await store.close();
    }
  });

  it('default prefix is jsails:mutex', async () => {
    const { dependencies, instances } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'redis://h' }, dependencies);
    try {
      await store.acquire('k', 1000);
      assert.deepEqual(instances[0]!.keys, ['jsails:mutex:k']);
    } finally {
      await store.close();
    }
  });

  it('rejects a non-redis scheme value-free', async () => {
    const { dependencies } = fakeClientDependencies();
    const store = new ValkeyMutexStore({ valkeyUrl: 'http://secret@host' }, dependencies);

    await assert.rejects(store.acquire('k', 1000), (error: unknown) => {
      assert.ok(error instanceof MutexError);
      assert.equal(error.code, 'unavailable');
      assert.ok(!String(error).includes('secret'));
      return true;
    });
  });

  it('rejects a non-object options argument', () => {
    assert.throws(() => new ValkeyMutexStore(null as never), TypeError);
    assert.throws(() => new ValkeyMutexStore([] as never), TypeError);
    assert.throws(() => new ValkeyMutexStore('string' as never), TypeError);
    assert.throws(() => new ValkeyMutexStore(42 as never), TypeError);
  });

  it('rejects onError when it is not a function', () => {
    assert.throws(() => new ValkeyMutexStore({ onError: 'not-a-function' as never }), TypeError);
    assert.throws(() => new ValkeyMutexStore({ onError: 42 as never }), TypeError);
  });
});
