/**
 * Database notification store tests against an on-disk sql.js database whose
 * `jsails_notifications` table comes from the declarative schema plan.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createEmptyDataSource, tempDir } from 'jsails/testing';

import { createDatabaseNotificationStore } from '../src/database-store.js';
import { JsailsNotification } from '../src/entities.js';
import { code, exerciseStore } from './fixtures.js';

async function openDataSource(t: TestContext, entities: Function[] = [JsailsNotification]) {
  const dataSource = await createEmptyDataSource(entities, {
    location: join(tempDir(t), 'notifications.db'),
  });
  t.after(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
  return dataSource;
}

describe('createDatabaseNotificationStore', () => {
  it('meets the store contract', async (t) => {
    await exerciseStore(createDatabaseNotificationStore({ dataSource: await openDataSource(t) }));
  });

  it('stamps createdAt and readAt from the clock', async (t) => {
    let now = new Date('2026-01-01T00:00:00Z');
    const store = createDatabaseNotificationStore({
      dataSource: await openDataSource(t),
      now: () => now,
    });
    const created = await store.create({ notifiable: '7', type: 't', data: { a: [1, 'b'] } });
    assert.equal(created.createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
    now = new Date('2026-01-02T00:00:00Z');
    await store.markRead('7', created.id);
    const [record] = await store.list('7');
    assert.equal(record?.readAt?.toISOString(), '2026-01-02T00:00:00.000Z');
    assert.deepEqual(record?.data, { a: [1, 'b'] });
  });

  it('fails with missing_table until db:push created it', async (t) => {
    // A data source whose schema lacks the notifications table.
    const dataSource = await openDataSource(t, []);
    const store = createDatabaseNotificationStore({ dataSource });
    await assert.rejects(store.list('1'), code('missing_table'));
  });

  it('refuses an uninitialized source it was not asked to open', async (t) => {
    const dataSource = await openDataSource(t);
    await dataSource.destroy();
    const store = createDatabaseNotificationStore({ dataSource });
    await assert.rejects(store.unreadCount('1'), code('not_initialized'));
  });

  it('rejects a malformed id or options', async (t) => {
    const store = createDatabaseNotificationStore({ dataSource: await openDataSource(t) });
    await assert.rejects(store.markRead('1', 0), code('not_found'));
    await assert.rejects(store.delete('1', 1.5), code('not_found'));
    assert.throws(() => createDatabaseNotificationStore({}), TypeError);
    assert.throws(() => createDatabaseNotificationStore(null as never), TypeError);
  });
});
