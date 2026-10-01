/**
 * Tests for the Socket.IO live transport adapter (`@jsails/live`).
 *
 * Each case mounts a real Socket.IO server onto a loopback `node:http.Server`
 * via {@link attachLiveSocket} and connects an in-process Socket.IO client — no
 * network beyond loopback, no external service (LIVE-PLAN.md Phase 6). The
 * adapter's security posture is exercised end to end:
 *
 * - a subscribe receives a snapshot translated onto the client-visible id;
 * - a committed write produces a change on the socket;
 * - a disconnect closes every open subscription;
 * - exceeding `maxSubscriptions` is rejected;
 * - oversized params are rejected against the 8 KB cap.
 *
 * Publication queries are backed by a real on-disk sql.js data source and the
 * transport-agnostic {@link createLiveService}, matching the Phase 5 tests.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';

import { JsailsDataSource, query } from 'jsails/database';
import { createEmptyDataSource } from 'jsails/testing';
import {
  createInMemoryChangeLog,
  createLiveService,
  createPublicationRegistry,
  definePublication,
  type LiveServerMessage,
  type LiveService,
} from 'jsails/live';

import {
  attachLiveSocket,
  LIVE_PATH,
  type LiveSocketHandle,
  type LiveSocketOptions,
} from '../src/socket-adapter.js';

const ORIGIN = 'https://app.example';
/** Client -> server subscribe event name (repeated here; not exported from the adapter). */
const SUBSCRIBE_EVENT = 'jsails:live:subscribe';
/** Server -> client message event name. */
const MESSAGE_EVENT = 'jsails:live:message';
const WAIT_MS = 3000;

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-live-socket-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeItem() {
  @Entity('live_items_socket')
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'varchar', length: 20, nullable: false, default: 'draft' })
    status!: string;
  }
  return Item;
}

let locationSeq = 0;

async function createDataSource(Item: ReturnType<typeof makeItem>): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `socket-db-${locationSeq++}.sqlite`);
  return createEmptyDataSource([Item], { location });
}

interface RunningLive {
  socketHandle: LiveSocketHandle;
  service: LiveService;
  dataSource: JsailsDataSource;
  httpServer: HttpServer;
  port: number;
  Item: ReturnType<typeof makeItem>;
}

/**
 * Start a full live stack: sql.js data source wired to a live service, mounted
 * behind a loopback HTTP server with the Socket.IO adapter attached.
 */
async function startLive(
  overrides: Partial<LiveSocketOptions> = {},
  wrapService?: (service: LiveService) => LiveService,
): Promise<RunningLive> {
  const Item = makeItem();
  const dataSource = await createDataSource(Item);
  const publication = definePublication({
    name: 'live.items',
    collection: 'items',
    params: z.object({}).strict(),
    authorize: () => true,
    query: () => query(Item).orderBy('id', 'ASC'),
  });
  const registry = createPublicationRegistry();
  registry.register(publication);
  const baseService = createLiveService({
    registry,
    changeLog: createInMemoryChangeLog(),
    flushIntervalMs: 5,
  });
  await baseService.start();
  dataSource.liveCapture.setListener((changes) => baseService.ingest(changes));
  const service = wrapService?.(baseService) ?? baseService;

  const httpServer = createServer();
  const socketHandle = attachLiveSocket(httpServer, service, {
    allowedOrigins: [ORIGIN],
    ...overrides,
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (httpServer.address() as { port: number }).port;
  return { socketHandle, service, dataSource, httpServer, port, Item };
}

async function stopLive(running: RunningLive): Promise<void> {
  await running.socketHandle.close();
  await running.service.stop();
  await running.dataSource.destroy();
  await new Promise<void>((resolve) => running.httpServer.close(() => resolve()));
}

/**
 * A connected client plus a buffering message collector. Messages are queued from
 * connection time so a snapshot emitted before a subscribe ack (the server emits
 * the snapshot while the subscribe handler runs, ahead of the ack) is not missed.
 */
interface ClientHarness {
  socket: ClientSocket;
  messages: LiveServerMessage[];
  /** Await the next buffered/incoming message matching `predicate`. */
  next(predicate?: (message: LiveServerMessage) => boolean): Promise<LiveServerMessage>;
}

async function openClient(port: number): Promise<ClientHarness> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: LIVE_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
    extraHeaders: { Origin: ORIGIN },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), WAIT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const messages: LiveServerMessage[] = [];
  const waiters: Array<{
    predicate: (message: LiveServerMessage) => boolean;
    resolve: (message: LiveServerMessage) => void;
    timer: NodeJS.Timeout;
  }> = [];

  socket.on(MESSAGE_EVENT, (message: LiveServerMessage) => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter !== undefined && waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    socket,
    messages,
    next(predicate = () => true) {
      const already = messages.find(predicate);
      if (already !== undefined) {
        return Promise.resolve(already);
      }
      return new Promise<LiveServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('message timed out'));
        }, WAIT_MS);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}

function subscribe(
  socket: ClientSocket,
  publication: string,
  params: unknown = {},
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), WAIT_MS);
    socket.emit(
      SUBSCRIBE_EVENT,
      { publication, params },
      (response: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(response);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
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

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition timed out');
    }
    await sleep(10);
  }
}

describe('Socket.IO live adapter', () => {
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
      await sleep(100);

      // A write committed after the disconnect must not surface a delivery
      // error through the adapter (each slot was closed by the disconnect).
      await running.Item.create({ name: 'after-disconnect', status: 'published' }).save();
      await sleep(100);
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
      assert.equal(third.error, 'too-many-subscriptions');

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
      assert.equal(ack.error, 'params-too-large');

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
      assert.equal(secondAck.error, 'too-many-subscriptions');

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
      client.socket.emit(SUBSCRIBE_EVENT, { publication: 'live.items', params: {} });
      await entered.promise;

      client.socket.close();
      await sleep(100);
      gate.resolve();

      await waitFor(() => closed.length === 1);
      assert.equal(closed.length, 1);
    } finally {
      gate.resolve();
      await stopLive(running);
    }
  });
});
