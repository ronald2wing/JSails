/**
 * Fixtures, on the run's driver: rows load as stated (counters as given, no
 * hooks, several tenants without an ambient tenant, link tables, runs of
 * different properties), explicit identity keys leave the next generated
 * key free (PostgreSQL's sequence moves), a failed load leaves nothing, and
 * malformed fixtures are refused.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { isDatabaseError } from '../../src/engine/index.js';
import { query } from '../../src/query/index.js';
import { runWithTenant } from '../../src/statement/index.js';
import {
  createTestDataSource,
  defineFixture,
  loadFixtures,
  matrixTestDatabase,
  TestingErrors,
  type TestDataSource,
} from '../../src/testing/index.js';
import { emptyTables } from '../../src/testing/empty-tables.js';
import {
  Author,
  Category,
  Post,
  PostTag,
  SAVED_POSTS,
  Tag,
  TESTING_MODELS,
} from './fixtures/testing-models.js';
import { rowCount } from './fixtures/table-snapshot.js';

describe('fixtures', () => {
  let ds: TestDataSource;

  before(async () => {
    ds = await createTestDataSource(TESTING_MODELS, { database: matrixTestDatabase() });
  });
  after(() => ds.close());
  beforeEach(async () => {
    await emptyTables(ds);
    SAVED_POSTS.length = 0;
  });

  it('loads rows as stated, for several tenants, without hooks or effects', async () => {
    await loadFixtures(ds, [
      defineFixture(Author, [
        { id: 1, tenantId: 1, name: 'ada', postsCount: 7 },
        { id: 2, tenantId: 2, name: 'bob' },
      ]),
      defineFixture(Post, [
        { id: 10, tenantId: 1, authorId: 1, title: 'first' },
        { id: 11, tenantId: 2, authorId: 2, title: 'second' },
      ]),
      defineFixture(Tag, [{ id: 5, name: 'news' }]),
      defineFixture(PostTag, [{ tenantId: 1, postId: 10, tagId: 5 }]),
    ]);
    assert.deepEqual(SAVED_POSTS, [], 'no hook ran');
    const ada = await runWithTenant(1, () => Author.find(1));
    assert.equal(ada.postsCount, 7, 'the counter is what the row says');
    const bob = await runWithTenant(2, () => Author.find(2));
    assert.equal(bob.postsCount, 0, 'a column left out takes its default');
    assert.equal(await rowCount(ds, PostTag), 1);
    const tags = await query<{ name: string }>(Tag).pluck('name');
    assert.deepEqual(tags, ['news']);
  });

  it('leaves the next generated key free after explicit keys', async () => {
    await loadFixtures(ds, [
      defineFixture(Category, [
        { id: 1, name: 'root' },
        { id: 2, name: 'child', parentId: 1 },
      ]),
    ]);
    const next = await Category.create({ name: 'generated' });
    assert.ok(next.id > 2, 'the generated key follows the fixture keys');
    await loadFixtures(ds, [defineFixture(Category, [{ name: 'no key' }])]);
    assert.equal(await rowCount(ds, Category), 4);
  });

  it('loads rows that name different properties, in order', async () => {
    await loadFixtures(ds, [
      defineFixture(Category, [{ name: 'a' }, { name: 'b', parentId: null }, { name: 'c' }]),
    ]);
    const names = await Category.all().orderBy('id').pluck('name');
    assert.deepEqual(names, ['a', 'b', 'c']);
  });

  it('leaves nothing when a fixture fails', async () => {
    await assert.rejects(
      loadFixtures(ds, [
        defineFixture(Tag, [{ name: 'kept?' }]),
        defineFixture(Tag, [{ name: 'kept?' }]),
      ]),
      (error: unknown) => isDatabaseError(error, 'unique_violation'),
    );
    assert.equal(await rowCount(ds, Tag), 0);
  });

  it('refuses malformed fixtures and models the data source does not hold', async () => {
    const isTesting = (code: 'invalid_fixture' | 'unknown_fixture_model') => (error: unknown) =>
      TestingErrors.is(error, code);
    assert.throws(() => defineFixture({} as never, []), isTesting('invalid_fixture'));
    assert.throws(() => defineFixture(Tag, 'rows' as never), isTesting('invalid_fixture'));
    assert.throws(() => defineFixture(Tag, [[1] as never]), isTesting('invalid_fixture'));
    await assert.rejects(loadFixtures(ds, 'fixtures' as never), isTesting('invalid_fixture'));
    await assert.rejects(loadFixtures(ds, [null as never]), isTesting('invalid_fixture'));
    const { defineTable, column } = await import('../../src/model/index.js');
    const Stray = defineTable({ table: 'ts_strays', columns: { name: column.string(10) } });
    await assert.rejects(
      loadFixtures(ds, [defineFixture(Stray, [{ name: 'x' }])]),
      isTesting('unknown_fixture_model'),
    );
  });

  it('copies and freezes a fixture', () => {
    const rows = [{ name: 'a' }];
    const fixture = defineFixture(Tag, rows);
    rows[0] = { name: 'changed' };
    assert.deepEqual(fixture.rows, [{ name: 'a' }]);
    assert.ok(Object.isFrozen(fixture) && Object.isFrozen(fixture.rows[0]));
    assert.equal(fixture.model, Tag);
  });
});
