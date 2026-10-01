/**
 * Factories, on the run's driver: `build` and `buildList` make unsaved
 * records with a sequence that only counts up; `create` goes through the
 * write pipeline (hooks, counter cache); `createList` is atomic; `insertAll`
 * is a set write with the model's own `skipHooks` rule; overrides win; and
 * malformed definitions and arguments are refused.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { isDatabaseError } from '../../src/engine/index.js';
import { runWithTenant } from '../../src/statement/index.js';
import {
  createTestDataSource,
  defineFactory,
  matrixTestDatabase,
  TestingErrors,
  type TestDataSource,
} from '../../src/testing/index.js';
import { emptyTables } from '../../src/testing/empty-tables.js';
import { Author, Category, Post, SAVED_POSTS, TESTING_MODELS } from './fixtures/testing-models.js';
import { rowCount } from './fixtures/table-snapshot.js';

const isInvalid = (error: unknown): boolean => TestingErrors.is(error, 'invalid_factory');

describe('factories', () => {
  let ds: TestDataSource;

  before(async () => {
    ds = await createTestDataSource(TESTING_MODELS, { database: matrixTestDatabase() });
  });
  after(() => ds.close());
  beforeEach(async () => {
    await emptyTables(ds);
    SAVED_POSTS.length = 0;
  });

  it('builds unsaved records with a sequence that only counts up', () => {
    const categories = defineFactory(Category, (n) => ({ name: `category ${n}` }));
    const first = categories.build();
    const [second, third] = categories.buildList(2);
    assert.equal(first.isPersisted(), false);
    assert.ok(first instanceof Category);
    assert.deepEqual(
      [first.name, second?.name, third?.name],
      ['category 1', 'category 2', 'category 3'],
    );
    assert.equal(categories.build({ name: 'named' }).name, 'named', 'an override wins');
    assert.equal(categories.build().name, 'category 5', 'an override still takes a number');
    assert.deepEqual(categories.buildList(0), []);
    assert.equal(categories.model, Category);
  });

  it('creates through the write pipeline', async () => {
    const authors = defineFactory(Author, (n) => ({ name: `author ${n}` }));
    const posts = defineFactory(Post, (n) => ({ title: `post ${n}` }));
    await runWithTenant(1, async () => {
      const author = await authors.create();
      const post = await posts.create({ authorId: author.id });
      assert.equal(post.isPersisted(), true);
      assert.equal(post.tenantId, 1, 'the tenant policy stamped the row');
      assert.deepEqual(SAVED_POSTS, [post.id], 'the hook ran');
      assert.equal((await Author.find(author.id)).postsCount, 1, 'the counter cache moved');
    });
  });

  it('creates a list in one transaction', async () => {
    const authors = defineFactory(Author, () => ({ name: 'same name' }));
    await runWithTenant(1, async () => {
      await assert.rejects(authors.createList(2), (error: unknown) =>
        isDatabaseError(error, 'unique_violation'),
      );
      assert.equal(await rowCount(ds, Author), 0, 'the first create rolled back with the second');
      const numbered = defineFactory(Author, (n) => ({ name: `author ${n}` }));
      const created = await numbered.createList(3);
      assert.deepEqual(
        created.map((author) => author.name),
        ['author 1', 'author 2', 'author 3'],
      );
    });
  });

  it("inserts as a set write, under the model's skipHooks rule", async () => {
    const authors = defineFactory(Author, (n) => ({ name: `author ${n}` }));
    const posts = defineFactory(Post, (n) => ({ title: `post ${n}` }));
    await runWithTenant(1, async () => {
      const author = await authors.create();
      assert.deepEqual(await authors.insertAll(2), { affected: 2 });
      await assert.rejects(posts.insertAll(2, { authorId: author.id }), {
        code: 'query.set_write_skips_hooks',
      });
      const written = await posts.insertAll(2, { authorId: author.id }, { skipHooks: true });
      assert.equal(written.affected, 2);
      assert.deepEqual(SAVED_POSTS, [], 'no hook ran');
      assert.deepEqual(await authors.insertAll(0), { affected: 0 });
    });
    assert.equal(await rowCount(ds, Author), 3);
  });

  it('refuses malformed definitions and arguments', () => {
    assert.throws(() => defineFactory(class {} as never, () => ({})), isInvalid);
    assert.throws(() => defineFactory(Category, 'values' as never), isInvalid);
    const broken = defineFactory(Category, () => 'not values' as never);
    assert.throws(() => broken.build(), isInvalid);
    const categories = defineFactory(Category, (n) => ({ name: `c${n}` }));
    assert.throws(() => categories.build([] as never), isInvalid);
    assert.throws(() => categories.buildList(-1), isInvalid);
    assert.throws(() => categories.buildList(1.5), isInvalid);
  });
});
