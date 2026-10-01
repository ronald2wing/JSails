/**
 * Where the Valkey transport keeps what: BullMQ under `<namespace>:jobs`,
 * the transport's own keys under `_` inside it, job ids BullMQ accepts (no
 * integer, no colon), batch job ids that name their record's incarnation,
 * and digests in place of keys and batch ids.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  childJobId,
  deduplicationId,
  finalizerIdOfChild,
  finalizerJobId,
  keyLayout,
  newBatchIncarnation,
  newJobId,
} from '../../src/valkey/key-layout.js';

test('every key sits under the namespace, and the own keys cannot meet a queue', () => {
  const layout = keyLayout('shop:production');
  assert.equal(layout.prefix, 'shop:production:jobs');
  assert.equal(layout.queueKey('mail'), 'shop:production:jobs:mail:');
  assert.equal(layout.jobKey('mail', 'j1'), 'shop:production:jobs:mail:j1');
  assert.equal(layout.lease('report'), 'shop:production:jobs:_lease:report');
  assert.equal(layout.schedules('spec'), 'shop:production:jobs:_sched:spec');
  assert.match(layout.batchRecord('a:b c'), /^shop:production:jobs:_batch:[\w-]{43}$/);
});

test('job ids are never integers and never hold a colon', () => {
  const finalizer = finalizerJobId('x:1', newBatchIncarnation());
  for (const id of [newJobId(), finalizer, childJobId(finalizer, 7)]) {
    assert.doesNotMatch(id, /:|^\d+$/);
  }
  assert.notEqual(newJobId(), newJobId());
  assert.equal(childJobId('bF', 3), 'bF.3');
});

test('a batch job id names its batch and its incarnation, fresh for each record', () => {
  const incarnation = newBatchIncarnation();
  assert.match(incarnation, /^[\w-]{12}$/);
  assert.notEqual(newBatchIncarnation(), incarnation);
  assert.equal(finalizerJobId('batch-1', incarnation), finalizerJobId('batch-1', incarnation));
  assert.notEqual(
    finalizerJobId('batch-1', incarnation),
    finalizerJobId('batch-1', newBatchIncarnation()),
  );
  assert.notEqual(finalizerJobId('batch-1', incarnation), finalizerJobId('batch-2', incarnation));
  const finalizer = finalizerJobId('batch-1', incarnation);
  assert.equal(finalizerIdOfChild(childJobId(finalizer, 12), 12), finalizer);
  assert.equal(finalizerIdOfChild(childJobId(finalizer, 12), 2), undefined);
  assert.equal(finalizerIdOfChild('.3', 3), undefined, 'a bare suffix names no finalizer');
  assert.equal(finalizerIdOfChild('job-1', 1), undefined);
});

test('a key reaches the server as its digest', () => {
  const id = deduplicationId('invoice:42:ü');
  assert.match(id, /^[\w-]{43}$/);
  assert.equal(id, deduplicationId('invoice:42:ü'));
  assert.notEqual(id, deduplicationId('invoice:43:ü'));
});
