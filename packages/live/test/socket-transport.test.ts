/**
 * Tests for the Socket.IO live transport (`@jsails/live`).
 *
 * Each case mounts a real Socket.IO server onto a loopback `node:http.Server`
 * via {@link attachLiveSocket} and connects an in-process Socket.IO client — no
 * network beyond loopback, no external service (docs/design/live.md §13.1). The
 * transport's security posture is exercised end to end:
 *
 * - a subscribe receives a snapshot translated onto the client-visible id;
 * - a committed write produces a change on the socket;
 * - a disconnect closes every open subscription;
 * - exceeding `maxSubscriptions` is rejected;
 * - oversized params are rejected against the 8 KB cap.
 *
 * Publication queries are backed by a real on-disk sql.js data source and the
 * transport-agnostic {@link createLiveService}, matching the live-service tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Async } from 'jsails/support';
import { deferred, waitFor } from 'jsails/testing';

import type { LiveService } from '../src/live-service.js';
import type { LiveSocketOptions } from '../src/socket-transport.js';
import { LIVE_EVENTS } from '../src/wire.js';
import {
  openClient,
  startLive as startLiveStack,
  stopLive,
  subscribe,
  WAIT_MS,
} from './fixtures.js';

const TABLE = 'live_items_socket';

/** Start the shared live stack over this file's table. */
function startLive(
  socket: Partial<LiveSocketOptions> = {},
  wrapService?: (service: LiveService) => LiveService,
) {
  return startLiveStack({ table: TABLE, socket, wrapService });
}

/** Hold every `service.subscribe` until `gate` resolves, exposing the in-flight window. */
function gateSubscribe(service: LiveService, gate: Promise<void>): LiveService {
  return {
    ...service,
    async subscribe(request, sink) {
      await gate;
      return service.subscribe(request, sink);
    },
  };
}

describe('Socket.IO live transport', () => {
  it('subscribe receives a snapshot under the client-visible subscription id', async () => {
    const running = await startLive();
    try {
      const client = await openClient(running.port);
      const ack = await subscribe(client.socket, 'live.items');
      assert.deepEqual(ack, { ok: true });

      const message = await client.next((m) => m.type === 'snapshot');
      assert.equal(message.type, 'snapshot');
      assert.equal(message.rows.length, 0);
      assert.equal(typeof message.subscriptionId, 'string');
      assert.ok(message.subscriptionId.length > 0);

      client.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('a committed write produces a change on the socket', async () => {
    const running = await startLive();
    try {
      const client = await openClient(running.port);
      await subscribe(client.socket, 'live.items');
      const snapshot = await client.next((m) => m.type === 'snapshot');
      assert.equal(snapshot.type, 'snapshot');

      const item = await running.Item.create({ name: 'alice', status: 'published' }).save();

      const change = await client.next((m) => m.type === 'change');
      assert.equal(change.type, 'change');
      assert.equal(change.collection, 'items');
      assert.equal(change.id, String(item.id));
      assert.deepEqual((change as { row: unknown }).row, {
        id: item.id,
        name: 'alice',
        status: 'published',
        ownerId: null,
      });

      client.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('disconnect closes every open subscription without a delivery error', async () => {
    const running = await startLive();
    try {
      const client = await openClient(running.port);
      await subscribe(client.socket, 'live.items');
      await client.next((m) => m.type === 'snapshot');
      await subscribe(client.socket, 'live.items');
      await client.next((m) => m.type === 'snapshot');

      client.socket.close();
      await Async.sleep(100);

      // A write committed after the disconnect must not surface a delivery
      // error through the adapter (each slot was closed by the disconnect).
      await running.Item.create({ name: 'after-disconnect', status: 'published' }).save();
      await Async.sleep(100);
    } finally {
      await stopLive(running);
    }
  });

  it('rejects a subscribe exceeding maxSubscriptions', async () => {
    const running = await startLive({ maxSubscriptions: 2 });
    try {
      const client = await openClient(running.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });

      const third = await subscribe(client.socket, 'live.items');
      assert.equal(third.ok, false);
      assert.equal(third.error, 'too_many_subscriptions');

      client.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('rejects oversized params against the 8 KB cap', async () => {
    const running = await startLive();
    try {
      const client = await openClient(running.port);
      const oversized = { blob: 'x'.repeat(10 * 1024) };
      const ack = await subscribe(client.socket, 'live.items', oversized);
      assert.equal(ack.ok, false);
      assert.equal(ack.error, 'params_too_large');

      client.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('counts a pending subscribe against maxSubscriptions', async () => {
    const gate = deferred();
    const running = await startLive({ maxSubscriptions: 1 }, (service) =>
      gateSubscribe(service, gate.promise),
    );
    try {
      const client = await openClient(running.port);
      const first = subscribe(client.socket, 'live.items');
      const second = subscribe(client.socket, 'live.items');

      const secondAck = await second;
      assert.equal(secondAck.ok, false);
      assert.equal(secondAck.error, 'too_many_subscriptions');

      gate.resolve();
      assert.deepEqual(await first, { ok: true });

      client.socket.close();
    } finally {
      gate.resolve();
      await stopLive(running);
    }
  });

  it('allocates a unique id to each concurrent subscribe', async () => {
    const gate = deferred();
    const running = await startLive({}, (service) => gateSubscribe(service, gate.promise));
    try {
      const client = await openClient(running.port);
      const first = subscribe(client.socket, 'live.items');
      const second = subscribe(client.socket, 'live.items');

      gate.resolve();
      assert.deepEqual(await first, { ok: true });
      assert.deepEqual(await second, { ok: true });

      const ids = new Set<string>();
      for (let i = 0; i < 2; i += 1) {
        const message = await client.next(
          (m) => m.type === 'snapshot' && !ids.has(m.subscriptionId),
        );
        assert.ok(message.type === 'snapshot');
        ids.add(message.subscriptionId);
      }
      assert.equal(ids.size, 2);

      client.socket.close();
    } finally {
      gate.resolve();
      await stopLive(running);
    }
  });

  it('closes a handle whose subscribe resolves after disconnect', async () => {
    const entered = deferred();
    const gate = deferred();
    const closed: string[] = [];
    const running = await startLive({}, (service) => ({
      ...service,
      async subscribe(request, sink) {
        entered.resolve();
        await gate.promise;
        const handle = await service.subscribe(request, sink);
        return {
          id: handle.id,
          close: async () => {
            closed.push(handle.id);
            await handle.close();
          },
        };
      },
    }));
    try {
      const client = await openClient(running.port);
      client.socket.emit(LIVE_EVENTS.subscribe, { publication: 'live.items', params: {} });
      await entered.promise;

      client.socket.close();
      await Async.sleep(100);
      gate.resolve();

      await waitFor(() => closed.length === 1, { timeoutMs: WAIT_MS });
      assert.equal(closed.length, 1);
    } finally {
      gate.resolve();
      await stopLive(running);
    }
  });
});
