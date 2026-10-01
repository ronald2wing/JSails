/**
 * The query ledger: counting and totals without detail, records and lazy
 * shapes with it, nesting, the record cap, and the async context it follows.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createQueryLedger,
  currentQueryLedger,
  statementShape,
  withQueryLedger,
} from '../../src/engine/index.js';
import { ledgerActive, recordStatement } from '../../src/engine/query-ledger.js';

describe('the query ledger', () => {
  it('keeps only the count and total without detail', () => {
    const ledger = createQueryLedger();
    withQueryLedger(ledger, () => {
      recordStatement('SELECT 1', 2, 'app');
      recordStatement('SELECT 2', 3, 'app');
    });
    assert.equal(ledger.detail, false);
    assert.equal(ledger.count, 2);
    assert.equal(ledger.totalMs, 5);
    assert.deepEqual(ledger.records, []);
  });

  it('keeps records with detail and finds repeated shapes', () => {
    const ledger = createQueryLedger({ detail: true });
    withQueryLedger(ledger, () => {
      for (const id of [1, 2, 3]) recordStatement(`SELECT * FROM "t" WHERE "id" = ${id}`, 1, 'app');
      recordStatement('SELECT * FROM "u" WHERE "id" IN ($1, $2)', 1, 'unguarded');
    });
    assert.equal(ledger.records.length, 4);
    assert.equal(ledger.records[3]?.origin, 'unguarded');
    assert.deepEqual(ledger.repeatedShapes(), [
      { shape: 'SELECT * FROM "t" WHERE "id" = ?', count: 3 },
    ]);
    assert.equal(ledger.repeatedShapes(1).length, 2);
  });

  it('records into every enclosing ledger, across awaits', async () => {
    const outer = createQueryLedger();
    const inner = createQueryLedger();
    await withQueryLedger(outer, async () => {
      recordStatement('a', 1, 'app');
      await withQueryLedger(inner, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(currentQueryLedger(), inner);
        recordStatement('b', 1, 'app');
      });
      assert.equal(currentQueryLedger(), outer);
    });
    assert.equal(outer.count, 2);
    assert.equal(inner.count, 1);
    assert.equal(currentQueryLedger(), undefined);
    assert.equal(ledgerActive(), false);
    recordStatement('outside', 1, 'app');
    assert.equal(outer.count, 2);
  });

  it('stops keeping records at the cap, still counting', () => {
    const ledger = createQueryLedger({ detail: true, maxRecords: 2 });
    withQueryLedger(ledger, () => {
      for (let index = 0; index < 5; index += 1) recordStatement('SELECT 1', 1, 'app');
    });
    assert.equal(ledger.count, 5);
    assert.equal(ledger.records.length, 2);
    assert.equal(ledger.dropped, 3);
  });

  it('refuses a ledger it did not create and a bad cap', () => {
    assert.throws(() => withQueryLedger({} as never, () => undefined), TypeError);
    assert.throws(() => createQueryLedger({ maxRecords: -1 }), RangeError);
  });
});

describe('statementShape', () => {
  it('collapses literals, placeholders, lists and value rows', () => {
    assert.equal(
      statementShape("SELECT * FROM t WHERE a = 'it''s' AND b = 42.5"),
      'SELECT * FROM t WHERE a = ? AND b = ?',
    );
    assert.equal(
      statementShape('SELECT * FROM t WHERE id IN ($1, $2, $3)'),
      'SELECT * FROM t WHERE id IN (?...)',
    );
    assert.equal(
      statementShape('INSERT INTO t (a, b) VALUES (?, ?), (?, ?)'),
      'INSERT INTO t (a, b) VALUES (?...)...',
    );
    assert.equal(statementShape('SELECT   1\n FROM "t2"'), 'SELECT ? FROM "t2"');
  });
});
