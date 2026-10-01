/**
 * Rollback coverage of `withTestTransaction`, on the run's driver: every
 * write path of the data layer (the record pipeline, set writes, link
 * tables, model-set handles, raw SQL, fixtures, factories, seeders, nested
 * transactions and their afterCommit callbacks) is visible inside the test
 * transaction and gone after it, against committed rows that stay as they
 * were. This is the audit finding "withRollback misses data-source writes",
 * stated on the new stack.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { isDatabaseError } from '../../src/engine/index.js';
import { insertAll, query } from '../../src/query/index.js';
import { dataHandle } from '../../src/record/index.js';
import { runWithTenant } from '../../src/statement/index.js';
import {
  createTestDataSource,
  defineFactory,
  defineFixture,
  defineSeeder,
  loadFixtures,
  matrixTestDatabase,
  runSeeders,
  withTestTransaction,
  type TestDataSource,
} from '../../src/testing/index.js';
import { transaction } from '../../src/transaction/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import {
  Author,
  Category,
  Post,
  PostTag,
  SAVED_POSTS,
  Tag,
  TESTING_MODELS,
} from './fixtures/testing-models.js';
import { rowCount, snapshot } from './fixtures/table-snapshot.js';

describe('rollback coverage of withTestTransaction', () => {
  let ds: TestDataSource;
  let base: Author;
  let basePost: Post;
  let committed: string;
  const authors = defineFactory(Author, (n) => ({ tenantId: 1, name: `author ${n}` }));

  before(async () => {
    ds = await createTestDataSource(TESTING_MODELS, { database: matrixTestDatabase() });
    // Committed rows the rolled-back writes must leave as they were.
    await runWithTenant(1, async () => {
      base = await Author.create({ name: 'base' });
      basePost = await Post.create({ authorId: base.id, title: 'base post' });
    });
    await insertAll(Tag, [{ name: 'base tag' }]);
    committed = await snapshot(ds);
  });
  after(() => ds.close());

  /** Run `body` in a test transaction and check nothing of it stayed. */
  async function rolledBack(body: () => Promise<void>): Promise<void> {
    await withTestTransaction(ds, () => runWithTenant(1, body));
    assert.equal(await snapshot(ds), committed, 'every write rolled back with the test');
  }

  it('the record pipeline: create, save, destroy and their counter cache', async () => {
    await rolledBack(async () => {
      const author = await Author.create({ name: 'new' });
      await Post.create({ authorId: author.id, title: 'counted' });
      const loaded = await Author.find(base.id);
      loaded.name = 'renamed';
      await loaded.save();
      await (await Post.find(basePost.id)).destroy();
      assert.equal((await Author.find(author.id)).postsCount, 1, 'the counter moved inside');
      assert.equal((await Author.find(base.id)).postsCount, 0, 'the destroy moved its counter');
    });
  });

  it('set writes: insertAll, updateAll and deleteAll', async () => {
    await rolledBack(async () => {
      await Post.insertAll(
        [
          { authorId: base.id, title: 'bulk 1' },
          { authorId: base.id, title: 'bulk 2' },
        ],
        { skipHooks: true },
      );
      await Post.where({ authorId: base.id }).updateAll({ title: 'retitled' }, { skipHooks: true });
      await query(Tag).deleteAll();
      assert.equal(await rowCount(ds, Post), 3);
      assert.equal(await rowCount(ds, Tag), 0);
    });
  });

  it('link tables and model-set handles', async () => {
    await rolledBack(async () => {
      const handle = dataHandle(ds, { models: TESTING_MODELS });
      await handle.insertAll(Tag, [{ name: 'handled' }]);
      const tag = await handle
        .query<{ id: number; name: string }>(Tag)
        .where({ name: 'handled' })
        .getOne();
      assert.ok(tag !== null);
      await insertAll(PostTag, [{ postId: basePost.id, tagId: tag.id }]);
      await handle.query(Category).updateAll({ name: 'none' });
      assert.equal(await rowCount(ds, PostTag), 1);
    });
  });

  it('raw SQL through unguarded sql and a leased connection', async () => {
    await rolledBack(async () => {
      const raw = unguarded(ds);
      await raw.sql`INSERT INTO ts_categories (name) VALUES (${'raw'})`;
      const conn = await raw.lease();
      try {
        await conn.query('DELETE FROM ts_tags');
      } finally {
        await conn.release();
      }
      assert.equal(await rowCount(ds, Category), 1);
      assert.equal(await rowCount(ds, Tag), 0);
    });
  });

  it('fixtures, factories and seeders', async () => {
    SAVED_POSTS.length = 0;
    await rolledBack(async () => {
      await loadFixtures(ds, [defineFixture(Category, [{ name: 'fixture' }])]);
      const author = await authors.create();
      await authors.createList(2);
      await authors.insertAll(2);
      await runSeeders(ds, [
        defineSeeder('posts', () => Post.create({ authorId: author.id, title: 'seeded' })),
      ]);
      assert.equal(await rowCount(ds, Author), 6);
      assert.equal(SAVED_POSTS.length, 1, 'the seeded post ran its hook');
    });
  });

  it('a fixture load, a factory create and a raw insert vanish together', async () => {
    await rolledBack(async () => {
      await loadFixtures(ds, [defineFixture(Tag, [{ name: 'fixture tag' }])]);
      await authors.create({ name: 'factory author' });
      await unguarded(ds).sql`INSERT INTO ts_categories (name) VALUES (${'raw category'})`;
      assert.equal(await rowCount(ds, Tag), 2);
      assert.equal(await rowCount(ds, Author), 2);
      assert.equal(await rowCount(ds, Category), 1);
    });
  });

  it('a committed inner transaction and the writes of its afterCommit callbacks', async () => {
    await rolledBack(async () => {
      let ran = false;
      await transaction(ds, async (tx) => {
        assert.equal(tx.depth, 1, 'the app sees its outermost transaction');
        await insertAll(Tag, [{ name: 'inner' }]);
        tx.afterCommit(async () => {
          ran = true;
          await insertAll(Tag, [{ name: 'after commit' }]);
        });
      });
      assert.ok(ran, 'the afterCommit callback ran when the inner transaction committed');
      assert.equal(await rowCount(ds, Tag), 3);
    });
  });

  it('a failed statement at the top level leaves later writes working', async () => {
    await rolledBack(async () => {
      await assert.rejects(insertAll(Tag, [{ name: 'base tag' }]), (error: unknown) =>
        isDatabaseError(error, 'unique_violation'),
      );
      await insertAll(Tag, [{ name: 'after the failure' }]);
      assert.equal(await rowCount(ds, Tag), 2);
    });
  });
});
