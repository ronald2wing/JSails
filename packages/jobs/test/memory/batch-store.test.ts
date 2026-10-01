/**
 * The memory batch records: create, exists and conflict; one record per
 * child; the record that settles the batch hands back the finalizer once;
 * a retry before settlement clears the child, after it only counts; the
 * failures read by index; and the sweep of old settled batches.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { JobErrorSummary } from '../../src/contract/index.js';
import { BATCH_STATUS_RETENTION_MS } from '../../src/flows/flow-limits.js';
import { BatchStore } from '../../src/memory/batch-store.js';

const error: JobErrorSummary = { name: 'Error', kind: 'internal' };
const COMPLETED = { kind: 'completed' } as const;
const SKIPPED = { kind: 'skipped' } as const;

function failedAs(name: string) {
  return { kind: 'failed', name, error } as const;
}

describe('batch store', () => {
  test('creates once; a reissue of the same size exists, another size conflicts', () => {
    const store = new BatchStore<string>();
    let stored = 0;
    const finalizer = () => {
      stored += 1;
      return 'fin';
    };
    assert.equal(store.create('b', 2, finalizer), 'created');
    assert.equal(store.create('b', 2, finalizer), 'exists');
    assert.equal(store.create('b', 3, finalizer), 'conflict');
    assert.equal(stored, 1);
  });

  test('the record that settles the batch returns the finalizer, once', () => {
    const store = new BatchStore<string>();
    store.create('b', 3, () => 'fin');
    assert.equal(store.record('b', 0, COMPLETED, 1), undefined);
    assert.equal(store.record('b', 0, failedAs('x'), 2), undefined, 'a second record is ignored');
    assert.equal(store.record('b', 1, SKIPPED, 3), undefined);
    assert.equal(store.record('b', 7, COMPLETED, 3), undefined, 'an index out of range is ignored');
    assert.equal(store.record('missing', 0, COMPLETED, 3), undefined);
    assert.deepEqual(store.status('b'), {
      total: 3,
      completed: 1,
      failed: 0,
      skipped: 1,
      pending: 1,
      settled: false,
      retriedAfterSettlement: 0,
    });
    assert.equal(store.record('b', 2, failedAs('child'), 4), 'fin');
    assert.equal(store.record('b', 2, COMPLETED, 5), undefined);
    assert.deepEqual(store.status('b'), {
      total: 3,
      completed: 1,
      failed: 1,
      skipped: 1,
      pending: 0,
      settled: true,
      retriedAfterSettlement: 0,
    });
    assert.equal(store.status('missing'), undefined);
  });

  test('a retry before settlement clears the child; after it, only counts', () => {
    const store = new BatchStore<string>();
    store.create('b', 2, () => 'fin');
    store.record('b', 0, failedAs('a'), 1);
    store.retried('b', 0);
    assert.equal(store.status('b')?.pending, 2);
    store.record('b', 0, COMPLETED, 2);
    assert.equal(store.record('b', 1, failedAs('b'), 3), 'fin');
    store.retried('b', 1);
    store.retried('missing', 0);
    assert.deepEqual(
      [store.status('b')?.failed, store.status('b')?.retriedAfterSettlement],
      [1, 1],
    );
  });

  test('failures read by ascending index up to the limit', () => {
    const store = new BatchStore<string>();
    store.create('b', 4, () => 'fin');
    store.record('b', 3, failedAs('d'), 1);
    store.record('b', 1, failedAs('b'), 1);
    store.record('b', 0, COMPLETED, 1);
    store.record('b', 2, failedAs('c'), 1);
    assert.deepEqual(
      store.failures('b', 100).map((failure) => [failure.index, failure.name]),
      [
        [1, 'b'],
        [2, 'c'],
        [3, 'd'],
      ],
    );
    assert.equal(store.failures('b', 2).length, 2);
    assert.deepEqual(store.failures('missing', 2), []);
  });

  test('the sweep drops batches settled longer ago than the retention, at most once a second', () => {
    const store = new BatchStore<string>();
    store.create('old', 1, () => 'a');
    store.create('open', 1, () => 'b');
    store.record('old', 0, COMPLETED, 0);
    store.sweep(BATCH_STATUS_RETENTION_MS);
    assert.ok(store.status('old') !== undefined, 'kept through the retention');
    store.sweep(BATCH_STATUS_RETENTION_MS + 1);
    assert.ok(store.status('old') !== undefined, 'a second sweep within a second does nothing');
    store.sweep(BATCH_STATUS_RETENTION_MS + 1_000);
    assert.equal(store.status('old'), undefined);
    assert.ok(store.status('open') !== undefined);
  });
});
