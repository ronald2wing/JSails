/**
 * Tests for the `live` plugin: it mounts the whole stack onto the application's
 * HTTP server from `onServe`, and in shared-Valkey mode every change travels
 * through the stream — a local write is appended to the stream, announced on
 * the bus, read back by the tailer, and only then fanned out to the socket;
 * a write appended by another instance arrives the same way. Every case serves
 * a real application, so the serve hook's drain participant goes through the
 * server's contract, and closing it disconnects the subscribers without
 * waiting on the HTTP server.
 *
 * The Valkey slice is the in-memory fake (`./fake-valkey.ts`) injected through
 * the plugin's client seams, so no external service is opened.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { z } from 'zod';

import { createApplication, ServeErrors, validateAppConfig } from 'jsails';
import { databasePlugin, databaseToken, qEq, query } from 'jsails/database';
import type { JsailsExtension } from 'jsails/extensions';
import { publicAccess } from 'jsails/kernel';
import { createPublicationRegistry, definePublication, type LiveChange } from 'jsails/live';
import { deferred, waitFor } from 'jsails/testing';

import { LiveDeliveryError } from '../src/live-service.js';
import { livePlugin, type LivePluginOptions } from '../src/plugin.js';
import { createValkeyChangeLog } from '../src/valkey-change-log.js';
import { createFakeValkey, fakeValkeyPlugin, type FakeValkey } from './fake-valkey.js';
import {
  createItemDataSource,
  defineItemEntity,
  openClient,
  ORIGIN,
  subscribe,
  type ItemEntity,
  ITEM_FIELDS,
} from './fixtures.js';

const PREFIX = 'test:live';
const root = mkdtempSync(join(tmpdir(), 'jsails-live-plugin-'));
after(() => rmSync(root, { recursive: true, force: true }));

interface ServedApp {
  readonly Item: ItemEntity;
  readonly port: number;
  close(): Promise<void>;
}

/** What a case adds around the `database` and `live` plugins. */
interface ServeExtras {
  readonly valkey?: FakeValkey;
  readonly extensions?: readonly JsailsExtension[];
  readonly shutdownTimeoutMs?: number;
}

/**
 * Serve an application of the `database` and `live` plugins over loopback.
 * `overrides` layer over the registry and origin allowlist every case needs.
 */
async function serve(
  table: string,
  overrides: Partial<LivePluginOptions> = {},
  extras: ServeExtras = {},
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
  // The documented per-user shape: only the owner may subscribe.
  registry.register(
    definePublication({
      name: 'live.owned',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({ ownerId: z.string() }).strict(),
      authorize: ({ user, params }) => user !== null && user.id === params.ownerId,
      query: ({ params }) => query(Item).where(qEq('ownerId', params.ownerId)),
    }),
  );
  const plugin = livePlugin({ registry, allowedOrigins: [ORIGIN], ...overrides });
  const dir = mkdtempSync(join(root, 'app-'));
  const app = await createApplication(
    validateAppConfig(
      {
        rootDir: dir,
        host: '127.0.0.1',
        port: 0,
        shutdownTimeoutMs: extras.shutdownTimeoutMs ?? 30_000,
        extensions: [
          databasePlugin({ dataSource }),
          ...(extras.valkey === undefined ? [] : [fakeValkeyPlugin(extras.valkey)]),
          plugin,
          ...(extras.extensions ?? []),
        ],
      },
      { cwd: dir },
    ),
  );
  // The database plugin's cleanup destroys the data source when the app closes.
  const handle = await app.serve();
  return { Item, port: handle.port, close: () => app.close() };
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
    const app = await serve('live_plugin_shared', { prefix: PREFIX }, { valkey: fake });
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
    const app = await serve('live_plugin_remote', { prefix: PREFIX }, { valkey: fake });
    try {
      const client = await openClient(app.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      await client.next((m) => m.type === 'snapshot');

      // The row must exist locally for the membership probe; the *change* is
      // then appended by a second instance sharing the stream and the bus.
      const item = await app.Item.create({ name: 'remote', status: 'published' }).save();
      await client.next((m) => m.type === 'change' && m.sequence === 1);

      const otherConnections = fake.connections();
      const other = await createValkeyChangeLog({ connections: otherConnections, prefix: PREFIX });
      const remote: LiveChange = {
        collection: app.Item.getRepository().metadata.name,
        id: String(item.id),
        operation: 'update',
        row: { id: item.id, name: 'remote', status: 'published', ownerId: null },
        at: Date.now(),
        sequence: 0,
      };
      await other.append(remote);
      fake.publish(`${PREFIX}:notify`, '1');

      const change = await client.next((m) => m.type === 'change' && m.sequence === 2);
      assert.ok(change.type === 'change');
      assert.equal(change.id, String(item.id));

      await other.close();
      await otherConnections.close();
      client.socket.close();
    } finally {
      await app.close();
    }
  });

  it('authorizes a per-user publication through the resolved session user', async () => {
    let sawServices = false;
    const app = await serve('live_plugin_user', {
      resolveUser: ({ request }, services) => {
        sawServices = services.has(databaseToken);
        return request.headers.get('cookie') === 'session=alice' ? { id: 'alice' } : null;
      },
    });
    try {
      const alice = await openClient(app.port, { Cookie: 'session=alice' });
      assert.deepEqual(await subscribe(alice.socket, 'live.owned', { ownerId: 'alice' }), {
        ok: true,
      });
      const snapshot = await alice.next((m) => m.type === 'snapshot');
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(sawServices, true, 'the resolver receives the app services');

      const bob = await openClient(app.port);
      await subscribe(bob.socket, 'live.owned', { ownerId: 'alice' });
      const denied = await bob.next((m) => m.type === 'error');
      assert.ok(denied.type === 'error');
      assert.equal(denied.code, 'unauthorized');

      alice.socket.close();
      bob.socket.close();
    } finally {
      await app.close();
    }
  });

  it('forwards delivery failures to onError', async () => {
    const errors: Error[] = [];
    const app = await serve('live_plugin_errors', {
      flushIntervalMs: 5,
      onError: (error) => errors.push(error),
    });
    const builderProto = Object.getPrototypeOf(query(app.Item).builder);
    const realGetMany = builderProto.getMany;
    const realAndWhereInIds = builderProto.andWhereInIds;
    try {
      const client = await openClient(app.port);
      assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
      await client.next((m) => m.type === 'snapshot');

      // Fail only the delivery's membership probe. The probe is the one query
      // that narrows the publication by primary key (`andWhereInIds`), so it is
      // marked there and refused at `getMany`; the save's own queries never pass
      // through `andWhereInIds` and run normally. No timing window is involved,
      // so the outcome does not depend on how fast the host is.
      const probes = new WeakSet<object>();
      builderProto.andWhereInIds = function (this: object, ...args: unknown[]) {
        probes.add(this);
        return realAndWhereInIds.apply(this, args);
      };
      builderProto.getMany = async function (this: object, ...args: unknown[]) {
        if (probes.has(this)) throw new Error('pool exhausted');
        return realGetMany.apply(this, args);
      };
      await app.Item.create({ name: 'probe-fails', status: 'published' }).save();
      await waitFor(() => errors.length > 0, { timeoutMs: 10_000, label: 'delivery error' });
      builderProto.getMany = realGetMany;
      builderProto.andWhereInIds = realAndWhereInIds;
      assert.ok(errors[0] instanceof LiveDeliveryError);
      assert.doesNotMatch(errors[0].message, /pool exhausted/);

      client.socket.close();
    } finally {
      builderProto.getMany = realGetMany;
      builderProto.andWhereInIds = realAndWhereInIds;
      await app.close();
    }
  });

  it("drains as the application's participant: close disconnects a subscriber and blames only a hung request", async () => {
    const started = deferred();
    const release = deferred();
    const slow: JsailsExtension = {
      name: 'slow-route',
      setup({ routes }) {
        routes.add({
          methods: ['GET'],
          path: '/hung',
          access: publicAccess('drain probe: a request that hangs until released'),
          handler: async () => {
            started.resolve();
            await release.promise;
            return new Response('late');
          },
        });
      },
    };
    const app = await serve(
      'live_plugin_drain',
      {},
      { extensions: [slow], shutdownTimeoutMs: 300 },
    );
    const client = await openClient(app.port);
    assert.deepEqual(await subscribe(client.socket, 'live.items'), { ok: true });
    await client.next((m) => m.type === 'snapshot');
    const disconnected = new Promise<string>((resolve) =>
      client.socket.once('disconnect', resolve),
    );
    const hung = httpRequest({ host: '127.0.0.1', port: app.port, path: '/hung', agent: false });
    hung.on('error', () => {
      // The drain destroys this socket at the deadline.
    });
    hung.end();
    await started.promise;

    const error = await app.close().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    release.resolve();
    assert.ok(ServeErrors.is(error, 'shutdown_timeout'), String(error));
    assert.equal(error.context.attachments, 0, 'live finished with its own subscriber');
    assert.equal(error.context.requests, 1);
    assert.deepEqual(error.payload, { attachments: [] });
    // A transport close, not a server disconnect: the client reconnects elsewhere.
    assert.equal(await disconnected, 'transport close');
    client.socket.close();
  });
});
