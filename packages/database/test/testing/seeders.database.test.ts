/**
 * Seeders, on the run's driver: they run in order, `only` selects without
 * reordering, a failing seeder leaves none of its own writes but keeps the
 * seeders before it, and malformed, duplicate and unknown seeders are
 * refused without echoing a requested name.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  createTestDataSource,
  defineSeeder,
  matrixTestDatabase,
  runSeeders,
  TestingErrors,
  type TestDataSource,
} from '../../src/testing/index.js';
import { emptyTables } from '../../src/testing/empty-tables.js';
import { Category, TESTING_MODELS } from './fixtures/testing-models.js';
import { rowCount } from './fixtures/table-snapshot.js';

describe('seeders', () => {
  let ds: TestDataSource;

  before(async () => {
    ds = await createTestDataSource(TESTING_MODELS, { database: matrixTestDatabase() });
  });
  after(() => ds.close());
  beforeEach(() => emptyTables(ds));

  const order: string[] = [];
  const seeder = (name: string) =>
    defineSeeder(name, async ({ dataSource }) => {
      assert.equal(dataSource, ds, 'a seeder receives the data source');
      order.push(name);
      await Category.create({ name });
    });

  it('runs every seeder in order, or the selected ones in that order', async () => {
    order.length = 0;
    const seeders = [seeder('roots'), seeder('children'), seeder('leaves')];
    assert.deepEqual(await runSeeders(ds, seeders), ['roots', 'children', 'leaves']);
    assert.deepEqual(await runSeeders(ds, seeders, { only: ['leaves', 'roots'] }), [
      'roots',
      'leaves',
    ]);
    assert.deepEqual(await runSeeders(ds, seeders, { only: [] }), []);
    assert.deepEqual(order, ['roots', 'children', 'leaves', 'roots', 'leaves']);
    assert.equal(await rowCount(ds, Category), 5);
  });

  it('rolls back a failing seeder and stops, keeping the seeders before it', async () => {
    const failure = new Error('seeding failed');
    const failing = defineSeeder('failing', async () => {
      await Category.create({ name: 'half done' });
      throw failure;
    });
    await assert.rejects(
      runSeeders(ds, [seeder('before'), failing, seeder('after')]),
      (error: unknown) =>
        TestingErrors.is(error, 'seeder_failed') &&
        error.context.seeder === 'failing' &&
        error.cause === failure,
    );
    assert.deepEqual(await Category.all().pluck('name'), ['before']);
  });

  it('refuses malformed, duplicate and unknown seeders', async () => {
    const isTesting =
      (code: 'invalid_seeder' | 'duplicate_seeder' | 'unknown_seeder') => (error: unknown) =>
        TestingErrors.is(error, code);
    for (const name of ['', 'Upper', '1st', 'a b', 'x'.repeat(65), 42]) {
      assert.throws(
        () => defineSeeder(name as never, () => undefined),
        isTesting('invalid_seeder'),
      );
    }
    assert.throws(() => defineSeeder('ok', 'run' as never), isTesting('invalid_seeder'));
    await assert.rejects(runSeeders(ds, 'seeders' as never), isTesting('invalid_seeder'));
    await assert.rejects(runSeeders(ds, [{ name: 'x' } as never]), isTesting('invalid_seeder'));
    await assert.rejects(
      runSeeders(ds, [seeder('twice'), seeder('twice')]),
      isTesting('duplicate_seeder'),
    );
    await assert.rejects(
      runSeeders(ds, [seeder('known')], { only: ['secret-name'] }),
      (error: unknown) =>
        isTesting('unknown_seeder')(error) && !String((error as Error).message).includes('secret'),
    );
    await assert.rejects(
      runSeeders(ds, [seeder('known')], { only: 'known' as never }),
      isTesting('invalid_seeder'),
    );
    assert.equal(await rowCount(ds, Category), 0, 'nothing ran');
  });
});
