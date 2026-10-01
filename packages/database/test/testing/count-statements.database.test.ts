/**
 * `countStatements`, on the run's driver: exact counts for a known sequence
 * of record, query and raw statements, the same inside the default per-test
 * transaction as outside it (its savepoints and the pipeline's transaction
 * control are not statements of the code under test), only the statements
 * of the data source asked about, repeated shapes, and failures.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { runWithTenant } from '../../src/statement/index.js';
import {
  countStatements,
  createTestDataSource,
  matrixTestDatabase,
  withTestTransaction,
  type TestDataSource,
} from '../../src/testing/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import { Author, Category, Post } from './fixtures/testing-models.js';

describe('countStatements', () => {
  let ds: TestDataSource;
  let other: TestDataSource;

  before(async () => {
    ds = await createTestDataSource([Author, Post], { database: matrixTestDatabase() });
    other = await createTestDataSource([Category], { database: matrixTestDatabase() });
  });
  after(async () => {
    await ds.close();
    await other.close();
  });

  /** One author, one counted post, one query and one raw read: five statements. */
  const knownSequence = (): Promise<unknown> =>
    runWithTenant(1, async () => {
      const author = await Author.create({ name: `author ${Math.random()}` });
      await Post.create({ authorId: author.id, title: 'counted' });
      await Post.where({ authorId: author.id }).getMany();
      await unguarded(ds).sql`SELECT COUNT(*) AS n FROM ts_posts`;
    });

  it('reports exact counts for a known sequence', async () => {
    const ledger = await countStatements(ds, knownSequence);
    assert.equal(ledger.count, 5, ledger.records.map((record) => record.sql).join('\n'));
    assert.deepEqual(
      ledger.records.map((record) => record.origin),
      ['app', 'app', 'app', 'app', 'unguarded'],
    );
    assert.match(ledger.records[0]?.sql ?? '', /^INSERT INTO/);
    assert.match(
      ledger.records[2]?.sql ?? '',
      /^UPDATE/,
      'the counter cache moves in one statement',
    );
    assert.ok(ledger.totalMs >= 0);
  });

  it('reports the same counts inside a test transaction', async () => {
    const ledger = await withTestTransaction(ds, () => countStatements(ds, knownSequence));
    assert.equal(ledger.count, 5, ledger.records.map((record) => record.sql).join('\n'));
    assert.ok(
      ledger.records.every((record) => !/SAVEPOINT|COMMIT|BEGIN/.test(record.sql)),
      'transaction control is not counted',
    );
  });

  it('counts only the statements of the data source asked about', async () => {
    const ledger = await countStatements(ds, async () => {
      await Category.create({ name: 'elsewhere' });
      await unguarded(other).sql`SELECT 1 AS one`;
    });
    assert.equal(ledger.count, 0);
    const own = await countStatements(other, () => Category.create({ name: 'here' }));
    assert.equal(own.count, 1);
  });

  it('finds the repeated shape of an N+1 loop', async () => {
    const ids = await runWithTenant(1, async () => {
      const created = [];
      for (const name of ['a', 'b', 'c'])
        created.push(await Author.create({ name: `${name}${Math.random()}` }));
      return created.map((author) => author.id);
    });
    const ledger = await countStatements(ds, () =>
      runWithTenant(1, async () => {
        for (const id of ids) await Author.find(id);
      }),
    );
    assert.equal(ledger.count, 3);
    const [repeated] = ledger.repeatedShapes();
    assert.equal(repeated?.count, 3);
    assert.deepEqual(ledger.repeatedShapes(4), []);
  });

  it('rejects with the failure of the function', async () => {
    const failure = new Error('the body failed');
    await assert.rejects(
      countStatements(ds, () => Promise.reject(failure)),
      (error) => error === failure,
    );
  });

  it('refuses a closed data source', async () => {
    const closed = await createTestDataSource([Category], { database: 'memory' }).catch(
      (error: unknown) => error,
    );
    // Category is bound to the open `other` data source, so a second one is refused.
    assert.equal((closed as { code?: string }).code, 'data_source.already_bound');
    const lone = await createTestDataSource([], { database: 'memory' });
    await lone.close();
    await assert.rejects(
      countStatements(lone, () => undefined),
      { code: 'data_source.closed' },
    );
  });
});
