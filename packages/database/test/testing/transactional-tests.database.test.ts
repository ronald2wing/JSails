/**
 * `transactionalTests`, on the run's driver: each test runs in a test
 * transaction, so the next one starts from the same rows; a transaction a
 * test runs still calls its afterCommit callbacks; a test that declares
 * `commits: true` writes for real (another connection sees it) and has the
 * tables emptied when it ends, even when it fails.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';

import { insertAll } from '../../src/query/index.js';
import { runWithTenant } from '../../src/statement/index.js';
import {
  createTestDataSource,
  matrixTestDatabase,
  TestingErrors,
  transactionalTests,
  type TestDataSource,
} from '../../src/testing/index.js';
import { runIsolated } from '../../src/testing/transactional-tests.js';
import { detached, transaction } from '../../src/transaction/index.js';
import { Author, Category, Post, Tag, TESTING_MODELS } from './fixtures/testing-models.js';
import { rowCount } from './fixtures/table-snapshot.js';

describe('transactionalTests', () => {
  let ds: TestDataSource | undefined;
  const opened = (): TestDataSource => {
    assert.ok(ds !== undefined);
    return ds;
  };
  before(async () => {
    ds = await createTestDataSource(TESTING_MODELS, { database: matrixTestDatabase() });
  });
  after(() => ds?.close());
  const { it, test } = transactionalTests(opened);

  it('writes inside a test transaction', async () => {
    await runWithTenant(1, async () => {
      const author = await Author.create({ name: 'ada' });
      await Post.create({ authorId: author.id, title: 'first' });
    });
    assert.equal(await rowCount(opened(), Post), 1);
  });

  test('starts from the same rows as the test before it', async () => {
    assert.equal(await rowCount(opened(), Author), 0);
    assert.equal(await rowCount(opened(), Post), 0);
  });

  it('runs the afterCommit callbacks of a transaction the test runs', async () => {
    let ran = false;
    await transaction(opened(), (tx) => {
      tx.afterCommit(async () => {
        ran = true;
        await insertAll(Tag, [{ name: 'after commit' }]);
      });
    });
    assert.ok(ran, 'the callback ran when the app transaction committed');
    assert.equal(await rowCount(opened(), Tag), 1);
  });

  it('commits a test that declares commits: true', { commits: true }, async () => {
    await insertAll(Category, [{ name: 'committed' }]);
    // A detached read runs outside every transaction: it sees only committed rows.
    assert.equal(await detached(() => rowCount(opened(), Category)), 1);
  });

  it('starts empty after a committing test', async () => {
    assert.equal(await rowCount(opened(), Category), 0);
  });

  it('empties the tables after a committing test that failed', { commits: true }, async () => {
    await assert.rejects(
      runIsolated(
        opened(),
        async () => {
          await insertAll(Category, [{ name: 'left behind' }]);
          throw new Error('the test failed');
        },
        true,
      ),
      /the test failed/,
    );
    assert.equal(await rowCount(opened(), Category), 0, 'the committed row was emptied');
  });

  it('refuses malformed arguments', () => {
    assert.throws(
      () => transactionalTests(42 as never),
      (error: unknown) => TestingErrors.is(error, 'invalid_options'),
    );
    const { test: declare } = transactionalTests(opened);
    assert.throws(
      () => declare('no body', {}, undefined as never),
      (error: unknown) => TestingErrors.is(error, 'invalid_options'),
    );
    assert.throws(
      () => declare('bad flag', { commits: 'yes' as never }, () => undefined),
      (error: unknown) => TestingErrors.is(error, 'invalid_options'),
    );
  });
});
