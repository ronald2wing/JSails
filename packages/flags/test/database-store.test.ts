/**
 * Database flag store tests, against a real on-disk sql.js database with the
 * `jsails_feature_flag` table created by the declarative schema plan — never by
 * runtime DDL. Covers the round trip, the upsert on `(key, scope)`, scope
 * isolation, value-free rejection of invalid input, and the fail-closed paths
 * for a missing table or an uninitialized data source.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { JsailsDataSource } from 'jsails/database';
import { createEmptyDataSource, tempDir } from 'jsails/testing';
import { FeatureFlagError, JsailsFeatureFlag, createDatabaseFlagStore } from '../src/index.js';

/** An initialized data source with the flag table migrated; destroyed with the test. */
async function openDataSource(t: TestContext): Promise<JsailsDataSource> {
  const dataSource = await createEmptyDataSource([JsailsFeatureFlag], {
    location: join(tempDir(t), 'flags.db'),
  });
  t.after(() => dataSource.destroy());
  return dataSource;
}

/** Assert a rejection is a `FeatureFlagError` carrying `code`. */
function isFlagError(code: FeatureFlagError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof FeatureFlagError);
    assert.equal(error.code, code);
    return true;
  };
}

describe('createDatabaseFlagStore', () => {
  it('stores and retrieves a flag through the ORM repository', async (t) => {
    const store = createDatabaseFlagStore({ dataSource: await openDataSource(t) });

    assert.equal(await store.get('new-checkout'), null);

    await store.set('new-checkout', true);
    assert.equal(await store.get('new-checkout'), true);

    await store.set('new-checkout', false);
    assert.equal(await store.get('new-checkout'), false);
  });

  it('upserts by key + scope, keeping one row per flag and stamping updatedAt', async (t) => {
    const dataSource = await openDataSource(t);
    let current = 1000;
    const store = createDatabaseFlagStore({ dataSource, now: () => new Date(current) });
    const repository = dataSource.getRepository(JsailsFeatureFlag);

    await store.set('beta', true);
    current = 2000;
    await store.set('beta', false);

    assert.equal(await repository.count(), 1);
    assert.equal(await store.get('beta'), false);
    const row = await repository.findOneByOrFail({ key: 'beta', scope: '' });
    assert.equal(row.updatedAt.getTime(), 2000);
  });

  it('isolates the global scope from scoped namespaces', async (t) => {
    const store = createDatabaseFlagStore({ dataSource: await openDataSource(t) });

    await store.set('beta', true);
    await store.set('beta', true, 'user-1');
    await store.set('beta', false, 'user-2');

    assert.equal(await store.get('beta'), true);
    assert.equal(await store.get('beta', 'user-1'), true);
    assert.equal(await store.get('beta', 'user-2'), false);
    assert.equal(await store.get('beta', 'user-3'), null);

    assert.deepEqual(await store.all(), { beta: true });
    assert.deepEqual(await store.all('user-2'), { beta: false });
  });

  it('lists every flag in a scope and deletes by key + scope', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseFlagStore({ dataSource });
    const repository = dataSource.getRepository(JsailsFeatureFlag);

    await store.set('a', true);
    await store.set('b', false);
    await store.set('a', true, 'user-1');

    assert.deepEqual(await store.all(), { a: true, b: false });
    assert.deepEqual(await store.all('user-1'), { a: true });

    await store.delete('a');
    assert.equal(await store.get('a'), null);
    assert.equal(await store.get('a', 'user-1'), true, 'the scoped flag is untouched');
    assert.equal(await repository.count(), 2);
  });

  it('rejects an invalid key or value before writing anything', async (t) => {
    const dataSource = await openDataSource(t);
    const store = createDatabaseFlagStore({ dataSource });
    const repository = dataSource.getRepository(JsailsFeatureFlag);

    await assert.rejects(store.set('', true), isFlagError('invalid_key'));
    await assert.rejects(store.set('ok', 'yes' as never), isFlagError('invalid_value'));
    await assert.rejects(store.get('ok', ''), isFlagError('invalid_scope'));
    assert.equal(await repository.count(), 0);
  });

  it('rejects malformed options at construction', (t) => {
    assert.throws(() => createDatabaseFlagStore(null as never), TypeError);
    assert.throws(() => createDatabaseFlagStore({ dataSource: {} as never }), TypeError);
    assert.throws(
      () =>
        createDatabaseFlagStore({
          dataSource: new JsailsDataSource({
            type: 'sqljs',
            location: join(tempDir(t), 'options.db'),
            entities: [JsailsFeatureFlag],
          }),
          now: 'later' as never,
        }),
      TypeError,
    );
  });

  it('fails with a clear error when the table was never migrated', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'missing.db'),
      entities: [JsailsFeatureFlag],
    });
    await dataSource.initialize();
    t.after(() => dataSource.destroy());

    const store = createDatabaseFlagStore({ dataSource });
    for (const operation of [
      () => store.get('x'),
      () => store.set('x', true),
      () => store.delete('x'),
      () => store.all(),
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(isFlagError('missing_table')(error));
        assert.match((error as Error).message, /db:push/);
        return true;
      });
    }
  });

  it('fails on an uninitialized data source without querying', async (t) => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tempDir(t), 'uninitialized.db'),
      entities: [JsailsFeatureFlag],
    });

    const store = createDatabaseFlagStore({ dataSource });
    assert.equal(dataSource.isInitialized, false, 'construction opens no connection');
    await assert.rejects(store.get('x'), isFlagError('not_initialized'));
  });
});
