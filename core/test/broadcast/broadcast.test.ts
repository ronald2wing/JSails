/**
 * End-to-end tests for the broadcast module against a real local HTTP server
 * and Socket.IO over the loopback interface (no Valkey). Each case binds an
 * ephemeral port on 127.0.0.1, so no privileged port or external service is
 * required. Timeouts bound every socket wait so a failure surfaces as an error
 * rather than a hang.
 */

import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, it } from 'node:test';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { Adapter } from 'socket.io-adapter';

import {
  attachBroadcast,
  BROADCAST_PATH,
  type Broadcast,
  type BroadcastOptions,
} from '../../src/broadcast/server.js';
import {
  SocketIOBroadcastClient,
  type BroadcastClient,
  type BroadcastEvent,
} from '../../src/broadcast/client.js';
import {
  createValkeyPubSub,
  type ValkeyPubSubDependencies,
} from '../../src/broadcast/valkey-adapter.js';
import {
  createValkeyConnections,
  type ValkeyConnections,
  type ValkeyConnectionsOptions,
} from '../../src/valkey/connections.js';

// Protocol event names, mirrored from src/broadcast/server.ts (not exported).
const SUBSCRIBE_EVENT = 'jsails:subscribe';
const UNSUBSCRIBE_EVENT = 'jsails:unsubscribe';
const BROADCAST_EVENT = 'jsails:event';

const ORIGIN = 'https://app.example';
const WAIT_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Default identity: the token after `Bearer ` in the Authorization header. */
function bearerIdentity(handshake: { headers: { authorization?: string } }): string | null {
  const auth = handshake.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : null;
}

interface RunningBroadcast {
  broadcast: Broadcast;
  httpServer: HttpServer;
  port: number;
}

async function startBroadcast(
  overrides: Partial<BroadcastOptions> = {},
): Promise<RunningBroadcast> {
  const httpServer = createServer();
  const options: BroadcastOptions = {
    allowedOrigins: [ORIGIN],
    authenticate: (handshake) => bearerIdentity(handshake),
    ...overrides,
  };
  const broadcast = await attachBroadcast(httpServer, options);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  return { broadcast, httpServer, port: (httpServer.address() as AddressInfo).port };
}

/** Connect a raw Socket.IO client for low-level protocol assertions. */
function connectRaw(port: number, origin: string, authorization?: string): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: {
      Origin: origin,
      ...(authorization !== undefined ? { Authorization: authorization } : {}),
    },
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('connect timed out'));
    }, WAIT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

interface RawAck {
  ok: boolean;
  error?: string;
  denied?: string[];
}

function subscribeRaw(socket: ClientSocket, channels: string[]): Promise<RawAck> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), WAIT_MS);
    socket.emit(SUBSCRIBE_EVENT, { channels }, (response: RawAck) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function unsubscribeRaw(
  socket: ClientSocket,
  channels: string[],
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('unsubscribe ack timed out')), WAIT_MS);
    socket.emit(UNSUBSCRIBE_EVENT, { channels }, (response: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function nextRawEvent(socket: ClientSocket): Promise<BroadcastEvent> {
  return new Promise((resolve, reject) => {
    const handler = (payload: BroadcastEvent): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(BROADCAST_EVENT, handler);
      reject(new Error('broadcast event timed out'));
    }, WAIT_MS);
    socket.on(BROADCAST_EVENT, handler);
  });
}

async function assertNoRawEvent(socket: ClientSocket, windowMs = 300): Promise<void> {
  let received = false;
  const handler = (): void => {
    received = true;
  };
  socket.on(BROADCAST_EVENT, handler);
  await delay(windowMs);
  socket.off(BROADCAST_EVENT, handler);
  assert.equal(received, false, 'expected no broadcast event');
}

function connectClient(
  port: number,
  authorization: string,
  onError?: (error: Error) => void,
): BroadcastClient {
  return new SocketIOBroadcastClient({
    url: `http://127.0.0.1:${port}`,
    path: BROADCAST_PATH,
    extraHeaders: { Origin: ORIGIN, Authorization: authorization },
    onError,
  });
}

function nextClientEvent(client: BroadcastClient): Promise<BroadcastEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('broadcast event timed out'));
    }, WAIT_MS);
    const unsubscribe = client.onEvent((event) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

describe('broadcast authentication and origin', () => {
  it('rejects a connection the authenticate callback denies', async () => {
    const { broadcast, port } = await startBroadcast({ authenticate: () => null });
    try {
      await assert.rejects(
        connectRaw(port, ORIGIN, 'Bearer user-1'),
        (error: Error) => error.message === 'unauthorized',
      );
    } finally {
      await broadcast.close();
    }
  });

  it('rejects a connection whose origin is not allowlisted', async () => {
    const { broadcast, port } = await startBroadcast();
    try {
      await assert.rejects(connectRaw(port, 'https://evil.example', 'Bearer user-1'));
    } finally {
      await broadcast.close();
    }
  });

  it('rejects a connection with no origin header', async () => {
    const { broadcast, port } = await startBroadcast();
    const socket = createClient(`http://127.0.0.1:${port}`, {
      path: BROADCAST_PATH,
      transports: ['websocket'],
      reconnection: false,
      timeout: 2000,
    });
    try {
      await assert.rejects(
        new Promise<ClientSocket>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect timed out')), WAIT_MS);
          socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
          });
          socket.once('connect_error', (error: Error) => {
            clearTimeout(timer);
            reject(error);
          });
        }),
      );
    } finally {
      socket.close();
      await broadcast.close();
    }
  });
});

describe('broadcast subscription', () => {
  it('denies every channel by default when authorizeChannel is omitted', async () => {
    const { broadcast, port } = await startBroadcast();
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const response = await subscribeRaw(socket, ['room-1']);
      assert.deepEqual(response, { ok: false, error: 'unauthorized', denied: ['room-1'] });
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('delivers a broadcast to an authorized, subscribed client', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const response = await subscribeRaw(socket, ['room-1']);
      assert.deepEqual(response, { ok: true });
      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'greeting', { hello: 'world' });
      const event = await pending;
      assert.equal(event.channel, 'room-1');
      assert.equal(event.event, 'greeting');
      assert.deepEqual(event.data, { hello: 'world' });
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('does not deliver to a channel the identity is not authorized for', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      assert.deepEqual(await subscribeRaw(socket, ['room-2']), {
        ok: false,
        error: 'unauthorized',
        denied: ['room-2'],
      });

      broadcast.emit('room-2', 'secret', { value: 1 });
      await assertNoRawEvent(socket);

      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'still-works', {});
      await pending;
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('stops delivery after an explicit unsubscribe', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      const first = nextRawEvent(socket);
      broadcast.emit('room-1', 'first', {});
      await first;

      assert.deepEqual(await unsubscribeRaw(socket, ['room-1']), { ok: true });
      broadcast.emit('room-1', 'second', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('enforces maxSubscriptions under concurrent delayed authorization', async () => {
    const { broadcast, port } = await startBroadcast({
      maxSubscriptions: 1,
      authorizeChannel: async () => {
        await delay(50);
        return true;
      },
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      // Two subscribes in flight before either authorization resolves: without
      // serialization both pass the cap check and both join.
      const first = subscribeRaw(socket, ['channel-a']);
      const second = subscribeRaw(socket, ['channel-b']);
      const [a, b] = await Promise.all([first, second]);
      assert.equal(
        [a, b].filter((response) => response.ok).length,
        1,
        'only one channel may join under maxSubscriptions=1',
      );

      const pending = nextRawEvent(socket);
      broadcast.emit('channel-a', 'ping', {});
      await pending;

      broadcast.emit('channel-b', 'pong', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('serializes an unsubscribe behind an in-flight subscribe', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: async () => {
        await delay(50);
        return true;
      },
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const subscribe = subscribeRaw(socket, ['room-x']);
      // Issued before the delayed authorization completes: without
      // serialization the unsubscribe would run first and be lost, leaving the
      // socket subscribed against the caller's intent.
      const unsubscribe = unsubscribeRaw(socket, ['room-x']);
      const [sub, unsub] = await Promise.all([subscribe, unsubscribe]);
      assert.equal(sub.ok, true);
      assert.equal(unsub.ok, true);

      broadcast.emit('room-x', 'ping', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('rejects malformed subscribe payloads with a generic error', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: () => true,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      for (const payload of [
        null,
        42,
        {},
        { channels: [] },
        { channels: 'room-1' },
        { channels: [42] },
      ]) {
        const response = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('ack timed out')), WAIT_MS);
          socket.emit(SUBSCRIBE_EVENT, payload, (r: { ok: boolean; error?: string }) => {
            clearTimeout(timer);
            resolve(r);
          });
        });
        assert.equal(response.ok, false);
        assert.equal(response.error, 'invalid_request');
      }
    } finally {
      socket.close();
      await broadcast.close();
    }
  });
});

function waitForDisconnect(socket: ClientSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      resolve('already disconnected');
      return;
    }
    const timer = setTimeout(() => reject(new Error('disconnect timed out')), WAIT_MS);
    socket.once('disconnect', (reason: string) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

function nextRevoked(socket: ClientSocket): Promise<{ channels: string[] }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('revoked notice timed out')), WAIT_MS);
    socket.once('jsails:revoked', (payload: { channels: string[] }) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('broadcast abuse bounds', () => {
  it('joins the authorized subset of a batch and names only the denied channels', async () => {
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel !== 'secret',
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const response = await subscribeRaw(socket, ['open-a', 'secret', 'open-b']);
      assert.deepEqual(response, { ok: false, error: 'unauthorized', denied: ['secret'] });
      const pending = nextRawEvent(socket);
      broadcast.emit('open-b', 'ping', {});
      assert.equal((await pending).channel, 'open-b');
      broadcast.emit('secret', 'leak', {});
      await assertNoRawEvent(socket);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('answers rate_limited instead of queueing beyond maxPendingOperations', async () => {
    let authorizeCalls = 0;
    const { broadcast, port } = await startBroadcast({
      maxPendingOperations: 2,
      authorizeChannel: async () => {
        authorizeCalls += 1;
        await delay(50);
        return true;
      },
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, index) => subscribeRaw(socket, [`room-${index}`])),
      );
      const limited = responses.filter((response) => response.error === 'rate_limited');
      assert.equal(limited.length, 4);
      assert.equal(authorizeCalls, 2, 'a rejected frame must not reach authorizeChannel');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('limits the frame rate with a token bucket', async () => {
    const { broadcast, port } = await startBroadcast({
      requestBurst: 3,
      maxRequestsPerSecond: 1,
      authorizeChannel: () => true,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const responses: RawAck[] = [];
      for (let index = 0; index < 5; index += 1) {
        responses.push(await subscribeRaw(socket, [`room-${index}`]));
      }
      assert.deepEqual(
        responses.map((response) => response.ok),
        [true, true, true, false, false],
      );
      assert.equal(responses[4]?.error, 'rate_limited');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('disconnects a socket that keeps sending malformed frames', async () => {
    const { broadcast, port } = await startBroadcast({ maxRejectedRequests: 3 });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const closed = waitForDisconnect(socket);
      for (let index = 0; index < 3; index += 1) {
        socket.emit(SUBSCRIBE_EVENT, { channels: [] }, () => {});
      }
      assert.equal(await closed, 'io server disconnect');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('does not count well-formed denied subscribes as strikes', async () => {
    const { broadcast, port } = await startBroadcast({ maxRejectedRequests: 3 });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      for (let index = 0; index < 6; index += 1) {
        const response = await subscribeRaw(socket, [`room-${index}`]);
        assert.equal(response.error, 'unauthorized');
      }
      assert.equal(socket.connected, true);
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('counts strikes per window, not over the socket lifetime', async () => {
    const { broadcast, port } = await startBroadcast({
      maxRejectedRequests: 3,
      rejectedRequestWindowMs: 100,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      for (let round = 0; round < 3; round += 1) {
        for (let index = 0; index < 2; index += 1) {
          const response = await subscribeRaw(socket, []);
          assert.equal(response.error, 'invalid_request');
        }
        await delay(150);
      }
      assert.equal(socket.connected, true, 'six strikes spread over three windows');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('drops an inbound frame larger than maxFrameBytes', async () => {
    const { broadcast, port } = await startBroadcast({
      maxFrameBytes: 1024,
      authorizeChannel: () => true,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      const closed = waitForDisconnect(socket);
      socket.emit(SUBSCRIBE_EVENT, { channels: ['x'.repeat(4096)] });
      assert.equal(await closed, 'transport close');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('rejects a disallowed origin at the Engine.IO handshake', async () => {
    const { broadcast, port } = await startBroadcast();
    const upgradeStatus = (origin: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1',
          port,
          path: `${BROADCAST_PATH}/?EIO=4&transport=websocket`,
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
          resolve(101);
        });
        request.once('response', (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.once('error', reject);
        request.end();
      });
    try {
      assert.equal(await upgradeStatus(ORIGIN), 101);
      // Engine.IO answers every refused upgrade with 400; before the
      // allowRequest check this upgrade was accepted (101).
      assert.equal(await upgradeStatus('https://evil.example'), 400);
    } finally {
      await broadcast.close();
    }
  });
});

describe('broadcast revalidation', () => {
  it('revalidate() disconnects an identity that no longer authenticates', async () => {
    const sessions = new Set(['user-1']);
    const { broadcast, port } = await startBroadcast({
      authenticate: (handshake) => {
        const identity = bearerIdentity(handshake);
        return identity !== null && sessions.has(identity) ? identity : null;
      },
      authorizeChannel: () => true,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      const revoked = nextRevoked(socket);
      const closed = waitForDisconnect(socket);
      sessions.delete('user-1');
      await broadcast.revalidate();
      assert.deepEqual(await revoked, { channels: ['room-1'] });
      assert.equal(await closed, 'io server disconnect');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('revalidate() evicts only the channels whose authorization was revoked', async () => {
    const allowed = new Set(['room-1', 'room-2']);
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => allowed.has(channel),
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1', 'room-2']), { ok: true });
      const revoked = nextRevoked(socket);
      allowed.delete('room-2');
      await broadcast.revalidate();
      assert.deepEqual(await revoked, { channels: ['room-2'] });

      broadcast.emit('room-2', 'secret', {});
      await assertNoRawEvent(socket);
      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'still-works', {});
      assert.equal((await pending).event, 'still-works');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('keeps memberships when authorizeChannel throws during revalidation', async () => {
    let failing = false;
    const errors: Error[] = [];
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: () => {
        if (failing) {
          throw new Error('database unavailable: secret-connection-string');
        }
        return true;
      },
      onError: (error) => errors.push(error),
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      let revoked = false;
      socket.on('jsails:revoked', () => {
        revoked = true;
      });
      failing = true;
      await broadcast.revalidate();
      assert.equal(errors.length, 1);
      assert.doesNotMatch(errors[0]?.message ?? '', /secret-connection-string/);

      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'still-joined', {});
      assert.equal((await pending).event, 'still-joined');
      assert.equal(revoked, false, 'no jsails:revoked on a failed callback');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('keeps the socket connected when authenticate throws during revalidation', async () => {
    let failing = false;
    const errors: Error[] = [];
    const { broadcast, port } = await startBroadcast({
      authenticate: (handshake) => {
        if (failing) {
          throw new Error('session store down');
        }
        return bearerIdentity(handshake);
      },
      authorizeChannel: () => true,
      onError: (error) => errors.push(error),
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      failing = true;
      await broadcast.revalidate();
      assert.equal(errors.length, 1);
      assert.equal(socket.connected, true);
      const pending = nextRawEvent(socket);
      broadcast.emit('room-1', 'still-connected', {});
      assert.equal((await pending).event, 'still-connected');
    } finally {
      socket.close();
      await broadcast.close();
    }
  });

  it('revalidates periodically on revalidateIntervalMs', async () => {
    let allowed = true;
    const { broadcast, port } = await startBroadcast({
      revalidateIntervalMs: 50,
      authorizeChannel: () => allowed,
    });
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    try {
      assert.deepEqual(await subscribeRaw(socket, ['room-1']), { ok: true });
      const revoked = nextRevoked(socket);
      allowed = false;
      assert.deepEqual(await revoked, { channels: ['room-1'] });
    } finally {
      socket.close();
      await broadcast.close();
    }
  });
});

describe('broadcast client reconnection', () => {
  it('re-subscribes on reconnect and drops channels whose authorization was revoked', async () => {
    let allowed = true;
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => channel === 'room-1' && allowed,
    });

    let signalError: (() => void) | undefined;
    const errorObserved = new Promise<void>((resolve) => {
      signalError = resolve;
    });

    const client = connectClient(port, 'Bearer user-1', () => signalError?.());
    const received: BroadcastEvent[] = [];
    client.onEvent((event) => received.push(event));

    try {
      await client.subscribe(['room-1']);
      const first = nextClientEvent(client);
      broadcast.emit('room-1', 'before', {});
      const before = await first;
      assert.equal(before.event, 'before');

      // Revoke authorization and force a clean reconnect.
      allowed = false;
      client.disconnect();
      client.connect();

      // The automatic re-join must be denied, surfacing through onError.
      await withTimeout(errorObserved, WAIT_MS, 're-join denial');

      broadcast.emit('room-1', 'after', {});
      await delay(300);
      assert.equal(received.length, 1, 'no event should be delivered after revocation');
      assert.equal(received[0]?.event, 'before');
    } finally {
      client.disconnect();
      await broadcast.close();
    }
  });

  it('rejoins more channels than one frame allows and keeps the still-authorized ones', async () => {
    const revoked = new Set<string>();
    const { broadcast, port } = await startBroadcast({
      authorizeChannel: (_identity, channel) => !revoked.has(channel),
    });
    const errors: Error[] = [];
    const client = connectClient(port, 'Bearer user-1', (error) => errors.push(error));
    // Two rejoin frames: rooms 0-49, then 50-59. The client sends them one
    // after the other and reports a denial when its frame is answered, so the
    // revoked channel sits in the last frame: once its denial arrives, every
    // frame has been answered and both frames' channels must be live again.
    const channels = Array.from({ length: 60 }, (_, index) => `room-${index}`);
    try {
      await client.subscribe(channels);
      revoked.add('room-55');
      client.disconnect();
      client.connect();
      await withTimeout(
        (async () => {
          while (!errors.some((error) => error.message === 'unauthorized')) {
            await delay(20);
          }
        })(),
        WAIT_MS,
        'rejoin denial',
      );
      for (const channel of ['room-3', 'room-59']) {
        const pending = nextClientEvent(client);
        broadcast.emit(channel, 'after-rejoin', {});
        assert.equal((await pending).channel, channel);
      }
    } finally {
      client.disconnect();
      await broadcast.close();
    }
  });
});

describe('broadcast validation and lifecycle', () => {
  it('validates channel, event, and payload bounds', async () => {
    const { broadcast } = await startBroadcast({ authorizeChannel: () => true });
    try {
      assert.throws(() => broadcast.emit('', 'e', {}), TypeError);
      assert.throws(() => broadcast.emit('c', '', {}), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', (() => {}) as unknown as never), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', 1n as unknown as never), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', NaN), TypeError);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      assert.throws(() => broadcast.emit('c', 'e', circular as unknown as never), TypeError);
      assert.throws(() => broadcast.emit('c', 'e', { data: 'x'.repeat(2_000_000) }), RangeError);
    } finally {
      await broadcast.close();
    }
  });

  it('close() shuts down the attached HTTP server (verified Socket.IO behavior)', async () => {
    const { broadcast, httpServer } = await startBroadcast({ authorizeChannel: () => true });
    assert.equal(httpServer.listening, true);
    await broadcast.close();
    assert.equal(httpServer.listening, false);
    // Idempotent.
    await broadcast.close();
  });

  it('drain() disconnects every client and leaves the HTTP server, and a request it holds, to its owner', async () => {
    const { broadcast, httpServer, port } = await startBroadcast();
    // Nothing answers this request: it holds its connection open, as a slow
    // handler of the application sharing the server would.
    const connected = new Promise((resolve) => httpServer.once('connection', resolve));
    const hung = httpRequest({ host: '127.0.0.1', port, path: '/hung', agent: false });
    hung.on('error', () => {
      // Destroyed below on purpose.
    });
    hung.end();
    await connected;
    const socket = await connectRaw(port, ORIGIN, 'Bearer user-1');
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    try {
      await withTimeout(broadcast.drain(), WAIT_MS, 'drain with an HTTP request in flight');
      // A transport close, not a server disconnect: the client reconnects.
      assert.equal(await disconnected, 'transport close');
      assert.equal(httpServer.listening, true, 'the drain leaves the server to its owner');
      assert.equal(broadcast.drain(), broadcast.drain(), 'drain is memoized');
    } finally {
      hung.destroy();
      socket.close();
      await broadcast.close();
    }
    assert.equal(httpServer.listening, false, 'close still closes the server');
  });

  it('close() resolves concurrently for all callers', async () => {
    const { broadcast, httpServer } = await startBroadcast({ authorizeChannel: () => true });
    assert.equal(httpServer.listening, true);
    // Every caller must await the same shutdown rather than resolve early.
    await Promise.all([broadcast.close(), broadcast.close(), broadcast.close()]);
    assert.equal(httpServer.listening, false);
  });
});

/** A real provider; port 1 is privileged and refuses every connection. */
function unreachableConnections(): ValkeyConnections {
  return createValkeyConnections('redis://:topsecret@127.0.0.1:1', {
    appPrefix: 'test-app:test',
    name: 'test',
    timeouts: { connectMs: 1000 },
  });
}

describe('broadcast valkey adapter', () => {
  it('fails safely before returning when Valkey is unreachable', async () => {
    const connections = unreachableConnections();
    try {
      await assert.rejects(
        withTimeout(createValkeyPubSub(connections), WAIT_MS, 'valkey adapter init'),
        (error: Error) => {
          assert.match(error.message, /failed to connect to the Valkey broadcast adapter/);
          assert.doesNotMatch(String(error.cause), /topsecret/);
          return true;
        },
      );
    } finally {
      await connections.close();
    }
  });

  it('leaves the HTTP server untouched when Valkey adapter init fails', async () => {
    const httpServer = createServer();
    const connections = unreachableConnections();
    try {
      await assert.rejects(
        attachBroadcast(httpServer, {
          allowedOrigins: [ORIGIN],
          authenticate: (handshake) => bearerIdentity(handshake),
          valkey: connections,
        }),
        /failed to connect to the Valkey broadcast adapter/,
      );
    } finally {
      await connections.close();
    }
    // The adapter initializes before anything is attached, so the HTTP server
    // must still be usable (and not closed) after the failure.
    assert.equal(httpServer.listening, false);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address() as AddressInfo;
        assert.ok(address.port > 0);
        httpServer.close(() => resolve());
      });
    });
  });

  it('rejects a valkey option that is not a provider', async () => {
    await assert.rejects(
      attachBroadcast(createServer(), {
        allowedOrigins: [ORIGIN],
        authenticate: (handshake) => bearerIdentity(handshake),
        valkey: 'redis://127.0.0.1:6379' as unknown as ValkeyConnections,
      }),
      /valkey must be the app Valkey connections/,
    );
  });
});

// --- Mocked Valkey adapter lifecycle (no live Valkey) ------------------------

let publishError: Error | undefined;
const createdClients: FakeRedisClient[] = [];

/** The provider's test seam: a client that connects at once and records its options. */
class FakeRedisClient {
  readonly options: Record<string, unknown>;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  disconnects = 0;

  constructor(_url: string, options: object) {
    this.options = { ...options };
    createdClients.push(this);
  }

  publish(_channel: string, _message: string): Promise<number> {
    return publishError === undefined ? Promise.resolve(1) : Promise.reject(publishError);
  }

  connect(): Promise<void> {
    this.emit('ready');
    return Promise.resolve();
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function fakeProvider(options: Partial<ValkeyConnectionsOptions> = {}): ValkeyConnections {
  return createValkeyConnections('redis://:topsecret@host:6379', {
    appPrefix: 'test-app:test',
    name: 'test',
    dependencies: { RedisClient: FakeRedisClient },
    ...options,
  });
}

function capturingAdapter(): ValkeyPubSubDependencies & {
  pub: { publish(channel: string, message: string): Promise<number> } | undefined;
  sub: unknown;
} {
  const captured: ValkeyPubSubDependencies & {
    pub: { publish(channel: string, message: string): Promise<number> } | undefined;
    sub: unknown;
  } = {
    pub: undefined,
    sub: undefined,
    createAdapter: (pub: unknown, sub: unknown) => {
      captured.pub = pub as typeof captured.pub;
      captured.sub = sub;
      return () => ({}) as Adapter;
    },
  };
  return captured;
}

function credentialError(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

describe('broadcast valkey adapter lifecycle (mocked)', () => {
  beforeEach(() => {
    publishError = undefined;
    createdClients.length = 0;
  });

  it('publishes on the shared command connection and subscribes on the subscriber one', async () => {
    const connections = fakeProvider();
    const captured = capturingAdapter();
    const pubsub = await createValkeyPubSub(connections, {}, captured);
    assert.equal(createdClients.length, 2);
    const command = createdClients.find(
      (client) => client.options.connectionName === 'test:command',
    );
    const subscriber = createdClients.find(
      (client) => client.options.connectionName === 'test:subscriber',
    );
    assert.equal(command?.options.enableOfflineQueue, false, 'publishes are never queued offline');
    assert.equal(subscriber?.options.enableOfflineQueue, true, 'the subscriber resubscribes');
    assert.equal(captured.sub, subscriber);

    pubsub.release();
    assert.equal(command?.disconnects, 0, 'the shared clients stay open');
    await connections.close();
  });

  it('fails publishes fast while disconnected and reports one failure per outage', async () => {
    const observed: Error[] = [];
    const connections = fakeProvider();
    const captured = capturingAdapter();
    const pubsub = await createValkeyPubSub(
      connections,
      { onError: (error) => observed.push(error) },
      captured,
    );
    publishError = credentialError(
      "Stream isn't writeable and enableOfflineQueue options is false redis://:topsecret@host",
      'ERR_OFFLINE',
    );
    // The Socket.IO adapter never awaits a publish: the guarded client must
    // settle it instead of leaving an unhandled rejection.
    assert.equal(await captured.pub?.publish('channel', 'a'), 0);
    assert.equal(await captured.pub?.publish('channel', 'b'), 0);
    assert.equal(observed.length, 1);
    assert.match(observed[0]!.message, /Valkey broadcast adapter error/);
    assert.doesNotMatch(observed[0]!.message, /topsecret/);

    // The next `ready` ends the outage and re-arms the report.
    const command = createdClients.find(
      (client) => client.options.connectionName === 'test:command',
    );
    command?.emit('ready');
    assert.equal(await captured.pub?.publish('channel', 'c'), 0);
    assert.equal(observed.length, 2);

    const readyListeners = command?.listenerCount('ready') ?? 0;
    pubsub.release();
    assert.equal(command?.listenerCount('ready'), readyListeners - 1, 'release drops the guard');
    await connections.close();
  });

  it('swallows a throwing onError observer without crashing', async () => {
    const connections = fakeProvider();
    const captured = capturingAdapter();
    const pubsub = await createValkeyPubSub(
      connections,
      {
        onError: () => {
          throw new Error('observer boom');
        },
      },
      captured,
    );
    publishError = new Error('redis down');
    assert.equal(await captured.pub?.publish('channel', 'a'), 0);
    pubsub.release();
    await connections.close();
  });

  it('falls back to process.emitWarning when no onError is provided', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    const connections = fakeProvider();
    try {
      const captured = capturingAdapter();
      const pubsub = await createValkeyPubSub(connections, {}, captured);
      publishError = new Error('redis down');
      assert.equal(await captured.pub?.publish('channel', 'a'), 0);
      // process.emitWarning delivers the 'warning' event on a later tick.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!.message, /Valkey broadcast adapter error/);
      pubsub.release();
    } finally {
      process.off('warning', onWarning);
      await connections.close();
    }
  });
});
