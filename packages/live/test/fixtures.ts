/**
 * Shared fixtures for the live tests: a throwaway `Item` entity over an
 * isolated on-disk sql.js data source, a message collector, and a full live
 * stack (data source → service → Socket.IO transport on a loopback server)
 * that the transport, hook, and plugin tests mount.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { z } from 'zod';

import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource, query } from 'jsails/database';
import { createPublicationRegistry, definePublication, type LiveServerMessage } from 'jsails/live';
import { createEmptyDataSource, waitFor } from 'jsails/testing';

import { createInMemoryChangeLog } from '../src/in-memory-change-log.js';
import { createLiveService, type LiveService } from '../src/live-service.js';
import {
  attachLiveSocket,
  type LiveSocketHandle,
  type LiveSocketOptions,
} from '../src/socket-transport.js';
import { LIVE_EVENTS, LIVE_PATH } from '../src/wire.js';

/** The origin every test client presents and the transport allows. */
export const ORIGIN = 'https://app.example';
/** The budget for any wait in these tests. */
export const WAIT_MS = 3000;

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-live-'));
let locationSeq = 0;

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * The shape of the entity the publications under test project. Declared
 * ambiently so {@link defineItemEntity} can name its return type: the class it
 * builds is anonymous, and an exported anonymous class type cannot carry
 * `BaseEntity`'s private statics through declaration emit.
 */
/** Every scalar column of the item entity, as a publication `fields` allowlist. */
export const ITEM_FIELDS = ['id', 'name', 'status', 'ownerId'] as const;

export declare class ItemRecord extends BaseEntity {
  id: number;
  name: string;
  status: string;
  ownerId: string | null;
}

/** The entity class the publications under test project. */
export type ItemEntity = typeof ItemRecord;

/**
 * Define a fresh `Item` entity class. Each test file passes its own table name
 * so TypeORM's global metadata never sees two classes for one table.
 */
export function defineItemEntity(table: string): ItemEntity {
  @Entity(table)
  class Item extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;

    @Column({ type: 'varchar', length: 20, nullable: false, default: 'draft' })
    status!: string;

    @Column({ type: 'varchar', length: 40, nullable: true })
    ownerId!: string | null;
  }
  return Item;
}

/** An isolated, ready data source over `Item`, at a unique on-disk location. */
export async function createItemDataSource(Item: ItemEntity): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${locationSeq++}.sqlite`);
  return createEmptyDataSource([Item], { location });
}

/** Collect messages from a subscription sink. */
export function collectMessages() {
  const messages: LiveServerMessage[] = [];
  return { messages, sink: (message: LiveServerMessage) => messages.push(message) };
}

/** Await the first collected message satisfying `predicate`, or fail after the budget. */
export async function messageMatching(
  messages: readonly LiveServerMessage[],
  predicate: (message: LiveServerMessage) => boolean,
): Promise<LiveServerMessage> {
  await waitFor(() => messages.some(predicate), { timeoutMs: WAIT_MS, label: 'live message' });
  const found = messages.find(predicate);
  if (found === undefined) {
    throw new Error('the awaited live message disappeared');
  }
  return found;
}

/** A mounted live stack. */
export interface RunningLive {
  readonly socketHandle: LiveSocketHandle;
  readonly service: LiveService;
  readonly dataSource: JsailsDataSource;
  readonly httpServer: HttpServer;
  readonly port: number;
  readonly url: string;
  readonly Item: ItemEntity;
}

/** Options for {@link startLive}. */
export interface StartLiveOptions {
  /** The `Item` table name; distinct per test file. */
  readonly table: string;
  /** Transport options layered over the allowlisted test origin. */
  readonly socket?: Partial<LiveSocketOptions>;
  /** Wrap the service the transport sees, to gate or observe its calls. */
  readonly wrapService?: (service: LiveService) => LiveService;
}

/**
 * Start a full live stack: a sql.js data source wired to a live service that
 * publishes `live.items`, mounted behind a loopback HTTP server with the
 * Socket.IO transport attached.
 */
export async function startLive(options: StartLiveOptions): Promise<RunningLive> {
  const Item = defineItemEntity(options.table);
  const dataSource = await createItemDataSource(Item);
  const publication = definePublication({
    name: 'live.items',
    collection: 'items',
    fields: ITEM_FIELDS,
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
  const service = options.wrapService?.(baseService) ?? baseService;

  const httpServer = createServer();
  const socketHandle = attachLiveSocket(httpServer, service, {
    allowedOrigins: [ORIGIN],
    ...options.socket,
  });
  const port = await listen(httpServer);
  return {
    socketHandle,
    service,
    dataSource,
    httpServer,
    port,
    url: `http://127.0.0.1:${port}`,
    Item,
  };
}

/** Tear down everything {@link startLive} opened. */
export async function stopLive(running: RunningLive): Promise<void> {
  await running.socketHandle.close();
  await running.service.stop();
  await running.dataSource.destroy();
  await new Promise<void>((resolve) => running.httpServer.close(() => resolve()));
}

/** Listen on an ephemeral loopback port and return it. */
export async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as { port: number }).port;
}

/**
 * A connected client plus a buffering message collector. Messages are queued from
 * connection time so a snapshot emitted before a subscribe ack (the server emits
 * the snapshot while the subscribe handler runs, ahead of the ack) is not missed.
 */
export interface ClientHarness {
  socket: ClientSocket;
  messages: LiveServerMessage[];
  /** Await the next buffered/incoming message matching `predicate`. */
  next(predicate?: (message: LiveServerMessage) => boolean): Promise<LiveServerMessage>;
}

export async function openClient(port: number): Promise<ClientHarness> {
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

  socket.on(LIVE_EVENTS.message, (message: LiveServerMessage) => {
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

export function subscribe(
  socket: ClientSocket,
  publication: string,
  params: unknown = {},
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), WAIT_MS);
    socket.emit(
      LIVE_EVENTS.subscribe,
      { publication, params },
      (response: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        resolve(response);
      },
    );
  });
}
