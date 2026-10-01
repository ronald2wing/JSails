/**
 * The producer's flows: a chain is validated whole and only its head
 * enqueued, carrying the later steps and the catch; a batch hands every
 * child and the finalizer to the flows capability in one call; a refused
 * item names its index and enqueues nothing; and the caps, ids, options and
 * capability checks. Overlap reaches a dispatched envelope as its lease key.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createExecutionContext, runInContext } from 'jsails/context';
import { z } from 'zod';

import type {
  BatchEnqueue,
  BatchStatus,
  JobEnvelope,
  JobHandle,
  JobsAdapter,
  LeaseCapability,
} from '../../src/contract/index.js';
import { createJobCatalog } from '../../src/definition/catalog.js';
import { defineJob, type JobCall } from '../../src/definition/define-job.js';
import { createProducer } from '../../src/definition/jobs-service.js';
import { JobsErrors, type JobsErrorCode } from '../../src/errors/jobs-errors.js';
import { BATCH_FINALIZER_JOB } from '../../src/flows/batch-finalizer.js';
import {
  FLOW_KEY_WINDOW_MS,
  MAX_BATCH_ITEMS,
  MAX_CHAIN_STEPS,
  MAX_FLOW_BYTES,
} from '../../src/flows/flow-limits.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const NOW = 1_700_000_000_000;

type Recording = JobsAdapter & {
  readonly enqueued: { queue: string; envelope: JobEnvelope }[];
  readonly batches: BatchEnqueue[];
};

function recordingAdapter(options: { flows?: boolean; leases?: boolean } = {}): Recording {
  const enqueued: { queue: string; envelope: JobEnvelope }[] = [];
  const batches: BatchEnqueue[] = [];
  const status: BatchStatus = {
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    settled: true,
    retriedAfterSettlement: 0,
  };
  return {
    name: 'recording',
    reach: 'process',
    capabilities: {
      ...(options.flows === false
        ? {}
        : {
            flows: {
              enqueueBatch: (batch) => {
                const deduplicated = batches.some((seen) => seen.id === batch.id);
                batches.push(batch);
                return Promise.resolve({ deduplicated });
              },
              batchStatus: (id) => Promise.resolve(id === 'known' ? status : undefined),
              childFailures: (_id, limit) =>
                Promise.resolve(
                  Array.from({ length: Math.min(limit, 2) }, (_, index) => ({
                    index,
                    name: 'child',
                    error: { name: 'Error', kind: 'internal' as const },
                  })),
                ),
            },
          }),
      ...(options.leases === true ? { leases: {} as LeaseCapability } : {}),
    },
    enqueued,
    batches,
    enqueue(queue, envelope): Promise<JobHandle> {
      enqueued.push({ queue, envelope });
      return Promise.resolve({ id: String(enqueued.length), deduplicated: false });
    },
    startWorker: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
}

const Step = defineJob({
  name: 'step',
  schema: z.object({ n: z.number() }),
  queue: 'work',
  attempts: 3,
  handle: () => undefined,
});
const Callback = defineJob({ name: 'callback', schema: z.unknown(), handle: () => undefined });
const Locked = defineJob({
  name: 'locked',
  schema: z.object({ tenant: z.string() }),
  overlap: { key: (payload) => `tenant:${payload.tenant}`, ttlMs: 2_000 },
  handle: () => undefined,
});

function setup(options: { flows?: boolean; leases?: boolean; overlap?: boolean } = {}) {
  const adapter = recordingAdapter(options);
  const clock = new VirtualClock(NOW);
  const catalog = createJobCatalog({
    queues: defineQueues({ work: {} }),
    definitions: options.overlap === true ? [Step, Callback, Locked] : [Step, Callback],
  });
  const producer = createProducer({ catalog, adapter, clock });
  return { adapter, producer, clock };
}

function refused(code: JobsErrorCode) {
  return (error: unknown) => JobsErrors.is(error, code);
}

function flowRule(rule: string) {
  return (error: unknown) => JobsErrors.is(error, 'invalid_flow') && error.context.rule === rule;
}

function itemRefused(item: number, cause: JobsErrorCode) {
  return (error: unknown) =>
    JobsErrors.is(error, 'flow_item_refused') &&
    error.context.item === item &&
    JobsErrors.is((error as Error).cause, cause);
}

const steps = (count: number): [JobCall, ...JobCall[]] =>
  Array.from({ length: count }, (_, n) => Step.with({ n })) as [JobCall, ...JobCall[]];

describe('producer chains', () => {
  test('enqueues only the head, keyed, carrying the later steps and the catch', async () => {
    const { adapter, producer } = setup();
    const handle = await producer.chain(
      [Step.with({ n: 1 }, { tags: ['a'] }), Step.with({ n: 2 }, { attempts: 5 })],
      { catch: Callback.with({ failed: true }), id: 'order-7' },
    );
    assert.deepEqual(handle, { id: '1', deduplicated: false, chain: 'order-7' });
    assert.equal(adapter.enqueued.length, 1);
    const { queue, envelope } = adapter.enqueued[0]!;
    assert.equal(queue, 'work');
    assert.deepEqual(envelope.payload, { n: 1 });
    assert.deepEqual(envelope.meta, {
      key: 'jsails:chain:order-7:0',
      keyWindowMs: FLOW_KEY_WINDOW_MS,
      tags: ['a'],
      flow: {
        kind: 'chain',
        id: 'order-7',
        step: 0,
        next: [
          {
            queue: 'work',
            name: 'step',
            payload: { n: 2 },
            options: { attempts: 5, backoff: { type: 'exponential', delayMs: 1_000 } },
          },
        ],
        catch: {
          queue: 'default',
          name: 'callback',
          payload: { failed: true },
          options: { attempts: 3, backoff: { type: 'exponential', delayMs: 1_000 } },
        },
      },
      dispatchedAt: NOW,
    });
  });

  test('takes 1 to 100 steps; a random id by default', async () => {
    const { adapter, producer } = setup();
    const one = await producer.chain(steps(1));
    assert.match(one.chain, /^[0-9a-f-]{36}$/);
    await producer.chain(steps(MAX_CHAIN_STEPS));
    assert.equal(adapter.enqueued.length, 2);
    await assert.rejects(producer.chain([] as never), flowRule('empty'));
    await assert.rejects(producer.chain(steps(MAX_CHAIN_STEPS + 1)), flowRule('too_many_steps'));
    await assert.rejects(producer.chain('x' as never), flowRule('shape'));
    assert.equal(adapter.enqueued.length, 2);
  });

  test('captures the execution context once, on the head', async () => {
    const { adapter, producer } = setup();
    await runInContext(createExecutionContext({ requestId: 'req-1' }), () =>
      producer.chain(steps(2)),
    );
    const { context } = adapter.enqueued[0]!.envelope.meta;
    assert.equal((context as { requestId?: string } | undefined)?.requestId, 'req-1');
  });

  test('a refused step or catch names its index and enqueues nothing', async () => {
    const { adapter, producer } = setup();
    await assert.rejects(
      producer.chain([Step.with({ n: 1 }), Step.with({ n: 'x' } as never)]),
      itemRefused(1, 'invalid_payload'),
    );
    await assert.rejects(
      producer.chain(steps(2), { catch: Callback.with(new Date(0)) }),
      itemRefused(2, 'payload_not_json'),
    );
    await assert.rejects(
      producer.chain([Step.with({ n: 1 }, { delayMs: 5 })]),
      itemRefused(0, 'invalid_option'),
    );
    for (const option of [{ runAt: new Date(NOW) }, { key: 'k' }, { keyWindowMs: 5 }]) {
      await assert.rejects(
        producer.chain([Step.with({ n: 1 }, option)]),
        itemRefused(0, 'invalid_option'),
      );
    }
    await assert.rejects(
      producer.chain([Step.with({ n: 1 }, { nope: 1 } as never)]),
      itemRefused(0, 'unknown_option'),
    );
    const Unknown = defineJob({ name: 'unknown', schema: z.unknown(), handle: () => undefined });
    await assert.rejects(producer.chain([Unknown.with(null)]), itemRefused(0, 'unknown_job'));
    assert.equal(adapter.enqueued.length, 0);
  });

  test('refuses bad options, an oversized chain, and a closed producer', async () => {
    const { adapter, producer } = setup();
    await assert.rejects(producer.chain(steps(1), null as never), refused('invalid_option'));
    await assert.rejects(producer.chain(steps(1), { then: 1 } as never), refused('unknown_option'));
    await assert.rejects(producer.chain(steps(1), { id: 'has space' }), flowRule('id'));
    await assert.rejects(producer.chain(steps(1), { catch: 'x' as never }), flowRule('callback'));
    const big = 'x'.repeat(MAX_FLOW_BYTES);
    await assert.rejects(
      producer.chain([Step.with({ n: 1 }), Callback.with(big)]),
      refused('flow_too_large'),
    );
    producer.close();
    await assert.rejects(producer.chain(steps(1)), refused('producer_closed'));
    assert.equal(adapter.enqueued.length, 0);
  });
});

describe('producer batches', () => {
  test('hands every child and the finalizer to the flows capability in one call', async () => {
    const { adapter, producer } = setup();
    const handle = await producer.batch(
      [Step.with({ n: 1 }), Step.with({ n: 2 }, { tags: ['t'] })],
      {
        then: Callback.with('then'),
        finally: Callback.with('finally'),
        id: 'import-3',
        queue: 'work',
      },
    );
    assert.deepEqual(handle, { id: 'import-3', total: 2, deduplicated: false });
    assert.equal(adapter.enqueued.length, 0);
    const [batch] = adapter.batches;
    assert.equal(batch?.id, 'import-3');
    assert.equal(batch?.chunked, false);
    assert.deepEqual(
      batch?.children.map(({ queue, envelope }) => [queue, envelope.meta.key, envelope.meta.flow]),
      [
        ['work', 'jsails:batch:import-3:0', { kind: 'batch', id: 'import-3', index: 0 }],
        ['work', 'jsails:batch:import-3:1', { kind: 'batch', id: 'import-3', index: 1 }],
      ],
    );
    assert.deepEqual(batch?.children[1]?.envelope.meta.tags, ['t']);
    assert.equal(batch?.finalizer.queue, 'work');
    assert.equal(batch?.finalizer.envelope.name, BATCH_FINALIZER_JOB);
    const payload = batch?.finalizer.envelope.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ['finally', 'id', 'then', 'total']);
    assert.equal(payload.total, 2);
  });

  test('a reissued id deduplicates; the finalizer runs on default unless a queue is named', async () => {
    const { adapter, producer } = setup();
    await producer.batch([Step.with({ n: 1 })], { id: 'b' });
    const again = await producer.batch([Step.with({ n: 1 })], { id: 'b' });
    assert.equal(again.deduplicated, true);
    assert.equal(adapter.batches[0]?.finalizer.queue, 'default');
    const random = await producer.batch([Step.with({ n: 1 })]);
    assert.match(random.id, /^[0-9a-f-]{36}$/);
  });

  test('takes up to 1,000 items, or 100,000 chunked under a caller id', async () => {
    const { adapter, producer } = setup();
    const items = (count: number) => Array.from({ length: count }, (_, n) => Step.with({ n }));
    await producer.batch(items(MAX_BATCH_ITEMS));
    await assert.rejects(producer.batch(items(MAX_BATCH_ITEMS + 1)), flowRule('too_many_items'));
    await assert.rejects(
      producer.batch(items(MAX_BATCH_ITEMS + 1), { chunked: true }),
      flowRule('chunked_id'),
    );
    await producer.batch(items(MAX_BATCH_ITEMS + 1), { chunked: true, id: 'big' });
    assert.equal(adapter.batches.at(-1)?.chunked, true);
    await assert.rejects(producer.batch([]), flowRule('empty'));
    await assert.rejects(producer.batch('x' as never), flowRule('shape'));
    await assert.rejects(
      producer.batch(items(1), { chunked: 'yes' as never }),
      refused('invalid_option'),
    );
  });

  test('an invalid item enqueues nothing and names its index; callbacks follow the items', async () => {
    const { adapter, producer } = setup();
    await assert.rejects(
      producer.batch([Step.with({ n: 1 }), Step.with({ n: 'x' } as never)]),
      itemRefused(1, 'invalid_payload'),
    );
    await assert.rejects(
      producer.batch([Step.with({ n: 1 })], { catch: Callback.with(new Date(0)) }),
      itemRefused(2, 'payload_not_json'),
    );
    assert.deepEqual([adapter.batches.length, adapter.enqueued.length], [0, 0]);
  });

  test('refuses an undeclared queue, bad options, an oversized finalizer, and a closed producer', async () => {
    const { adapter, producer } = setup();
    await assert.rejects(
      producer.batch([Step.with({ n: 1 })], { queue: 'nope' }),
      flowRule('queue'),
    );
    await assert.rejects(
      producer.batch([Step.with({ n: 1 })], { queue: 7 as never }),
      flowRule('queue'),
    );
    await assert.rejects(producer.batch([Step.with({ n: 1 })], { id: '' }), flowRule('id'));
    await assert.rejects(
      producer.batch([Step.with({ n: 1 })], { then: null as never }),
      flowRule('callback'),
    );
    await assert.rejects(
      producer.batch([Step.with({ n: 1 })], { delayMs: 1 } as never),
      refused('unknown_option'),
    );
    await assert.rejects(
      producer.batch([Step.with({ n: 1 })], { then: Callback.with('x'.repeat(MAX_FLOW_BYTES)) }),
      refused('flow_too_large'),
    );
    producer.close();
    await assert.rejects(producer.batch([Step.with({ n: 1 })]), refused('producer_closed'));
    assert.equal(adapter.batches.length, 0);
  });

  test('needs the flows capability', async () => {
    const { producer } = setup({ flows: false });
    for (const call of [
      () => producer.batch([Step.with({ n: 1 })]),
      () => producer.batchStatus('b'),
      () => producer.batchFailures('b'),
    ]) {
      await assert.rejects(
        call(),
        (error: unknown) =>
          JobsErrors.is(error, 'capability_missing') && error.context.capability === 'flows',
      );
    }
  });

  test('batchStatus and batchFailures read the capability within their limits', async () => {
    const { producer } = setup();
    assert.equal((await producer.batchStatus('known'))?.settled, true);
    assert.equal(await producer.batchStatus('unknown'), undefined);
    assert.equal(await producer.batchStatus('not an id'), undefined);
    assert.equal((await producer.batchFailures('known')).length, 2);
    assert.equal((await producer.batchFailures('known', { limit: 1 })).length, 1);
    assert.deepEqual(await producer.batchFailures('not an id'), []);
    for (const limit of [0, 101, 1.5]) {
      await assert.rejects(producer.batchFailures('known', { limit }), refused('invalid_option'));
    }
    await assert.rejects(
      producer.batchFailures('known', { other: 1 } as never),
      refused('unknown_option'),
    );
    producer.close();
    await assert.rejects(producer.batchStatus('known'), refused('producer_closed'));
    await assert.rejects(producer.batchFailures('known'), refused('producer_closed'));
  });
});

describe('producer overlap', () => {
  test('a job with overlap needs leases, and its dispatch carries the lease key', async () => {
    assert.throws(
      () => setup({ overlap: true }),
      (error: unknown) =>
        JobsErrors.is(error, 'capability_missing') && error.context.capability === 'leases',
    );
    const { adapter, producer } = setup({ overlap: true, leases: true });
    await producer.dispatch(Locked.with({ tenant: 'acme' }));
    assert.deepEqual(adapter.enqueued[0]?.envelope.meta.overlap, {
      key: 'tenant:acme',
      ttlMs: 2_000,
    });
  });
});
