/**
 * Coalescing the records of one commit: every pair of operations on one key
 * folds as the module states, key records keep the order each key first
 * changed, an `invalidate` absorbs the key records of its collection and
 * tenant (all tenants when it has none), and records of other collections,
 * tenants or keys never fold together (composite keys compared by value).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { changeRecord, type ChangeOp, type ChangeRecord } from '../../src/change/change-record.js';
import { coalesceChanges } from '../../src/change/coalesce.js';

function ops(...sequence: ChangeOp[]): readonly ChangeRecord[] {
  return sequence.map((op) => changeRecord('posts', op, op === 'invalidate' ? undefined : 1));
}

function shapes(records: readonly ChangeRecord[]): string[] {
  return records.map(
    (record) =>
      `${record.op} ${record.collection}${record.key === undefined ? '' : ` ${JSON.stringify(record.key, (_, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value))}`}${record.tenant === undefined ? '' : ` @${String(record.tenant)}`}`,
  );
}

describe('coalesceChanges', () => {
  it('folds the operations on one key', () => {
    const cases: readonly [readonly ChangeOp[], readonly string[]][] = [
      [['insert', 'update'], ['insert posts 1']],
      [['insert', 'delete'], []],
      [['insert', 'delete', 'insert'], ['insert posts 1']],
      [['update', 'update'], ['update posts 1']],
      [['update', 'delete'], ['delete posts 1']],
      [['delete', 'insert'], ['update posts 1']],
      [['delete', 'insert', 'delete'], ['delete posts 1']],
      [['insert', 'update', 'delete'], []],
    ];
    for (const [sequence, expected] of cases) {
      assert.deepEqual(shapes(coalesceChanges(ops(...sequence))), expected, sequence.join(' '));
    }
  });

  it('keeps keys apart by collection, tenant and value, in first-change order', () => {
    const records = [
      changeRecord('posts', 'update', 2),
      changeRecord('posts', 'insert', 1),
      changeRecord('posts', 'update', 1n),
      changeRecord('posts', 'update', '1'),
      changeRecord('comments', 'delete', 1),
      changeRecord('posts', 'update', 2, 7),
      changeRecord('posts', 'update', 2),
      changeRecord('links', 'insert', Object.freeze({ a: 1, b: 2 })),
      changeRecord('links', 'delete', Object.freeze({ b: 2, a: 1 })),
    ];
    assert.deepEqual(shapes(coalesceChanges(records)), [
      'update posts 2',
      'insert posts 1',
      'update posts "1n"',
      'update posts "1"',
      'delete comments 1',
      'update posts 2 @7',
    ]);
  });

  it('absorbs the key records of a collection into its invalidate', () => {
    const records = [
      changeRecord('posts', 'insert', 1, 7),
      changeRecord('posts', 'update', 2, 8),
      changeRecord('posts', 'invalidate', undefined, 7),
      changeRecord('posts', 'invalidate', undefined, 7),
      changeRecord('comments', 'update', 3, 7),
    ];
    assert.deepEqual(shapes(coalesceChanges(records)), [
      'update posts 2 @8',
      'update comments 3 @7',
      'invalidate posts @7',
    ]);
    const everyTenant = [...records, changeRecord('posts', 'invalidate')];
    assert.deepEqual(shapes(coalesceChanges(everyTenant)), [
      'update comments 3 @7',
      'invalidate posts',
    ]);
  });

  it('returns frozen records and an empty list for nothing', () => {
    assert.deepEqual(coalesceChanges([]), []);
    const [folded] = coalesceChanges(ops('delete', 'insert'));
    assert.ok(folded !== undefined && Object.isFrozen(folded));
    assert.ok(Object.isFrozen(coalesceChanges(ops('update'))));
  });
});
