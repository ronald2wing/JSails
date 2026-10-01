/**
 * Tests for the `live` plugin: it mounts the whole stack onto the application's
 * HTTP server from `onServe`, and in shared-Valkey mode every change travels
 * through the stream — a local write is appended to the stream, announced on
 * the bus, read back by the tailer, and only then fanned out to the socket;
 * a write appended by another instance arrives the same way.
 *
 * The Valkey slice is the in-memory fake (`./fake-valkey.ts`) injected through
 * the plugin's client seams, so no external service is opened.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { databasePlugin, query } from 'jsails/database';
import { runExtensions } from 'jsails/extensions';
import { createPublicationRegistry, definePublication, type LiveChange } from 'jsails/live';
import type { ResolvedAppConfig } from 'jsails/testing';

import { livePlugin, type LivePluginOptions } from '../src/plugin.js';
import { createValkeyChangeLog } from '../src/valkey-change-log.js';
import { createFakeValkey, type FakeValkey } from './fake-valkey.js';
import {
  createItemDataSource,
  defineItemEntity,
  listen,
  openClient,
  ORIGIN,
  subscribe,
  type ItemEntity,
  ITEM_FIELDS,
} from './fixtures.js';

const VALKEY_URL = 'redis://valkey.invalid:6379';
const PREFIX = 'test:live';

interface ServedApp {
  readonly Item: ItemEntity;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Assemble the `database` and `live` plugins, then run the serve hooks against
 * a loopback server exactly as `Application.serve` would. `overrides` layer
 * over the registry and origin allowlist every case needs.
 */
async function serve(
  table: string,
  overrides: Partial<LivePluginOptions> = {},
): Promise<ServedApp> {
  const Item = defineItemEntity(table);
  const dataSource = await createItemDataSource(Item);
  const registry = createPublicationRegistry();
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
  const plugin = livePlugin({ registry, allowedOrigins: [ORIGIN], ...overrides });
  const runtime = await runExtensions([databasePlugin({ dataSource }), plugin]);

  const httpServer = createServer();
  const port = await listen(httpServer);
  // The live plugin reads only `services` from the serve context.
  const context = { config: {} as ResolvedAppConfig, services: runtime.services };
  for (const hook of runtime.serveHooks) {
    await hook(httpServer, context);
  }

  return {
    Item,
    port,
    async close() {
      // The database plugin's cleanup destroys the data source.
      await runtime.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Plugin options that route the shared backend through the fake Valkey. */
function sharedValkey(fake: FakeValkey): Partial<LivePluginOptions> {
  return {
    valkeyUrl: VALKEY_URL,
    prefix: PREFIX,
    createLogClient: () => fake.client(),
    createBusClient: () => fake.busClient(),
  };
}

describe('livePlugin', () => {
  it('serves a single-instance stack over the in-memory log', async () => {
    const app = await serve('live_plugin_local');
    try {
      const client = await openClient(app.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      await client.next((m) => m.type === 'snapshot');

      const item = await app.Item.create({ name: 'local', status: 'published' }).save();
      const change = await client.next((m) => m.type === 'change');
      assert.ok(change.type === 'change');
      assert.equal(change.id, String(item.id));
      assert.equal(change.sequence, 1);

      client.socket.close();
    } finally {
      await app.close();
    }
  });

  it('tails a local write through the shared Valkey stream', async () => {
    const fake = createFakeValkey();
    const app = await serve('live_plugin_shared', sharedValkey(fake));
    try {
      const client = await openClient(app.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      await client.next((m) => m.type === 'snapshot');

      const item = await app.Item.create({ name: 'shared', status: 'published' }).save();
      const change = await client.next((m) => m.type === 'change');
      assert.ok(change.type === 'change');
      assert.equal(change.id, String(item.id));
      assert.equal(change.sequence, 1);
      assert.deepEqual(change.row, {
        id: item.id,
        name: 'shared',
        status: 'published',
        ownerId: null,
      });

      // The change reached the socket by way of the stream, not a local route.
      assert.equal(fake.streams.get(`${PREFIX}:changes`)?.length, 1);
      assert.equal(fake.counters.get(`${PREFIX}:sequence`), 1);

      client.socket.close();
    } finally {
      await app.close();
    }
  });

  it('fans out a change appended by another instance', async () => {
    const fake = createFakeValkey();
    const app = await serve('live_plugin_remote', sharedValkey(fake));
    try {
      const client = await openClient(app.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      await client.next((m) => m.type === 'snapshot');

      // The row must exist locally for the membership probe; the *change* is
      // then appended by a second instance sharing the stream and the bus.
      const item = await app.Item.create({ name: 'remote', status: 'published' }).save();
      await client.next((m) => m.type === 'change' && m.sequence === 1);

      const other = await createValkeyChangeLog({
        valkeyUrl: VALKEY_URL,
        prefix: PREFIX,
        createClient: () => fake.client(),
      });
      const remote: LiveChange = {
        collection: app.Item.getRepository().metadata.name,
        id: String(item.id),
        operation: 'update',
        row: { id: item.id, name: 'remote', status: 'published', ownerId: null },
        at: Date.now(),
        sequence: 0,
      };
      await other.append(remote);
      await fake.busClient().publish(`${PREFIX}:notify`, '1');

      const change = await client.next((m) => m.type === 'change' && m.sequence === 2);
      assert.ok(change.type === 'change');
      assert.equal(change.id, String(item.id));

      await other.close();
      client.socket.close();
    } finally {
      await app.close();
    }
  });
});
