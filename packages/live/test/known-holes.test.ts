/**
 * Known holes in live subscriptions, each stated as the safe behaviour against
 * the real stack: a SQLite data source, the live service, and (for the
 * connection cases) the Socket.IO transport on a loopback server driven by a
 * real client.
 *
 * A grant must not outlive the state it was decided on: once a user is
 * demoted, an admin-only subscription they hold is revoked and a new one on the
 * same socket is refused. A publication over a tenant-scoped model delivers
 * each subscriber its own tenant's rows and nothing else. A throwing
 * `authorize` is a fault the app hears about, not a silent deny.
 *
 * A case that fails today is listed in `scripts/expected-failures/security.json`
 * with the work package that closes it. A case that already holds stays here
 * as an ordinary regression test.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import { z } from 'zod';

import { query, runWithTenant, tenantScoped, type JsailsDataSource } from 'jsails/database';
import {
  createPublicationRegistry,
  definePublication,
  type LiveServerMessage,
  type LiveUser,
  type PublicationRegistry,
} from 'jsails/live';
import { waitFor } from 'jsails/testing';

import { createInMemoryChangeLog } from '../src/in-memory-change-log.js';
import { createLiveService, type LiveService } from '../src/live-service.js';
import { attachLiveSocket } from '../src/socket-transport.js';
import {
  collectMessages,
  createItemDataSource,
  defineItemEntity,
  ITEM_FIELDS,
  listen,
  messageMatching,
  openClient,
  ORIGIN,
  subscribe,
  WAIT_MS,
} from './fixtures.js';

const AdminItem = defineItemEntity('kh_admin_items');
const TenantItem = defineItemEntity('kh_tenant_items');
tenantScoped('ownerId')(TenantItem);

/** A started live service over `dataSource`, stopped when the test ends. */
async function startService(
  t: TestContext,
  registry: PublicationRegistry,
  dataSource: JsailsDataSource,
  onError?: (error: unknown) => void,
): Promise<LiveService> {
  const service = createLiveService({
    registry,
    changeLog: createInMemoryChangeLog(),
    flushIntervalMs: 5,
    ...(onError === undefined ? {} : { onError }),
  });
  await service.start();
  dataSource.liveCapture.setListener((changes) => service.ingest(changes));
  t.after(async () => {
    await service.stop();
    await dataSource.destroy();
  });
  return service;
}

/**
 * The admin stack: `kh.admin` admits only a user whose `role` is `admin`, and
 * the transport resolves alice's role from `roles` on every (re)validation.
 */
async function startAdminStack(
  t: TestContext,
  roles: Map<string, string>,
  revalidateIntervalMs?: number,
): Promise<number> {
  const dataSource = await createItemDataSource(AdminItem);
  await AdminItem.create({ name: 'admin-only row', status: 'draft' }).save();
  const registry = createPublicationRegistry();
  registry.register(
    definePublication({
      name: 'kh.admin',
      collection: 'items',
      fields: ITEM_FIELDS,
      params: z.object({}).strict(),
      authorize: ({ user }) => user?.['role'] === 'admin',
      query: () => query(AdminItem).orderBy('id', 'ASC'),
    }),
  );
  const service = await startService(t, registry, dataSource);
  const httpServer = createServer();
  const handle = attachLiveSocket(httpServer, service, {
    allowedOrigins: [ORIGIN],
    resolveUser: (): LiveUser => ({ id: 'alice', role: roles.get('alice') ?? 'none' }),
    ...(revalidateIntervalMs === undefined ? {} : { revalidateIntervalMs }),
  });
  const port = await listen(httpServer);
  t.after(async () => {
    await handle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  return port;
}

describe('known holes: a grant does not outlive a demotion', () => {
  it('revokes an open admin subscription once the demotion is revalidated', async (t) => {
    const roles = new Map([['alice', 'admin']]);
    const port = await startAdminStack(t, roles, 20);
    const client = await openClient(port);
    t.after(() => client.socket.disconnect());
    assert.deepEqual(await subscribe(client.socket, 'kh.admin'), { ok: true });
    await client.next((message) => message.type === 'snapshot');
    let disconnected = false;
    client.socket.on('disconnect', () => {
      disconnected = true;
    });
    // Revalidation runs every 20 ms; an unchanged admin keeps the subscription.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(disconnected, false);
    assert.equal(
      client.messages.some((message) => message.type === 'error'),
      false,
    );
    roles.set('alice', 'viewer');
    // Revoked either way: the subscription is closed or the socket is dropped.
    await waitFor(
      () => disconnected || client.messages.some((message) => message.type === 'error'),
      { timeoutMs: WAIT_MS, label: 'demoted subscription revoked' },
    );
  });

  it('refuses a new admin-only subscription on the same socket after a demotion', async (t) => {
    const roles = new Map([['alice', 'admin']]);
    // The transport's default revalidation interval: nothing here waits for it.
    const port = await startAdminStack(t, roles);
    const client = await openClient(port);
    t.after(() => client.socket.disconnect());
    assert.deepEqual(await subscribe(client.socket, 'kh.admin'), { ok: true });

    roles.set('alice', 'viewer');
    const again = await subscribe(client.socket, 'kh.admin');
    assert.equal(again.ok, false, 'a demoted user opened an admin-only subscription');
  });
});

describe('known holes: a tenant-scoped publication stays inside its tenant', () => {
  it("delivers a subscriber its own tenant's rows and nothing else", async (t) => {
    const dataSource = await createItemDataSource(TenantItem);
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'kh.tenant',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => true,
        query: () => query(TenantItem).orderBy('id', 'ASC'),
      }),
    );
    const service = await startService(t, registry, dataSource);
    await runWithTenant('tenant-a', () =>
      TenantItem.create({ name: 'tenant a row', status: 'draft' }).save(),
    );
    await runWithTenant('tenant-b', () =>
      TenantItem.create({ name: 'tenant b secret', status: 'draft' }).save(),
    );

    const { messages, sink } = collectMessages();
    await runWithTenant('tenant-a', () =>
      service.subscribe({ publication: 'kh.tenant', params: {} }, sink),
    );
    const first = await messageMatching(messages, (message) => message.type !== 'change');
    assert.equal(
      first.type,
      'snapshot',
      `the subscription was refused: ${first.type === 'error' ? first.code : first.type}`,
    );
    const names = rowNames(first);
    assert.deepEqual(names, ['tenant a row']);

    // A later write in the other tenant never reaches this subscriber.
    await runWithTenant('tenant-b', () =>
      TenantItem.create({ name: 'tenant b later', status: 'draft' }).save(),
    );
    await runWithTenant('tenant-a', () =>
      TenantItem.create({ name: 'tenant a later', status: 'draft' }).save(),
    );
    await messageMatching(messages, (message) => JSON.stringify(message).includes('a later'));
    assert.equal(JSON.stringify(messages).includes('tenant b'), false);
  });
});

describe('known holes: a throwing publication authorize is a reported fault', () => {
  it('denies the subscription and reports the failure', async (t) => {
    const FaultItem = defineItemEntity('kh_fault_items');
    const dataSource = await createItemDataSource(FaultItem);
    const registry = createPublicationRegistry();
    registry.register(
      definePublication({
        name: 'kh.fault',
        collection: 'items',
        fields: ITEM_FIELDS,
        params: z.object({}).strict(),
        authorize: () => {
          throw new Error('policy store unavailable');
        },
        query: () => query(FaultItem).orderBy('id', 'ASC'),
      }),
    );
    const reported: unknown[] = [];
    const service = await startService(t, registry, dataSource, (error) => reported.push(error));
    const { messages, sink } = collectMessages();
    await service.subscribe({ publication: 'kh.fault', params: {} }, sink);
    const denied = await messageMatching(messages, (message) => message.type === 'error');
    assert.equal(denied.type === 'error' ? denied.code : denied.type, 'unauthorized');
    assert.ok(
      reported.some(
        (error) => error instanceof Error && error.message === 'policy store unavailable',
      ),
      'the authorize failure reached onError',
    );
  });
});

/** The `name` of every row in a snapshot message. */
function rowNames(message: LiveServerMessage): unknown[] {
  if (message.type !== 'snapshot') return [];
  return (message.rows as readonly { name?: unknown }[]).map((row) => row.name);
}
