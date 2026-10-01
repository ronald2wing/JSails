/**
 * `unguarded(ds)` on the run's driver: it has exactly `sql` and `lease`;
 * `sql` binds every interpolation as a parameter (a value holding SQL stays
 * a value), uses the dialect's placeholders, and records its statements in
 * the query ledger as `unguarded`; a lease taken inside a transaction joins
 * it, so raw work rolls back with the records written beside it.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import { createQueryLedger, withQueryLedger, type JsailsDataSource } from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { UNGUARDED_ORIGIN, unguarded } from '../../src/unguarded/index.js';
import { openDataSource, suiteLifecycle } from '../query/fixtures/open-data-source.js';
import { MODELS, Post } from '../query/fixtures/query-models.js';

void forEachDriver('unguarded SQL', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openDataSource(lifecycle, MODELS);
  });

  it('binds interpolations as parameters and records the statement as unguarded', async () => {
    const raw = unguarded(dataSource);
    assert.deepEqual(Object.keys(raw).toSorted(), ['lease', 'sql']);
    await Post.create({ title: 'raw' });
    const hostile = "raw' OR '1'='1";
    const ledger = createQueryLedger({ detail: true });
    const result = await withQueryLedger(ledger, async () => ({
      none: await raw.sql`SELECT title FROM q_posts WHERE title = ${hostile}`,
      one: await raw.sql`SELECT title FROM q_posts WHERE title = ${'raw'} AND views = ${0}`,
    }));
    assert.equal(result.none.rows.length, 0);
    assert.deepEqual(
      result.one.rows.map((row) => row['title']),
      ['raw'],
    );
    assert.deepEqual(
      ledger.records.map((record) => record.origin),
      [UNGUARDED_ORIGIN, UNGUARDED_ORIGIN],
    );
    assert.doesNotMatch(ledger.records[0]?.sql ?? '', /OR '1'='1/);
    const placeholder =
      dataSource.dialect === 'postgres' ? /\$1 AND views = \$2/ : /\? AND views = \?/;
    assert.match(ledger.records[1]?.sql ?? '', placeholder);
  });

  it('joins the ambient transaction through its lease', async () => {
    const raw = unguarded(dataSource);
    await assert.rejects(
      () =>
        dataSource.transaction(async () => {
          await Post.create({ title: 'beside raw' });
          const conn = await raw.lease();
          try {
            await conn.query(`UPDATE q_posts SET views = 7 WHERE title = 'raw'`);
          } finally {
            await conn.release();
          }
          throw new Error('roll back');
        }),
      { message: 'roll back' },
    );
    assert.equal(await Post.where({ title: 'beside raw' }).exists(), false);
    assert.deepEqual(await Post.where({ title: 'raw' }).pluck('views'), [0]);
  });
});
