/**
 * The failure record a BullMQ job's `failedReason` holds: the job name and
 * the value-free summary, read back exactly, while a reason this transport
 * did not write reads as `jobs.transport_failed` and never as its text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runtimeSummary } from '../../src/errors/error-summary.js';
import { decodeFailure, encodeFailure, stackless } from '../../src/valkey/failure-record.js';

test('a record reads back as written', () => {
  const error = { ...runtimeSummary('attempt_timeout'), stack: '    at handle (job.js:1:1)' };
  assert.deepEqual(decodeFailure(encodeFailure('report', error)), { name: 'report', error });
});

test('a reason this transport did not write is transport_failed, its text dropped', () => {
  for (const reason of [
    'job stalled more than allowable limit',
    'connect ECONNREFUSED secret-host:6379',
    '{"v":2,"name":"x","error":{}}',
    '{"v":1,"name":"x","error":{"kind":"nope"}}',
    undefined,
    42,
  ]) {
    const decoded = decodeFailure(reason);
    assert.equal(decoded.name, undefined);
    assert.deepEqual(decoded.error, runtimeSummary('transport_failed'));
  }
});

test('a thrown error keeps no stack for BullMQ to store', () => {
  const error = stackless(new SyntaxError('{"v":1}'));
  assert.ok(error instanceof SyntaxError);
  assert.equal(error.message, '{"v":1}');
  assert.equal(error.stack, '');
});
