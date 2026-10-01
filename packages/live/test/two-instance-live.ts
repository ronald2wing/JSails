/**
 * Two application instances of the `live` plugin behind one database and one
 * Valkey, for the cross-instance delivery tests (fan-out, resume, revocation)
 * that a single process cannot exercise.
 *
 * Each instance is assembled exactly as an application would assemble it: its
 * own `livePlugin` through `runExtensions`, its serve hooks run against its own
 * loopback HTTP server, and the shared backend reached through the in-memory
 * fake Valkey (stream log plus pub/sub bus), so every change travels the real
 * append, notify, tail, and fan-out path between the two.
 *
 * The database is one sql.js data source shared by both instances, which is
 * what a shared database looks like to each of them. A data source has one
 * change-capture listener, though, so each instance is handed a view of it
 * whose `liveCapture` registers per instance, and a committed write is
 * captured by the instance chosen with {@link TwoInstanceLive.writeThrough}:
 * the instance whose process "made" the write.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { z } from 'zod';

import { databaseToken, query, type JsailsDataSource } from 'jsails/database';
import { definePlugin, runExtensions } from 'jsails/extensions';
import {
  createPublicationRegistry,
  definePublication,
  type LiveChangeListener,
  type PublicationRegistry,
} from 'jsails/live';
import type { ResolvedAppConfig } from 'jsails/testing';

import { livePlugin, type LivePluginOptions } from '../src/plugin.js';
import { createFakeValkey, fakeValkeyPlugin, type FakeValkey } from './fake-valkey.js';
import {
  createItemDataSource,
  defineItemEntity,
  ITEM_FIELDS,
  listen,
  ORIGIN,
  type ItemEntity,
} from './fixtures.js';

/** The two instances' names. */
export type InstanceName = 'a' | 'b';

/** One served instance. */
export interface LiveInstance {
  readonly name: InstanceName;
  readonly port: number;
  readonly url: string;
}

/** Options for {@link startTwoInstanceLive}. */
export interface TwoInstanceLiveOptions {
  /** The `Item` table name; distinct per test file. */
  readonly table: string;
  /**
   * Register the publications under test. Defaults to `live.items`, every
   * item ordered by id, open to anyone.
   */
  readonly publications?: (registry: PublicationRegistry, Item: ItemEntity) => void;
  /** Plugin options layered over the shared backend and test origin, per instance. */
  readonly plugin?: (name: InstanceName) => Partial<LivePluginOptions>;
}

/** The running pair. */
export interface TwoInstanceLive {
  readonly Item: ItemEntity;
  readonly dataSource: JsailsDataSource;
  /** The shared fake Valkey both instances read and write. */
  readonly valkey: FakeValkey;
  readonly prefix: string;
  readonly a: LiveInstance;
  readonly b: LiveInstance;
  /** Route the next committed writes' capture to `name` (initially `a`). */
  writeThrough(name: InstanceName): void;
  close(): Promise<void>;
}

const PREFIX = 'test:live:pair';

function defaultPublications(registry: PublicationRegistry, Item: ItemEntity): void {
  registry.register(
    definePublication({
      name: 'live.items',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: () => true,
      query: () => query(Item).orderBy('id', 'ASC'),
    }),
  );
}

/**
 * The shared data source as one instance sees it: everything forwards to the
 * real data source except `liveCapture.setListener`, which registers this
 * instance's listener instead of replacing the other instance's.
 */
function instanceView(
  dataSource: JsailsDataSource,
  register: (listener: LiveChangeListener | undefined) => void,
): JsailsDataSource {
  const capture = dataSource.liveCapture;
  const liveCapture: typeof capture = {
    subscriber: capture.subscriber,
    setListener: register,
    close: () => register(undefined),
  };
  return new Proxy(dataSource, {
    get(target, property) {
      if (property === 'liveCapture') {
        return liveCapture;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Start both instances over one fresh data source and one fake Valkey. */
export async function startTwoInstanceLive(
  options: TwoInstanceLiveOptions,
): Promise<TwoInstanceLive> {
  const Item = defineItemEntity(options.table);
  const dataSource = await createItemDataSource(Item);
  const valkey = createFakeValkey();
  const listeners = new Map<InstanceName, LiveChangeListener>();
  let writer: InstanceName = 'a';
  dataSource.liveCapture.setListener((changes) => listeners.get(writer)?.(changes));

  const opened: { close(): Promise<void> }[] = [];
  async function serveInstance(name: InstanceName): Promise<LiveInstance> {
    const registry = createPublicationRegistry();
    (options.publications ?? defaultPublications)(registry, Item);
    const view = instanceView(dataSource, (listener) => {
      if (listener === undefined) {
        listeners.delete(name);
      } else {
        listeners.set(name, listener);
      }
    });
    const runtime = await runExtensions(
      [
        definePlugin({
          name: 'shared-database',
          setup({ services }) {
            services.provide(databaseToken, view);
          },
        }),
        fakeValkeyPlugin(valkey),
        livePlugin({
          registry,
          allowedOrigins: [ORIGIN],
          prefix: PREFIX,
          ...options.plugin?.(name),
        }),
      ],
      { rootDir: import.meta.dirname },
    );
    const httpServer: HttpServer = createServer();
    opened.push({
      async close() {
        await runtime.close();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
    });
    const port = await listen(httpServer);
    // The live plugin reads only `services` from the serve context.
    const context = { config: {} as ResolvedAppConfig, services: runtime.services };
    for (const { hook } of runtime.serveHooks) {
      await hook(httpServer, context);
    }
    return { name, port, url: `http://127.0.0.1:${port}` };
  }

  try {
    const a = await serveInstance('a');
    const b = await serveInstance('b');
    return {
      Item,
      dataSource,
      valkey,
      prefix: PREFIX,
      a,
      b,
      writeThrough(name) {
        writer = name;
      },
      async close() {
        for (const instance of opened.reverse()) {
          await instance.close();
        }
        await dataSource.destroy();
      },
    };
  } catch (error) {
    for (const instance of opened.reverse()) {
      await instance.close();
    }
    await dataSource.destroy();
    throw error;
  }
}
