/**
 * `ValkeyCacheStore` over the fake Valkey: the cache contract's conformance
 * cases, then the wire format (a tag byte keeps a value's type; a foreign
 * value reads as a miss), the key layout under the app prefix, laziness, and
 * value-free failures.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { CacheErrors } from 'jsails/cache';
import { cacheStoreConformance, createFakeClock } from 'jsails/testing';

import { ValkeyCacheStore } from '../src/index.js';
import { decodeCacheValue, encodeCacheValue } from '../src/valkey-cache-store.js';
import { FakeValkeyServer, fakeValkey } from './fake-valkey-client.js';

for (const entry of cacheStoreConformance(async () => {
  const clock = createFakeClock();
  const { connections } = fakeValkey({ server: new FakeValkeyServer(clock.now) });
  const store = new ValkeyCacheStore({ connections });
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
  test(`ValkeyCacheStore conformance: ${entry.name}`, () => entry.run());
}

describe('ValkeyCacheStore wire format', () => {
  it('prefixes a string with s and bytes with b', () => {
    assert.deepEqual([...encodeCacheValue('hé')], [0x73, 0x68, 0xc3, 0xa9]);
    assert.deepEqual([...encodeCacheValue(Uint8Array.of(1, 2))], [0x62, 1, 2]);
    assert.equal(decodeCacheValue(Buffer.from([0x73, 0x68, 0xc3, 0xa9])), 'hé');
    assert.deepEqual([...(decodeCacheValue(Buffer.from([0x62, 9])) as Uint8Array)], [9]);
  });

  it('reads an absent, empty or foreign value as a miss', async () => {
    assert.equal(decodeCacheValue(null), null);
    assert.equal(decodeCacheValue(Buffer.alloc(0)), null);
    assert.equal(decodeCacheValue(Buffer.from('plain')), null);

    const { connections, server } = fakeValkey();
    const store = new ValkeyCacheStore({ connections });
    server.put('app:test:cache:foreign', Buffer.from('written by redis-cli'));
    assert.equal(await store.get('foreign'), null);
    await connections.close();
  });

  it('decodes bytes into a copy that does not alias the reply buffer', () => {
    const reply = Buffer.from([0x62, 1, 2, 3]);
    const value = decodeCacheValue(reply) as Uint8Array;
    reply[1] = 9;
    assert.deepEqual([...value], [1, 2, 3]);
    assert.ok(!(value instanceof Buffer), 'a plain Uint8Array, as the memory store returns');
  });
});

describe('ValkeyCacheStore keys and connections', () => {
  it('keeps keys under <app prefix>:cache and namespaces under their name', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyCacheStore({ connections });
    await store.set('root', 'v', 60_000);
    await store.namespace('pages').namespace('v2').set('k', 'v', 60_000);
    assert.deepEqual(server.liveKeys(), ['app:test:cache:pages:v2:k', 'app:test:cache:root']);
    await connections.close();
  });

  it('honours an explicit prefix and refuses a malformed one', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyCacheStore({ connections, prefix: 'tenant-a:{c}' });
    await store.set('k', 'v', 60_000);
    assert.deepEqual(server.liveKeys(), ['tenant-a:{c}:k']);
    for (const prefix of ['', 'has space', 'x'.repeat(129), 7]) {
      assert.throws(
        () => new ValkeyCacheStore({ connections, prefix: prefix as string }),
        (error: unknown) => CacheErrors.is(error, 'invalid_option'),
      );
    }
    await connections.close();
  });

  it('opens no connection until the first operation, and one for many', async () => {
    const { connections, instances } = fakeValkey();
    const store = new ValkeyCacheStore({ connections });
    assert.equal(instances.length, 0);
    await Promise.all([store.get('a'), store.set('b', 'v', 1000), store.getMany(['a', 'b'])]);
    assert.equal(instances.length, 1);
    await store.close();
    assert.equal(instances[0]?.disconnected, 0, 'the store leaves the app connections open');
    await connections.close();
  });

  it('reads many keys with one MGET', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyCacheStore({ connections });
    await store.getMany(['a', 'b', 'c']);
    assert.deepEqual(server.commands, ['mget']);
    await connections.close();
  });

  it('writes with an integer PX expiry and NX for add', async () => {
    const clock = createFakeClock();
    const { connections, server } = fakeValkey({ server: new FakeValkeyServer(clock.now) });
    const store = new ValkeyCacheStore({ connections });
    await store.set('k', 'v', 1234);
    assert.equal(server.ttlOf('app:test:cache:k'), 1234);
    assert.equal(await store.add('k', 'w', 5000), false);
    assert.equal(server.ttlOf('app:test:cache:k'), 1234, 'a refused add keeps the TTL');
    await connections.close();
  });

  it('turns a backend failure into a value-free cache.unavailable with the cause kept', async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyCacheStore({ connections });
    const failure = new Error('WRONGPASS secret-password for user');
    server.failWith = failure;
    for (const run of [
      () => store.get('k'),
      () => store.getMany(['k']),
      () => store.set('k', 'v', 1000),
      () => store.add('k', 'v', 1000),
      () => store.delete('k'),
    ]) {
      await assert.rejects(run, (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'unavailable'));
        assert.deepEqual(error.context, { store: 'cache' });
        assert.equal(error.cause, failure);
        assert.ok(!error.message.includes('secret'));
        return true;
      });
    }
    await connections.close();
  });

  it('reports a provider that cannot connect as cache.unavailable', async () => {
    const { connections } = fakeValkey();
    const store = new ValkeyCacheStore({ connections });
    await connections.close();
    await assert.rejects(store.get('k'), (error: unknown) => CacheErrors.is(error, 'unavailable'));
  });

  it('refuses malformed options', () => {
    const { connections } = fakeValkey();
    for (const options of [null, [], {}, { connections: {} }, { connections: { shared() {} } }]) {
      assert.throws(
        () => new ValkeyCacheStore(options as never),
        (error: unknown) => CacheErrors.is(error, 'invalid_option'),
      );
    }
    assert.ok(new ValkeyCacheStore({ connections }));
  });
});
