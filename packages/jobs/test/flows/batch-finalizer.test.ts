/**
 * The batch finalizer: its payload decodes strictly; it completes with then
 * or catch by the batch's failures, then finally, as keyed follow-ups and
 * never enqueues itself; a callback on a queue the worker does not declare
 * leaves the finalizer to a newer worker with nothing enqueued; it refuses
 * without the flows capability or with a malformed payload, waits
 * (retryably) for an unsettled batch, gives up on a missing one, and turns a
 * status read failure into a summarized failed outcome.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AttemptOutcome, BatchStatus, JobFlowStep } from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import {
  BATCH_FINALIZER_JOB,
  decodeFinalizerPayload,
  FINALIZER_OPTIONS,
  finalizerEnvelope,
  runBatchFinalizer,
  type FinalizerPayload,
} from '../../src/flows/batch-finalizer.js';
import { VirtualClock } from '../timing/virtual-clock.js';
import { FlowRecorder, queuesOf } from './flow-recorder.js';

const NOW = 1_700_000_000_000;

function step(name: string, queue = 'default'): JobFlowStep {
  return { queue, name, payload: null, options: {} };
}

const SKEW: AttemptOutcome = Object.freeze({
  kind: 'released',
  reason: 'unknown_job',
  delayMs: 500,
});

function followUps(outcome: AttemptOutcome) {
  assert.equal(outcome.kind, 'completed');
  return outcome.kind === 'completed' ? (outcome.followUps ?? []) : [];
}

function status(failed: number, settled = true): BatchStatus {
  return {
    total: 3,
    completed: 3 - failed,
    failed,
    skipped: 0,
    pending: settled ? 0 : 1,
    settled,
    retriedAfterSettlement: 0,
  };
}

function run(payload: unknown, transport: FlowRecorder) {
  const envelope = buildEnvelope({
    name: BATCH_FINALIZER_JOB,
    payload,
    options: FINALIZER_OPTIONS,
    context: { trace: 't' },
    dispatchedAt: 0,
  });
  return runBatchFinalizer({
    envelope,
    transport,
    queues: queuesOf('default'),
    clock: new VirtualClock(NOW),
    summaryOptions: { storeMessages: false },
    skew: SKEW,
  });
}

const ALL: FinalizerPayload = {
  id: 'b1',
  total: 3,
  then: step('on-then'),
  catch: step('on-catch'),
  finally: step('on-finally'),
};

describe('batch finalizer', () => {
  test('its envelope is the reserved job with its own options and the context', () => {
    const envelope = finalizerEnvelope(ALL, { trace: 'x' }, 5);
    assert.equal(envelope.name, BATCH_FINALIZER_JOB);
    assert.deepEqual(envelope.options, FINALIZER_OPTIONS);
    assert.deepEqual(envelope.meta, { context: { trace: 'x' }, dispatchedAt: 5 });
    assert.deepEqual(finalizerEnvelope(ALL, undefined, 5).meta, { dispatchedAt: 5 });
  });

  test('its payload decodes strictly', () => {
    assert.deepEqual(decodeFinalizerPayload(JSON.parse(JSON.stringify(ALL))), ALL);
    assert.deepEqual(decodeFinalizerPayload({ id: 'b', total: 100_000 }), {
      id: 'b',
      total: 100_000,
    });
    for (const value of [
      null,
      [],
      'b',
      { id: 'b', total: 1, extra: 1 },
      { id: 'a b', total: 1 },
      { id: 'b', total: 0 },
      { id: 'b', total: 100_001 },
      { id: 'b', total: 1.5 },
      { id: 'b', total: '1' },
      { id: 'b', total: 1, then: { name: 'x' } },
    ]) {
      assert.equal(decodeFinalizerPayload(value), undefined, JSON.stringify(value));
    }
  });

  test('a batch without failures completes with then and finally as keyed follow-ups', async () => {
    const transport = new FlowRecorder();
    transport.status = status(0);
    const callbacks = followUps(await run(ALL, transport));
    assert.deepEqual(
      callbacks.map(({ queue, envelope }) => [
        queue,
        envelope.name,
        envelope.meta.key,
        envelope.meta.flow,
      ]),
      [
        [
          'default',
          'on-then',
          'jsails:batch:b1:then',
          { kind: 'callback', flow: 'batch', id: 'b1', callback: 'then' },
        ],
        [
          'default',
          'on-finally',
          'jsails:batch:b1:finally',
          { kind: 'callback', flow: 'batch', id: 'b1', callback: 'finally' },
        ],
      ],
    );
    assert.deepEqual(callbacks[0]!.envelope.meta.context, { trace: 't' });
    assert.equal(callbacks[0]!.envelope.meta.dispatchedAt, NOW);
    assert.equal(transport.enqueued.length, 0, 'the finalizer enqueues nothing itself');
  });

  test('a batch with a failure completes with catch and finally; absent callbacks are skipped', async () => {
    const transport = new FlowRecorder();
    transport.status = status(1);
    assert.deepEqual(
      followUps(await run(ALL, transport)).map(({ envelope }) => envelope.name),
      ['on-catch', 'on-finally'],
    );
    const bare = new FlowRecorder();
    bare.status = status(1);
    assert.deepEqual(await run({ id: 'b1', total: 3 }, bare), { kind: 'completed' });
  });

  test('a callback on a queue this worker does not declare leaves the finalizer, enqueueing none', async () => {
    const transport = new FlowRecorder();
    transport.status = status(0);
    const skewed = { ...ALL, finally: step('on-finally', 'notify') };
    assert.equal(await run(skewed, transport), SKEW, 'then is not enqueued without finally');
    assert.equal(transport.enqueued.length, 0);
    const unused = { ...ALL, catch: step('on-catch', 'notify') };
    assert.equal(followUps(await run(unused, transport)).length, 2, 'only the callbacks it fires');
  });

  test('refuses for good without flows, with a malformed payload, or for a missing batch', async () => {
    const failure = async (payload: unknown, transport: FlowRecorder) => {
      const outcome = await run(payload, transport);
      assert.equal(outcome.kind, 'failed');
      return outcome.kind === 'failed' ? [outcome.error.code, outcome.retryable] : [];
    };
    assert.deepEqual(await failure(ALL, new FlowRecorder({ flows: false })), [
      'jobs.capability_missing',
      false,
    ]);
    assert.deepEqual(await failure({ id: 'b1' }, new FlowRecorder()), [
      'jobs.invalid_envelope',
      false,
    ]);
    assert.deepEqual(await failure(ALL, new FlowRecorder()), ['jobs.flow_missing', false]);
    const unsettled = new FlowRecorder();
    unsettled.status = status(0, false);
    assert.deepEqual(await failure(ALL, unsettled), ['jobs.flow_missing', true]);
    assert.equal(unsettled.enqueued.length, 0);
  });

  test('a status read failure becomes a summarized retryable failure with no follow-ups', async () => {
    const broken = new FlowRecorder();
    broken.status = new Error('connection reset');
    const outcome = await run(ALL, broken);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.retryable, true);
    assert.equal(outcome.kind === 'failed' && outcome.followUps, undefined);
    assert.equal(JSON.stringify(outcome).includes('connection reset'), false);
  });
});
