/**
 * The Valkey tag bus over the fake Valkey: publish and subscribe on the app's
 * shared connections and channel, a reconnect reported as a gap, a silent
 * `SUBSCRIBE` bounded, value-free failures, and two tag tables carrying an
 * invalidation between them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CacheErrors, createCacheTags, type CacheTagBusHandlers } from 'jsails/cache';
import { waitFor } from 'jsails/testing';

import { MemoryCacheStore, ValkeyTagBus } from '../src/index.js';
import { FAKE_VALKEY_URL, FakeValkeyServer, fakeValkey } from './fake-valkey-client.js';

function recorder(): CacheTagBusHandlers & { messages: string[]; gaps: number } {
  const state = {
    messages: [] as string[],
    gaps: 0,
    message(message: string) {
      state.messages.push(message);
    },
    gap() {
      state.gaps += 1;
    },
  };
  return state;
}

describe('ValkeyTagBus', () => {
  it('publishes on the app channel and delivers to subscribers', async () => {
    const { connections, server } = fakeValkey();
    try {
      const bus = new ValkeyTagBus({ connections });
      const handlers = recorder();
      const stop = await bus.subscribe(handlers);
      assert.equal(server.subscriberCount('app:test:cache:tags'), 1);
      await bus.publish('hello');
      await waitFor(() => handlers.messages.length === 1, { timeoutMs: 10_000 });
      assert.deepEqual(handlers.messages, ['hello']);
      server.publish('app:test:other', 'ignored');
      await stop();
      await bus.publish('after stop');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(handlers.messages, ['hello'], 'a stopped subscription hears nothing');
    } finally {
      await connections.close();
    }
  });

  it('reports a reconnect of the subscriber as a gap', async () => {
    const { connections, instances } = fakeValkey();
    try {
      const handlers = recorder();
      await new ValkeyTagBus({ connections }).subscribe(handlers);
      const subscriber = instances.find((client) => client.listenerCount('message') > 0);
      assert.ok(subscriber);
      subscriber.emit('ready');
      assert.equal(handlers.gaps, 1);
    } finally {
      await connections.close();
    }
  });

  it('bounds a SUBSCRIBE the server never answers', async () => {
    const server = new FakeValkeyServer();
    server.silentSubscribe = true;
    const { connections } = fakeValkey({ server });
    try {
      await assert.rejects(
        new ValkeyTagBus({ connections }).subscribe(recorder()),
        (error: unknown) => CacheErrors.is(error, 'unavailable'),
      );
    } finally {
      await connections.close();
    }
  });

  it('fails value-free when the server is down', async () => {
    const server = new FakeValkeyServer();
    server.failWith = new Error(`connection to ${FAKE_VALKEY_URL} refused`);
    const { connections } = fakeValkey({ server });
    try {
      await assert.rejects(new ValkeyTagBus({ connections }).publish('m'), (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'unavailable'));
        assert.doesNotMatch(error.message, /secret/u);
        return true;
      });
    } finally {
      await connections.close();
    }
  });

  it('refuses malformed options', () => {
    assert.throws(
      () => new ValkeyTagBus({ connections: {} as never }),
      (error: unknown) => CacheErrors.is(error, 'invalid_option'),
    );
    const { connections } = fakeValkey();
    assert.throws(
      () => new ValkeyTagBus({ connections, channel: 'has space' }),
      (error: unknown) => CacheErrors.is(error, 'invalid_option'),
    );
  });

  it('carries an invalidation from one tag table to another', async () => {
    const server = new FakeValkeyServer();
    const first = fakeValkey({ server });
    const second = fakeValkey({ server });
    const store = new MemoryCacheStore();
    const writer = createCacheTags({
      store,
      bus: new ValkeyTagBus({ connections: first.connections }),
      syncMs: 3_600_000,
    });
    const reader = createCacheTags({
      store,
      bus: new ValkeyTagBus({ connections: second.connections }),
      syncMs: 3_600_000,
    });
    try {
      const [before] = await reader.tokens(['t']);
      await writer.tokens(['t']);
      const sequence = reader.sequence;
      await writer.invalidate(['t']);
      await waitFor(() => reader.sequence > sequence, { timeoutMs: 10_000 });
      const [after] = await reader.tokens(['t']);
      assert.notEqual(after, before);
    } finally {
      await writer.close();
      await reader.close();
      await first.connections.close();
      await second.connections.close();
    }
  });
});
