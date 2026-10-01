/**
 * Database config store tests against an on-disk sql.js database whose
 * `jsails_config` table comes from the declarative schema plan.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { JsailsDataSource } from 'jsails/database';
import { createEmptyDataSource, tempDir } from 'jsails/testing';

import { JsailsConfigEntry, createDatabaseConfigStore } from '../../src/database/index.js';
import { ConfigError } from '../../src/index.js';

async function openDataSource(t: TestContext): Promise<JsailsDataSource> {
  const dataSource = await createEmptyDataSource([JsailsConfigEntry], {
    location: join(tempDir(t), 'config.db'),
  });
  t.after(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
  return dataSource;
}

describe('createDatabaseConfigStore', () => {
  it('round-trips and replaces a set', async (t) => {
    const store = createDatabaseConfigStore({ dataSource: await openDataSource(t) });
    assert.equal(await store.read('site'), undefined);
    await store.write([{ name: 'site', values: { title: 'A', links: { home: '/' } } }]);
    assert.deepEqual(await store.read('site'), { title: 'A', links: { home: '/' } });
    await store.write([{ name: 'site', values: { title: 'B' } }]);
    assert.deepEqual(await store.read('site'), { title: 'B' });
    assert.equal(await JsailsConfigEntry.count(), 1);
  });

  it('writes several sets in one transaction', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseConfigStore({ dataSource });
    await store.write([{ name: 'a', values: { x: 1 } }]);
    // The second entry cannot be serialized, so it fails inside the
    // transaction after `a` was already updated in it: that update rolls back.
    await assert.rejects(
      store.write([
        { name: 'a', values: { x: 2 } },
        { name: 'b', values: { x: 10n } as never },
      ]),
    );
    assert.deepEqual(await store.read('a'), { x: 1 });
  });

  it('initializes a lazy source on first use and closes only what it opened', async (t) => {
    // A stand-in source: enough of the DataSource surface for the store.
    const events: string[] = [];
    const lazy = {
      isInitialized: false,
      async initialize() {
        events.push('initialize');
        this.isInitialized = true;
      },
      async destroy() {
        events.push('destroy');
        this.isInitialized = false;
      },
      options: { type: 'sqlite' },
      createQueryRunner: () => ({
        connect: async () => undefined,
        query: async () => [{ name: 'jsails_config' }],
        release: async () => undefined,
      }),
      getRepository: () => ({ findOneBy: async () => null }),
    };
    const store = createDatabaseConfigStore({ getDataSource: () => lazy as never });
    assert.equal(await store.read('site'), undefined);
    await store.close?.();
    assert.deepEqual(events, ['initialize', 'destroy']);

    const given = await openDataSource(t);
    const borrowed = createDatabaseConfigStore({ getDataSource: () => given });
    await borrowed.read('site');
    await borrowed.close?.();
    assert.equal(given.isInitialized, true);
  });

  it('fails value-free when the table is missing', async (t) => {
    const dataSource = await createEmptyDataSource([JsailsConfigEntry], {
      location: join(tempDir(t), 'empty.db'),
      migrate: false,
    });
    t.after(() => dataSource.destroy());
    await assert.rejects(
      createDatabaseConfigStore({ dataSource }).read('site'),
      (error: unknown) => error instanceof ConfigError && error.code === 'missing_table',
    );
  });

  it('requires exactly one data source option', () => {
    assert.throws(() => createDatabaseConfigStore({}), ConfigError);
  });
});
