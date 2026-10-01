/**
 * Flow ids and the keys every flow follow-up carries, all under the reserved
 * key prefix.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  batchCallbackKey,
  batchChildKey,
  chainCatchKey,
  chainStepKey,
  isFlowId,
  isReservedKey,
  RESERVED_KEY_PREFIX,
  scheduleFireKey,
} from '../../src/flows/flow-limits.js';

describe('flow limits', () => {
  test('a flow id is 1 to 128 letters, digits and . : _ -, starting alphanumeric', () => {
    for (const id of ['a', 'Z9', 'order:42', 'a.b_c-d', `a${'b'.repeat(127)}`]) {
      assert.equal(isFlowId(id), true, id);
    }
    for (const id of ['', '-a', 'a b', 'a/b', `a${'b'.repeat(128)}`, 7, undefined]) {
      assert.equal(isFlowId(id), false, String(id));
    }
  });

  test('the follow-up keys are distinct per flow, step and callback', () => {
    const keys = [
      chainStepKey('c', 0),
      chainStepKey('c', 1),
      chainCatchKey('c'),
      batchChildKey('c', 0),
      batchCallbackKey('c', 'then'),
      batchCallbackKey('c', 'catch'),
      batchCallbackKey('c', 'finally'),
      scheduleFireKey('c', 0),
    ];
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(chainStepKey('c', 2), 'jsails:chain:c:2');
    assert.equal(scheduleFireKey('s', 60_000), 'jsails:schedule:s:60000');
    assert.ok(keys.every((key) => key.startsWith(RESERVED_KEY_PREFIX) && isReservedKey(key)));
  });

  test('only keys under the reserved prefix are reserved', () => {
    assert.equal(RESERVED_KEY_PREFIX, 'jsails:');
    assert.equal(isReservedKey('jsails:anything'), true);
    for (const key of [
      'chain:c:0',
      'batch:b:0',
      'schedule:s:1',
      'jsails',
      'jsails.x',
      'Jsails:x',
    ]) {
      assert.equal(isReservedKey(key), false, key);
    }
  });
});
