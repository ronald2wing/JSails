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
 * - oversized params are rejected against the 8 KB cap;
 * - the user is resolved from the handshake, never from the payload, and an
 *   identity that stops resolving is disconnected.
 *
 * Publication queries are backed by a real on-disk sql.js data source and the
 * transport-agnostic {@link createLiveService}, matching the live-service tests.
 */

import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';

import { Async } from 'jsails/support';
import { deferred, waitFor } from 'jsails/testing';

import type { LiveService, LiveSubscribeRequest } from '../src/live-service.js';
import { attachLiveSocket, type LiveSocketOptions } from '../src/socket-transport.js';
import { LIVE_EVENTS, LIVE_PATH } from '../src/wire.js';
import {
  openClient,
  ORIGIN,
  startLive as startLiveStack,
  stopLive,
  subscribe,
  WAIT_MS,
} from './fixtures.js';

const TABLE = 'live_items_socket';

/** Record every request the transport hands the service. */
function recordRequests(requests: LiveSubscribeRequest[]) {
  return (service: LiveService): LiveService => ({
    ...service,
    subscribe(request, sink) {
      requests.push(request);
      return service.subscribe(request, sink);
    },
  });
}

/** A resolver that trusts only the `session` cookie the test controls. */
function cookieUser(sessions: Map<string, string>) {
  return ({ request }: { request: Request }) => {
    const cookie = request.headers.get('cookie') ?? '';
    const match = /session=([^;]+)/.exec(cookie);
    const userId = match === null ? undefined : sessions.get(match[1] ?? '');
    return userId === undefined ? null : { id: userId };
  };
}

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

  it('resolves the user from the handshake session and ignores a payload user', async () => {
    const requests: LiveSubscribeRequest[] = [];
    const sessions = new Map([['token-1', 'alice']]);
    const running = await startLive(
      { resolveUser: cookieUser(sessions) },
      recordRequests(requests),
    );
    try {
      const client = await openClient(running.port, { Cookie: 'session=token-1' });
      client.socket.emit(LIVE_EVENTS.subscribe, {
        publication: 'live.items',
        params: {},
        user: { id: 'mallory' },
      });
      await client.next((m) => m.type === 'snapshot');
      const [request] = requests;
      assert.deepEqual(request?.user, { id: 'alice' });
      assert.equal(request?.request?.origin, 'https://app.example');
      assert.equal(typeof request?.request?.ip, 'string');
      assert.equal(request?.request?.headers['cookie'], 'session=token-1');

      const anonymous = await openClient(running.port);
      await subscribe(anonymous.socket, 'live.items');
      assert.equal(requests[1]?.user, null);

      client.socket.close();
      anonymous.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('rejects a connection whose resolver throws', async () => {
    const running = await startLive({
      resolveUser: () => {
        throw new Error('session store down');
      },
    });
    try {
      await assert.rejects(openClient(running.port), /unauthorized/);
    } finally {
      await stopLive(running);
    }
  });

  it('disconnects a socket whose session stops resolving', async () => {
    const sessions = new Map([['token-1', 'alice']]);
    const running = await startLive({
      resolveUser: cookieUser(sessions),
      revalidateIntervalMs: 20,
    });
    try {
      const client = await openClient(running.port, { Cookie: 'session=token-1' });
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      let disconnected = false;
      client.socket.on('disconnect', () => {
        disconnected = true;
      });
      await Async.sleep(60);
      assert.equal(disconnected, false, 'a still-valid session stays connected');

      sessions.delete('token-1');
      await waitFor(() => disconnected, { timeoutMs: WAIT_MS, label: 'revoked disconnect' });
    } finally {
      await stopLive(running);
    }
  });

  it('disconnects a socket whose user keeps its id but changes a claim', async () => {
    const roles = new Map([['alice', 'admin']]);
    const running = await startLive({
      resolveUser: () => ({ id: 'alice', role: roles.get('alice') }),
      revalidateIntervalMs: 20,
    });
    try {
      const client = await openClient(running.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      let disconnected = false;
      client.socket.on('disconnect', () => {
        disconnected = true;
      });
      await Async.sleep(60);
      assert.equal(disconnected, false, 'an unchanged user stays connected');

      roles.set('alice', 'viewer');
      await waitFor(() => disconnected, { timeoutMs: WAIT_MS, label: 'demoted disconnect' });
    } finally {
      await stopLive(running);
    }
  });

  it('revokes a subscription whose authorize stops admitting the same user', async () => {
    const granted = new Set(['alice']);
    const authorizedUsers: unknown[] = [];
    const running = await startLive(
      { resolveUser: () => ({ id: 'alice' }), revalidateIntervalMs: 20 },
      (service) => ({
        ...service,
        authorize(request) {
          authorizedUsers.push(request.user);
          return Promise.resolve(granted.has(request.user?.id ?? ''));
        },
      }),
    );
    try {
      const client = await openClient(running.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      await client.next((m) => m.type === 'snapshot');
      await waitFor(() => authorizedUsers.length > 0, { timeoutMs: WAIT_MS, label: 're-check' });
      assert.deepEqual(authorizedUsers[0], { id: 'alice' });

      granted.delete('alice');
      const revoked = await client.next((m) => m.type === 'error');
      assert.deepEqual(revoked, { type: 'error', subscriptionId: '1', code: 'unauthorized' });

      // The revoked subscription receives nothing further, and the socket stays up.
      await running.Item.create({ name: 'after revoke', status: 'draft' }).save();
      await Async.sleep(60);
      assert.equal(
        client.messages.some((m) => m.type === 'change'),
        false,
      );
      assert.equal(client.socket.connected, true);
    } finally {
      await stopLive(running);
    }
  });

  it('refuses a foreign origin before the WebSocket upgrade', async () => {
    const running = await startLive();
    try {
      // Engine.IO refuses an upgrade its `allowRequest` rejects with a 400
      // whose body names the reason, instead of switching protocols.
      assert.deepEqual(await upgradeAttempt(running.url, 'https://evil.example'), {
        status: 400,
        body: 'Forbidden',
      });
      assert.equal((await upgradeAttempt(running.url, ORIGIN)).status, 101);
    } finally {
      await stopLive(running);
    }
  });

  it('closes a connection that sends a frame over the message cap', async () => {
    const running = await startLive();
    try {
      const client = await openClient(running.port);
      let disconnected = false;
      client.socket.on('disconnect', () => {
        disconnected = true;
      });
      client.socket.emit(LIVE_EVENTS.subscribe, {
        publication: 'live.items',
        params: { padding: 'x'.repeat(20 * 1024) },
      });
      await waitFor(() => disconnected, { timeoutMs: WAIT_MS, label: 'oversized frame' });
    } finally {
      await stopLive(running);
    }
  });

  it('keeps the frame cap above a raised params cap', async () => {
    const running = await startLive({ maxParamsBytes: 20 * 1024 });
    try {
      const client = await openClient(running.port);
      let disconnected = false;
      client.socket.on('disconnect', () => {
        disconnected = true;
      });
      // Params right at the raised cap pass their own check, so the frame
      // carrying them must not close the connection.
      const blob = 'x'.repeat(20 * 1024 - JSON.stringify({ blob: '' }).length);
      const ack = await subscribe(client.socket, 'live.items', { blob });
      assert.deepEqual(ack, { ok: true });
      assert.equal(disconnected, false);

      const over = await subscribe(client.socket, 'live.items', { blob: `${blob}x` });
      assert.equal(over.error, 'params_too_large');
      assert.equal(disconnected, false);

      client.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('refuses a frame cap that leaves no room above the params cap', () => {
    const server = createServer();
    const service = {} as LiveService;
    assert.throws(
      () =>
        attachLiveSocket(server, service, {
          allowedOrigins: [ORIGIN],
          maxParamsBytes: 16 * 1024,
          maxMessageBytes: 16 * 1024,
        }),
      TypeError,
    );
    assert.throws(
      () => attachLiveSocket(server, service, { allowedOrigins: [ORIGIN], maxMessageBytes: 8192 }),
      TypeError,
    );
  });

  it('refuses a publication name longer than the subscribe envelope allows', async () => {
    const running = await startLive();
    try {
      const client = await openClient(running.port);
      const ack = await subscribe(client.socket, 'p'.repeat(129));
      assert.equal(ack.error, 'invalid_request');

      client.socket.close();
    } finally {
      await stopLive(running);
    }
  });

  it('drops events over the inbound rate and disconnects a flooding socket', async () => {
    const running = await startLive({ inboundRate: 5 });
    try {
      const client = await openClient(running.port);
      let disconnected = false;
      client.socket.on('disconnect', () => {
        disconnected = true;
      });
      const acks: SubscribeAckShape[] = [];
      for (let index = 0; index < 8; index += 1) {
        client.socket.emit(
          LIVE_EVENTS.subscribe,
          { publication: 'live.items', params: {} },
          (ack: SubscribeAckShape) => acks.push(ack),
        );
      }
      await waitFor(() => acks.length === 8, { timeoutMs: WAIT_MS, label: 'acks' });
      assert.equal(acks.filter((ack) => ack.error === 'rate_limited').length, 3);
      assert.equal(disconnected, false, 'a burst alone is dropped, not cut off');

      for (let index = 0; index < 20; index += 1) {
        client.socket.emit(LIVE_EVENTS.unsubscribe, { subscriptionId: 'none' });
      }
      await waitFor(() => disconnected, { timeoutMs: WAIT_MS, label: 'flood disconnect' });
    } finally {
      await stopLive(running);
    }
  });
});

/** Send a bare WebSocket upgrade to the live path and report how the server answered. */
function upgradeAttempt(url: string, origin: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}${LIVE_PATH}/?EIO=4&transport=websocket`, {
      headers: {
        Origin: origin,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      resolve({ status: 101, body: '' });
    });
    request.once('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

interface SubscribeAckShape {
  readonly ok: boolean;
  readonly error?: string;
}
