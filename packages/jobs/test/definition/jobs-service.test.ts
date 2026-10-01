/**
 * The producer: a dispatch validates the call, its options and its payload,
 * builds the envelope with framework metadata only, and enqueues it on the
 * job's queue; every refusal is value-free and enqueues nothing.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import type { JobEnvelope, JobHandle, JobsAdapter } from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import { defineJob } from '../../src/definition/define-job.js';
import { JobDispatchError } from '../../src/definition/definition-error.js';
import { createProducer, type ProducerOptions } from '../../src/definition/jobs-service.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const NOW = 1_700_000_000_000;

/** An adapter that records what it is asked to enqueue. */
function recordingAdapter(): JobsAdapter & {
  readonly enqueued: { queue: string; envelope: JobEnvelope }[];
} {
  const enqueued: { queue: string; envelope: JobEnvelope }[] = [];
  return {
    name: 'recording',
    reach: 'process',
    capabilities: {},
    enqueued,
    enqueue(queue, envelope): Promise<JobHandle> {
      enqueued.push({ queue, envelope });
      return Promise.resolve({ id: String(enqueued.length), deduplicated: false });
    },
    startWorker: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
}

const Report = defineJob({
  name: 'report',
  schema: z.object({ id: z.number(), format: z.enum(['pdf', 'csv']).default('pdf') }),
  queue: 'reports',
  attempts: 4,
  handle: () => undefined,
});

const Keyed = defineJob({
  name: 'keyed',
  schema: z.object({ id: z.number() }).transform((value) => ({ ...value, doubled: value.id * 2 })),
  key: (payload) => `keyed:${payload.doubled}`,
  keyWindowMs: 60_000,
  handle: () => undefined,
});

const Plain = defineJob({ name: 'plain', schema: z.unknown(), handle: () => undefined });

function setup(overrides: Partial<ProducerOptions> = {}) {
  const adapter = recordingAdapter();
  const clock = new VirtualClock(NOW);
  const catalog = createJobCatalog({
    queues: defineQueues({ reports: {} }),
    definitions: [Report, Keyed, Plain],
  });
  const producer = createProducer({ catalog, adapter, clock, ...overrides });
  return { adapter, producer, clock };
}

function refused(code: string) {
  return (error: unknown) => error instanceof JobDispatchError && error.code === code;
}

describe('producer', () => {
  test('a dispatch enqueues the envelope on the job queue with resolved options', async () => {
    const { adapter, producer } = setup();
    const handle = await producer.dispatch(Report.with({ id: 1 }));
    assert.deepEqual(handle, { id: '1', deduplicated: false });
    assert.equal(adapter.enqueued.length, 1);
    const { queue, envelope } = adapter.enqueued[0]!;
    assert.equal(queue, 'reports');
    assert.deepEqual(envelope, {
      v: 1,
      name: 'report',
      payload: { id: 1 },
      options: { attempts: 4, backoff: { type: 'exponential', delayMs: 1_000 } },
      meta: { dispatchedAt: NOW },
    });
  });

  test('the stored payload is the schema input, not its output', async () => {
    const { adapter, producer } = setup();
    await producer.dispatch(Keyed.with({ id: 3 }));
    assert.deepEqual(adapter.enqueued[0]!.envelope.payload, { id: 3 });
  });

  test('the definition key is computed from the parsed payload, with its window', async () => {
    const { adapter, producer } = setup();
    await producer.dispatch(Keyed.with({ id: 3 }));
    assert.equal(adapter.enqueued[0]!.envelope.meta.key, 'keyed:6');
    assert.equal(adapter.enqueued[0]!.envelope.meta.keyWindowMs, 60_000);
  });

  test('a dispatch key overrides the definition key; dispatch options override call options', async () => {
    const { adapter, producer } = setup();
    await producer.dispatch(Keyed.with({ id: 3 }, { key: 'call', priority: 1 }), {
      key: 'dispatch',
      keyWindowMs: 5_000,
      attempts: 2,
    });
    const { meta, options } = adapter.enqueued[0]!.envelope;
    assert.equal(meta.key, 'dispatch');
    assert.equal(meta.keyWindowMs, 5_000);
    assert.equal(options.priority, 1);
    assert.equal(options.attempts, 2);
  });

  test('a key without a window gets one day', async () => {
    const { adapter, producer } = setup();
    await producer.dispatch(Plain.with(1, { key: 'k' }));
    assert.equal(adapter.enqueued[0]!.envelope.meta.keyWindowMs, 86_400_000);
  });

  test('delays, run times and tags land in meta; a past run time runs at once', async () => {
    const { adapter, producer } = setup();
    await producer.dispatch(Plain.with(1, { delayMs: 30 * 86_400_000, tags: ['a', 'b'] }));
    await producer.dispatch(Plain.with(1, { runAt: new Date(NOW + 5_000) }));
    await producer.dispatch(Plain.with(1, { runAt: new Date(NOW - 5_000) }));
    await producer.dispatch(Plain.with(1, { delayMs: 0 }));
    const metas = adapter.enqueued.map((entry) => entry.envelope.meta);
    assert.equal(metas[0]!.runAt, NOW + 30 * 86_400_000);
    assert.deepEqual(metas[0]!.tags, ['a', 'b']);
    assert.equal(metas[1]!.runAt, NOW + 5_000);
    assert.equal('runAt' in metas[2]!, false);
    assert.equal('runAt' in metas[3]!, false);
  });

  test('the execution context is read at each dispatch and carried in meta', async () => {
    let request = 0;
    const { adapter, producer } = setup({ context: () => ({ requestId: `r${++request}` }) });
    await producer.dispatch(Plain.with(1));
    await producer.dispatch(Plain.with(2));
    assert.deepEqual(
      adapter.enqueued.map((entry) => entry.envelope.meta.context),
      [{ requestId: 'r1' }, { requestId: 'r2' }],
    );
  });

  test('dispatchByName validates the payload at runtime', async () => {
    const { adapter, producer } = setup();
    await producer.dispatchByName('report', { id: 9, format: 'csv' });
    assert.deepEqual(adapter.enqueued[0]!.envelope.payload, { id: 9, format: 'csv' });
    await assert.rejects(
      producer.dispatchByName('report', { id: 'nine' }),
      refused('invalid_payload'),
    );
    await assert.rejects(producer.dispatchByName('missing', {}), refused('unknown_job'));
    assert.equal(adapter.enqueued.length, 1);
  });

  test('a call of a definition the catalog does not hold is refused', async () => {
    const { adapter, producer } = setup();
    const Stranger = defineJob({
      name: 'report',
      schema: z.unknown(),
      queue: 'reports',
      handle: () => undefined,
    });
    await assert.rejects(producer.dispatch(Stranger.with(1)), refused('unknown_job'));
    const Unregistered = defineJob({ name: 'other', schema: z.unknown(), handle: () => undefined });
    await assert.rejects(producer.dispatch(Unregistered.with(1)), refused('unknown_job'));
    await assert.rejects(producer.dispatch(null as never), refused('unknown_job'));
    assert.equal(adapter.enqueued.length, 0);
  });

  const refusedOptions: readonly [string, string, Record<string, unknown>][] = [
    ['an unknown option', 'unknown_option', { delay: 5 }],
    ['a BullMQ option name', 'unknown_option', { jobId: 'x' }],
    ['a reserved framework key', 'unknown_option', { meta: {} }],
    ['delayMs and runAt together', 'invalid_option', { delayMs: 1, runAt: new Date(NOW + 1) }],
    ['a negative delay', 'invalid_option', { delayMs: -1 }],
    ['a delay above a year', 'invalid_option', { delayMs: 366 * 86_400_000 }],
    [
      'a run time above a year ahead',
      'invalid_option',
      { runAt: new Date(NOW + 366 * 86_400_000) },
    ],
    ['an invalid Date', 'invalid_option', { runAt: new Date(Number.NaN) }],
    ['a run time that is not a Date', 'invalid_option', { runAt: NOW + 1 }],
    ['an empty key', 'invalid_option', { key: '' }],
    ['an overlong key', 'invalid_option', { key: 'k'.repeat(513) }],
    ['a window without a key', 'invalid_option', { keyWindowMs: 1_000 }],
    ['a zero window', 'invalid_option', { key: 'k', keyWindowMs: 0 }],
    ['an empty tag', 'invalid_option', { tags: [''] }],
    ['33 tags', 'invalid_option', { tags: Array.from({ length: 33 }, (_, index) => `t${index}`) }],
    ['zero attempts', 'invalid_option', { attempts: 0 }],
    ['a bad backoff', 'invalid_option', { backoff: { type: 'fixed' } }],
    ['a fractional priority', 'invalid_option', { priority: 0.5 }],
  ];

  for (const [label, code, options] of refusedOptions) {
    test(`a dispatch with ${label} is refused with ${code} and enqueues nothing`, async () => {
      const { adapter, producer } = setup();
      await assert.rejects(producer.dispatch(Plain.with(1), options), refused(code));
      assert.equal(adapter.enqueued.length, 0);
    });
  }

  test('options that are not an object are refused', async () => {
    const { producer } = setup();
    await assert.rejects(
      producer.dispatch(Plain.with(1), 'fast' as never),
      refused('invalid_option'),
    );
  });

  test('a payload that is not plain JSON is refused even when the schema accepts it', async () => {
    const { adapter, producer } = setup();
    await assert.rejects(producer.dispatch(Plain.with(new Date(0))), refused('payload_not_json'));
    await assert.rejects(producer.dispatch(Plain.with(undefined)), refused('payload_not_json'));
    assert.equal(adapter.enqueued.length, 0);
  });

  test('the stored payload is the snapshot that was validated, whatever the caller does meanwhile', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const Gated = defineJob({
      name: 'gated',
      schema: z.object({ amount: z.number().max(10) }).refine(async () => {
        await gate;
        return true;
      }),
      handle: () => undefined,
    });
    const adapter = recordingAdapter();
    const producer = createProducer({
      catalog: createJobCatalog({ queues: defineQueues({}), definitions: [Gated] }),
      adapter,
    });
    const payload = { amount: 5 };
    const pending = producer.dispatch(Gated.with(payload));
    payload.amount = 1_000_000;
    release();
    await pending;
    assert.deepEqual(adapter.enqueued[0]?.envelope.payload, { amount: 5 });
  });

  test('a context that is not plain JSON is refused', async () => {
    const { producer } = setup({ context: () => new Map() });
    await assert.rejects(producer.dispatch(Plain.with(1)), refused('context_not_json'));
  });

  test('a definition key function that throws or returns a non-key is refused', async () => {
    const Throwing = defineJob({
      name: 'throwing',
      schema: z.unknown(),
      key: () => {
        throw new Error('secret');
      },
      handle: () => undefined,
    });
    const Empty = defineJob({
      name: 'empty',
      schema: z.unknown(),
      key: () => '',
      handle: () => undefined,
    });
    const adapter = recordingAdapter();
    const producer = createProducer({
      catalog: createJobCatalog({ queues: defineQueues({}), definitions: [Throwing, Empty] }),
      adapter,
    });
    await assert.rejects(
      producer.dispatch(Throwing.with(1)),
      (error: unknown) =>
        refused('invalid_option')(error) && !(error as Error).message.includes('secret'),
    );
    await assert.rejects(producer.dispatch(Empty.with(1)), refused('invalid_option'));
    assert.equal(adapter.enqueued.length, 0);
  });

  test('refusals never echo the payload or the key', async () => {
    const { producer } = setup();
    const marker = 'MARKER-7f3a';
    const errors: unknown[] = [];
    for (const attempt of [
      () => producer.dispatchByName('report', { id: marker }),
      () => producer.dispatchByName(marker, {}),
      () => producer.dispatch(Plain.with(1), { key: marker, keyWindowMs: -1 }),
      () => producer.dispatch(Plain.with(1), { [marker]: 1 } as never),
    ]) {
      await attempt().then(
        () => assert.fail('the dispatch was accepted'),
        (error: unknown) => errors.push(error),
      );
    }
    for (const error of errors) {
      assert.ok(error instanceof JobDispatchError);
      assert.equal(
        JSON.stringify({ message: error.message, context: error.context }).includes(marker),
        false,
      );
    }
  });

  test('a closed producer refuses dispatches', async () => {
    const { adapter, producer } = setup();
    assert.equal(producer.closed, false);
    producer.close();
    producer.close();
    assert.equal(producer.closed, true);
    await assert.rejects(producer.dispatch(Plain.with(1)), refused('producer_closed'));
    assert.equal(adapter.enqueued.length, 0);
  });

  test('a producer closed while a payload is validated enqueues nothing', async () => {
    const Slow = defineJob({
      name: 'slow',
      schema: z.unknown().refine(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return true;
      }),
      handle: () => undefined,
    });
    const adapter = recordingAdapter();
    const producer = createProducer({
      catalog: createJobCatalog({ queues: defineQueues({}), definitions: [Slow] }),
      adapter,
    });
    const pending = producer.dispatch(Slow.with(1));
    producer.close();
    await assert.rejects(pending, refused('producer_closed'));
    assert.equal(adapter.enqueued.length, 0);
  });
});
