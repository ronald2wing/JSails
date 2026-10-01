/**
 * The failed-job list and prune options: defaults, bounds, the cursor, and
 * the newest-first order with ids compared by UTF-16 code unit.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JobsErrors } from '../../src/errors/jobs-errors.js';
import {
  checkedListOptions,
  checkedPruneOptions,
  compareFailed,
  DEFAULT_FAILED_LIST_LIMIT,
  isAfterCursor,
  MAX_FAILED_CURSOR_ID_LENGTH,
  MAX_FAILED_LIST_LIMIT,
} from '../../src/failed/list-options.js';

function refused(option: string) {
  return (error: unknown) =>
    JobsErrors.is(error, 'invalid_option') && error.context.option === option;
}

describe('failed-job list options', () => {
  test('defaults to every queue, the default limit, and no cursor', () => {
    const expected = { queue: undefined, limit: DEFAULT_FAILED_LIST_LIMIT, before: undefined };
    assert.deepEqual(checkedListOptions(undefined), expected);
    assert.deepEqual(checkedListOptions({}), expected);
  });

  test('keeps a valid queue, limit and cursor', () => {
    const checked = checkedListOptions({
      queue: 'mail',
      limit: MAX_FAILED_LIST_LIMIT,
      before: { failedAt: 5, id: '7' },
    });
    assert.deepEqual(checked, {
      queue: 'mail',
      limit: MAX_FAILED_LIST_LIMIT,
      before: { failedAt: 5, id: '7' },
    });
    assert.ok(Object.isFrozen(checked.before));
  });

  test('refuses bad options by name', () => {
    assert.throws(() => checkedListOptions(null), refused('options'));
    assert.throws(() => checkedListOptions([]), refused('options'));
    assert.throws(
      () => checkedListOptions({ order: 'asc' }),
      (error: unknown) => JobsErrors.is(error, 'unknown_option'),
    );
    assert.throws(() => checkedListOptions({ queue: 'Bad Queue' }), refused('queue'));
    for (const limit of [0, MAX_FAILED_LIST_LIMIT + 1, 1.5, '10']) {
      assert.throws(() => checkedListOptions({ limit }), refused('limit'));
    }
    for (const before of [
      null,
      { failedAt: 1 },
      { failedAt: 1, id: '1', extra: 1 },
      { failedAt: -1, id: '1' },
      { failedAt: 1.5, id: '1' },
      { failedAt: '1', id: '1' },
      { failedAt: 1, id: '' },
      { failedAt: 1, id: 1 },
      { failedAt: 1, id: 'x'.repeat(MAX_FAILED_CURSOR_ID_LENGTH + 1) },
    ]) {
      assert.throws(() => checkedListOptions({ before }), refused('before'));
    }
  });

  test('prune takes an age in milliseconds and nothing else', () => {
    assert.equal(checkedPruneOptions({ olderThanMs: 0 }), 0);
    assert.equal(checkedPruneOptions({ olderThanMs: 60_000 }), 60_000);
    assert.throws(() => checkedPruneOptions(undefined), refused('options'));
    assert.throws(() => checkedPruneOptions({ olderThanMs: 1, queue: 'q' }), refused('options'));
    assert.throws(() => checkedPruneOptions({ olderThanMs: -1 }), refused('olderThanMs'));
    assert.throws(() => checkedPruneOptions({}), refused('olderThanMs'));
  });

  test('orders newest first, then by id descending, and places a cursor without the job', () => {
    const entries = [
      { failedAt: 1, id: 'a' },
      { failedAt: 2, id: 'a' },
      { failedAt: 2, id: 'b' },
      { failedAt: 1, id: 'a' },
    ];
    assert.deepEqual([...entries].sort(compareFailed), [
      { failedAt: 2, id: 'b' },
      { failedAt: 2, id: 'a' },
      { failedAt: 1, id: 'a' },
      { failedAt: 1, id: 'a' },
    ]);
    const before = { failedAt: 2, id: 'b' };
    assert.equal(isAfterCursor(2, 'a', before), true);
    assert.equal(isAfterCursor(1, 'z', before), true);
    assert.equal(isAfterCursor(2, 'b', before), false);
    assert.equal(isAfterCursor(3, 'a', before), false);
    assert.equal(isAfterCursor(2, 'c', before), false);
  });
});
