/**
 * Tests for the `useLive` browser hook (`@jsails/live/client`).
 *
 * The hook is the only place the browser talks to the live layer, so its
 * contract is exercised end to end against a real in-process Socket.IO server
 * (the Phase 6 harness): connect, subscribe, apply a snapshot, apply a change,
 * and report `refreshed` when the server could not resume.
 *
 * `useLive` reads `window.location` only through `socket.io-client`'s default
 * URL, so every case passes an explicit `url` and runs under plain Node.
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
import { io, type Socket } from 'socket.io-client';

import { JsailsDataSource, query } from 'jsails/database';
import { createEmptyDataSource, waitFor } from 'jsails/testing';
import {
  createInMemoryChangeLog,
  createLiveService,
  createPublicationRegistry,
  definePublication,
  type LiveService,
} from 'jsails/live';

import { attachLiveSocket, LIVE_PATH, type LiveSocketHandle } from '../src/socket-adapter.js';
import { useLive, type UseLiveResult } from '../src/client/use-live.js';

const ORIGIN = 'https://app.example';
const WAIT_MS = 3000;

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-live-hook-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeItem() {
  @Entity('live_items_hook')
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
  const location = join(tmpRoot, `hook-db-${locationSeq++}.sqlite`);
  return createEmptyDataSource([Item], { location });
}

interface RunningLive {
  socketHandle: LiveSocketHandle;
  service: LiveService;
  dataSource: JsailsDataSource;
  httpServer: HttpServer;
  url: string;
  Item: ReturnType<typeof makeItem>;
}

async function startLive(): Promise<RunningLive> {
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
  const service = createLiveService({
    registry,
    changeLog: createInMemoryChangeLog(),
    flushIntervalMs: 5,
  });
  await service.start();
  dataSource.liveCapture.setListener((changes) => service.ingest(changes));

  const httpServer = createServer();
  const socketHandle = attachLiveSocket(httpServer, service, { allowedOrigins: [ORIGIN] });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (httpServer.address() as { port: number }).port;
  return { socketHandle, service, dataSource, httpServer, url: `http://127.0.0.1:${port}`, Item };
}

async function stopLive(running: RunningLive): Promise<void> {
  await running.socketHandle.close();
  await running.service.stop();
  await running.dataSource.destroy();
  await new Promise<void>((resolve) => running.httpServer.close(() => resolve()));
}

/** Poll until `predicate` holds, or fail after the wait budget. */
const WAIT_FOR = { timeoutMs: WAIT_MS, intervalMs: 10 };

/**
 * A controllable stand-in for a `socket.io-client` socket.
 *
 * The hook only uses `on`, `emit`, `disconnect`, `connect`, and
 * `removeAllListeners`, so the fake records listeners and lets a test drive
 * `connect` and server messages directly. This is how the reconnect decision is
 * tested without a real transport drop, which `socket.io-client` does not
 * expose to the server side.
 */
class FakeSocket {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly emitted: Array<{ event: string; args: unknown[] }> = [];
  disconnected = false;

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing === undefined) {
      this.listeners.set(event, [listener]);
    } else {
      existing.push(listener);
    }
    return this;
  }

  emit(event: string, ...args: unknown[]): this {
    this.emitted.push({ event, args });
    return this;
  }

  disconnect(): this {
    this.disconnected = true;
    return this;
  }

  connect(): this {
    this.disconnected = false;
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  /** Fire the `connect` event, as a real socket does after a handshake. */
  emitConnect(): void {
    for (const listener of this.listeners.get('connect') ?? []) {
      listener();
    }
  }

  /** Fire a server message on the live message event. */
  emitMessage(message: unknown): void {
    for (const listener of this.listeners.get('jsails:live:message') ?? []) {
      listener(message);
    }
  }
}

function openHook(running: RunningLive): UseLiveResult {
  return useLive({
    publication: 'live.items',
    collection: 'items',
    url: running.url,
    path: LIVE_PATH,
    // A Node client sends no Origin; the adapter's allowlist requires one.
    extraHeaders: { Origin: ORIGIN },
    // These cases run under plain Node, where the hook is inert by default.
    // An explicit factory is the documented opt-out for a non-browser caller.
    createSocket: (url, options) => io(url, options),
  });
}

describe('useLive', () => {
  it('rejects a missing publication or collection', () => {
    assert.throws(() => useLive({ publication: '', collection: 'items' }), TypeError);
    assert.throws(() => useLive({ publication: 'live.items', collection: '' }), TypeError);
  });

  it('applies the snapshot and reports live', async () => {
    const running = await startLive();
    const hook = openHook(running);
    try {
      await running.Item.create({ name: 'alice', status: 'published' }).save();

      await waitFor(() => hook.status.value === 'live', { ...WAIT_FOR, label: 'status live' });
      await waitFor(() => hook.rows.value.length === 1, { ...WAIT_FOR, label: 'snapshot row' });

      assert.equal(hook.rows.value[0]?.['name'], 'alice');
      assert.equal(hook.error.value, null);
    } finally {
      hook.dispose();
      await stopLive(running);
    }
  });

  it('applies a committed change to the rows signal', async () => {
    const running = await startLive();
    const hook = openHook(running);
    try {
      await waitFor(() => hook.status.value === 'live', { ...WAIT_FOR, label: 'status live' });
      assert.equal(hook.rows.value.length, 0);

      const item = await running.Item.create({ name: 'bob', status: 'published' }).save();
      await waitFor(() => hook.rows.value.length === 1, { ...WAIT_FOR, label: 'inserted row' });
      assert.equal(hook.rows.value[0]?.['id'], item.id);

      item.name = 'bobby';
      await item.save();
      await waitFor(() => hook.rows.value[0]?.['name'] === 'bobby', {
        ...WAIT_FOR,
        label: 'updated row',
      });

      await item.remove();
      await waitFor(() => hook.rows.value.length === 0, { ...WAIT_FOR, label: 'deleted row' });
    } finally {
      hook.dispose();
      await stopLive(running);
    }
  });

  it('reports refreshed when a reconnect falls back to a snapshot', () => {
    // The service always sends `resumed: false` on a snapshot — a successful
    // resume emits replayed changes and no snapshot at all — so the hook cannot
    // read the flag. It reports `refreshed` when a snapshot arrives after this
    // client already had a sequence, which is exactly the lost-continuity case
    // (LIVE-PLAN.md §8). A controllable socket drives that sequence directly.
    const socket = new FakeSocket();
    const hook = useLive({
      publication: 'live.items',
      collection: 'items',
      createSocket: () => socket as unknown as Socket,
    });
    try {
      socket.emitConnect();
      socket.emitMessage({
        type: 'snapshot',
        subscriptionId: '1',
        sequence: 5,
        rows: [],
        resumed: false,
      });
      assert.equal(hook.status.value, 'live');

      // Reconnect: the server could not replay the suffix, so it snapshots again.
      socket.emitConnect();
      socket.emitMessage({
        type: 'snapshot',
        subscriptionId: '2',
        sequence: 9,
        rows: [],
        resumed: false,
      });
      assert.equal(hook.status.value, 'refreshed');
    } finally {
      hook.dispose();
    }
  });

  it('resumes without a snapshot and stays live', () => {
    // A successful resume replays changes and sends no snapshot, so the status
    // must not regress to `refreshed`.
    const socket = new FakeSocket();
    const hook = useLive({
      publication: 'live.items',
      collection: 'items',
      createSocket: () => socket as unknown as Socket,
    });
    try {
      socket.emitConnect();
      socket.emitMessage({
        type: 'snapshot',
        subscriptionId: '1',
        sequence: 5,
        rows: [],
        resumed: false,
      });
      assert.equal(hook.status.value, 'live');

      socket.emitConnect();
      socket.emitMessage({
        type: 'change',
        subscriptionId: '2',
        sequence: 6,
        collection: 'items',
        id: '1',
        row: { id: 1, name: 'replayed' },
      });
      assert.equal(hook.status.value, 'live');
      assert.equal(hook.rows.value.length, 1);
    } finally {
      hook.dispose();
    }
  });

  it('ignores a change at or below the applied sequence', () => {
    const socket = new FakeSocket();
    const hook = useLive({
      publication: 'live.items',
      collection: 'items',
      createSocket: () => socket as unknown as Socket,
    });
    try {
      socket.emitConnect();
      socket.emitMessage({
        type: 'snapshot',
        subscriptionId: '1',
        sequence: 5,
        rows: [],
        resumed: false,
      });
      socket.emitMessage({
        type: 'change',
        subscriptionId: '1',
        sequence: 5,
        collection: 'items',
        id: '1',
        row: { id: 1, name: 'stale' },
      });

      assert.equal(hook.rows.value.length, 0);
    } finally {
      hook.dispose();
    }
  });

  it('surfaces an error message as status and code', () => {
    const socket = new FakeSocket();
    const hook = useLive({
      publication: 'live.items',
      collection: 'items',
      createSocket: () => socket as unknown as Socket,
    });
    try {
      socket.emitConnect();
      socket.emitMessage({ type: 'error', subscriptionId: '1', code: 'unauthorized' });

      assert.equal(hook.status.value, 'error');
      assert.equal(hook.error.value, 'unauthorized');
    } finally {
      hook.dispose();
    }
  });

  it('drops a malformed message instead of applying it', () => {
    const socket = new FakeSocket();
    const hook = useLive({
      publication: 'live.items',
      collection: 'items',
      createSocket: () => socket as unknown as Socket,
    });
    try {
      socket.emitConnect();
      socket.emitMessage({ type: 'change', subscriptionId: '1' });

      assert.equal(hook.rows.value.length, 0);
      assert.equal(hook.status.value, 'connecting');
    } finally {
      hook.dispose();
    }
  });

  it('opens no socket outside a browser', () => {
    // A static export imports the island module to render its markup, so the
    // hook body runs on the server. The default factory must not be reached:
    // `socket.io-client` would connect to nothing, fail, and reschedule a
    // reconnect timer that keeps the build process alive forever.
    assert.equal(typeof window, 'undefined', 'this test must run without a browser');

    const hook = useLive({ publication: 'live.items', collection: 'items' });
    try {
      assert.equal(hook.status.value, 'connecting');
      assert.equal(hook.error.value, null);
      assert.deepEqual(hook.rows.value, []);
      // Nothing was opened, so dispose has nothing to release and must not throw.
      hook.dispose();
      hook.dispose();
      assert.deepEqual(hook.rows.value, []);
    } finally {
      hook.dispose();
    }
  });

  it('dispose is idempotent and clears the rows', async () => {
    const running = await startLive();
    const hook = openHook(running);
    try {
      await running.Item.create({ name: 'carol', status: 'published' }).save();
      await waitFor(() => hook.rows.value.length === 1, { ...WAIT_FOR, label: 'snapshot row' });

      hook.dispose();
      hook.dispose();

      assert.equal(hook.rows.value.length, 0);
    } finally {
      await stopLive(running);
    }
  });
});
