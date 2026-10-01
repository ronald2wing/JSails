/**
 * The memory adapter's capabilities: failed jobs (list order and cursor,
 * get, every retry result, concurrent retries, remove and prune), the
 * settle-time `catchFired` rewrite and `drop`, `SettleEvent.failedJob`
 * (absent when retention evicts the job at once), follow-ups stored in the
 * settle (keyed, checked, ignored on a failure that is not final), batches
 * (whole-batch checks, dedupe and conflict, a taken child key, the finalizer
 * held until every child settles, status and child failures), the redeliver
 * and evict test hooks, and the schedule ticker running while a worker runs.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PROCESSOR_BROKE_CONTRACT,
  type AttemptOutcome,
  type BatchEnqueue,
  type JobEnvelope,
  type JobErrorSummary,
  type JobFollowUp,
  type ProcessJob,
  type SettleEvent,
  type TransportJob,
} from '../../src/contract/index.js';
import { buildEnvelope, type EnvelopeParts } from '../../src/envelope/codec.js';
import { JobsErrors, type JobsErrorCode } from '../../src/errors/jobs-errors.js';
import { BATCH_FINALIZER_JOB, finalizerEnvelope } from '../../src/flows/batch-finalizer.js';
import { MAX_BATCH_ITEMS, MAX_CHUNKED_BATCH_ITEMS } from '../../src/flows/flow-limits.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues, type QueueOptions } from '../../src/queues/queue-set.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';

const START = 1_700_000_000_000;
const ERROR: JobErrorSummary = { name: 'Error', kind: 'internal' };
const FAILED: AttemptOutcome = { kind: 'failed', error: ERROR, retryable: false };

/** A follow-up of job `name` on `queue`, keyed `key` for a day. */
function followUp(name: string, key: string, queue = 'default'): JobFollowUp {
  return {
    queue,
    envelope: buildEnvelope({
      name,
      payload: null,
      options: {},
      key: { value: key, windowMs: 86_400_000 },
      dispatchedAt: START,
    }),
  };
}

function setup(queues: Readonly<Record<string, QueueOptions>> = { mail: {} }) {
  const clock = new VirtualClock(START);
  const adapter = new MemoryJobsAdapter(
    { namespace: 'app:test', queues: defineQueues(queues).declarations },
    { clock },
  );
  const envelope = (overrides: Partial<EnvelopeParts> = {}): JobEnvelope =>
    buildEnvelope({
      name: 'job',
      payload: null,
      options: {},
      dispatchedAt: clock.now(),
      ...overrides,
    });
  return {
    clock,
    adapter,
    envelope,
    failedJobs: adapter.capabilities.failedJobs!,
    flows: adapter.capabilities.flows!,
  };
}

/** A worker answering with `outcome` and recording deliveries and settles. */
async function work(
  adapter: MemoryJobsAdapter,
  outcome: (job: TransportJob) => AttemptOutcome = () => ({ kind: 'completed' }),
  queues: readonly string[] = ['default'],
) {
  const deliveries: TransportJob[] = [];
  const settles: SettleEvent[] = [];
  const process: ProcessJob = async (job) => {
    deliveries.push(job);
    return outcome(job);
  };
  const worker = await adapter.startWorker(
    { queues, onSettle: (event) => settles.push(event) },
    process,
  );
  return { worker, deliveries, settles };
}

async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await flush();
}

function code(name: JobsErrorCode) {
  return (error: unknown) => JobsErrors.is(error, name);
}

function flowRule(rule: string) {
  return (error: unknown) => JobsErrors.is(error, 'invalid_flow') && error.context.rule === rule;
}

/** A batch of `count` children on `default` with a finalizer on `default`. */
function batchOf(
  envelope: ReturnType<typeof setup>['envelope'],
  id: string,
  count: number,
  chunked = false,
): BatchEnqueue {
  return {
    id,
    children: Array.from({ length: count }, (_, index) => ({
      queue: 'default',
      envelope: envelope({ payload: index, flow: { kind: 'batch', id, index } }),
    })),
    finalizer: {
      queue: 'default',
      envelope: finalizerEnvelope({ id, total: count }, undefined, 0),
    },
    chunked,
  };
}

describe('memory capabilities: failed jobs', () => {
  test('lists newest first, by queue, with a limit and a cursor; gets one', async () => {
    const { adapter, envelope, clock, failedJobs } = setup();
    await work(adapter, () => FAILED, ['default', 'mail']);
    for (const [queue, payload] of [
      ['default', 'a'],
      ['mail', 'b'],
      ['default', 'c'],
    ] as const) {
      await adapter.enqueue(queue, envelope({ payload }));
      await settle();
      await clock.advance(1_000);
    }
    const all = await failedJobs.list();
    assert.deepEqual(
      all.map((job) => [job.envelope.payload, job.queue, job.failedAt]),
      [
        ['c', 'default', START + 2_000],
        ['b', 'mail', START + 1_000],
        ['a', 'default', START],
      ],
    );
    assert.deepEqual(
      (await failedJobs.list({ queue: 'default' })).map((job) => job.envelope.payload),
      ['c', 'a'],
    );
    const first = (await failedJobs.list({ limit: 1 }))[0]!;
    assert.equal(first.envelope.payload, 'c');
    assert.deepEqual(
      (await failedJobs.list({ before: { failedAt: first.failedAt, id: first.id } })).map(
        (job) => job.envelope.payload,
      ),
      ['b', 'a'],
    );
    assert.deepEqual(await failedJobs.get(first.id), first);
    assert.equal(await failedJobs.get('999'), undefined);
    assert.equal(await failedJobs.get(7 as never), undefined);
    await assert.rejects(failedJobs.list({ queue: 'nope' }), code('unknown_queue'));
    await assert.rejects(failedJobs.list({ limit: 0 }), code('invalid_option'));
  });

  test('retry answers every result', async () => {
    const { adapter, envelope, failedJobs } = setup();
    let fail = true;
    const { deliveries } = await work(adapter, () => (fail ? FAILED : { kind: 'completed' }));
    const failed = await adapter.enqueue('default', envelope({ payload: 'f' }));
    await settle();
    fail = false;
    const done = await adapter.enqueue('default', envelope({ payload: 'ok' }));
    await settle();
    assert.equal(await failedJobs.retry('999'), 'not_found');
    assert.equal(await failedJobs.retry(7 as never), 'not_found');
    assert.equal(await failedJobs.retry(done.id), 'not_failed');
    assert.equal(await failedJobs.retry(failed.id), 'retried');
    assert.equal(await failedJobs.retry(failed.id), 'not_failed');
    await settle();
    assert.equal(deliveries.filter((job) => job.id === failed.id).length, 2);
    assert.equal(deliveries.at(-1)?.attemptsMade, 0, 'a retry starts the attempt count over');
    assert.equal((await failedJobs.list()).length, 0);
    await assert.rejects(
      failedJobs.retry(failed.id, { force: 'yes' } as never),
      code('invalid_option'),
    );
    await assert.rejects(
      failedJobs.retry(failed.id, { other: true } as never),
      code('invalid_option'),
    );
    await assert.rejects(failedJobs.retry(failed.id, null as never), code('invalid_option'));
  });

  test('a job evicted by retention is not found', async () => {
    const { adapter, envelope, clock, failedJobs } = setup({
      default: { retention: { failed: { count: 10, age: '1h' } } },
    });
    await work(adapter, () => FAILED);
    const { id } = await adapter.enqueue('default', envelope());
    await settle();
    await clock.advance(3_600_001);
    assert.equal(await failedJobs.retry(id), 'not_found');
    assert.equal(await failedJobs.get(id), undefined);
  });

  test('50 concurrent retries run the job once', async () => {
    const { adapter, envelope, failedJobs } = setup();
    let runs = 0;
    await work(adapter, () => {
      runs += 1;
      return runs === 1 ? FAILED : { kind: 'completed' };
    });
    const { id } = await adapter.enqueue('default', envelope());
    await settle();
    const results = await Promise.all(Array.from({ length: 50 }, () => failedJobs.retry(id)));
    await settle();
    assert.equal(results.filter((result) => result === 'retried').length, 1);
    assert.equal(runs, 2);
  });

  test('a chain step whose catch fired is retried only when forced', async () => {
    const { adapter, envelope, failedJobs } = setup();
    await work(adapter, (job) =>
      job.envelope.name === 'job'
        ? { ...FAILED, catchFired: true, followUps: [followUp('on-catch', 'jsails:chain:c:catch')] }
        : { kind: 'completed' },
    );
    const { id } = await adapter.enqueue(
      'default',
      envelope({ flow: { kind: 'chain', id: 'c', step: 0, next: [] } }),
    );
    await settle();
    const stored = await failedJobs.get(id);
    assert.deepEqual(stored?.envelope.meta.flow, {
      kind: 'chain',
      id: 'c',
      step: 0,
      next: [],
      catchFired: true,
    });
    assert.equal(await failedJobs.retry(id), 'not_retryable');
    assert.equal(await failedJobs.retry(id, { force: true }), 'retried');
  });

  test('a catchFired flag on a job that is no chain step is ignored', async () => {
    const { adapter, envelope, failedJobs } = setup();
    await work(adapter, (job) =>
      job.envelope.name === 'job'
        ? { ...FAILED, catchFired: true, followUps: [followUp('on-catch', 'jsails:chain:c:catch')] }
        : { kind: 'completed' },
    );
    const { id } = await adapter.enqueue('default', envelope());
    await settle();
    assert.equal((await failedJobs.get(id))?.envelope.meta.flow, undefined);
    assert.equal(await failedJobs.retry(id), 'retried');
  });

  test('a final failure flagged drop is not kept; the settle event says where a kept one is', async () => {
    const { adapter, envelope, failedJobs } = setup();
    let drop = true;
    const { settles } = await work(adapter, () => (drop ? { ...FAILED, drop: true } : FAILED));
    const dropped = await adapter.enqueue('default', envelope());
    await settle();
    drop = false;
    const kept = await adapter.enqueue('default', envelope());
    await settle();
    assert.deepEqual(
      settles.map((event) => [event.job.id, event.final, event.failedJob]),
      [
        [dropped.id, true, undefined],
        [kept.id, true, { id: kept.id, queue: 'default' }],
      ],
    );
    assert.equal(await failedJobs.get(dropped.id), undefined);
    assert.equal(await failedJobs.retry(dropped.id), 'not_found');
    assert.equal(adapter.counts('default').failed, 1);
  });

  test('a final failure that retention evicts at once points at no failed job', async () => {
    const { adapter, envelope, failedJobs } = setup({
      mail: { retention: { failed: { count: 0 } } },
    });
    const { settles } = await work(adapter, () => FAILED, ['mail']);
    const { id } = await adapter.enqueue('mail', envelope());
    await settle();
    assert.deepEqual(
      settles.map((event) => [event.final, event.failedJob]),
      [[true, undefined]],
    );
    assert.equal(await failedJobs.get(id), undefined);
    assert.equal(await failedJobs.retry(id), 'not_found');
  });

  test('a retryable failure is not final and has no failed job', async () => {
    const { adapter, envelope } = setup();
    const { settles } = await work(adapter, () => ({ ...FAILED, retryable: true }));
    await adapter.enqueue('default', envelope({ options: { attempts: 2 } }));
    await settle();
    assert.deepEqual(
      settles.map((event) => [event.final, event.failedJob]),
      [
        [false, undefined],
        [true, { id: '1', queue: 'default' }],
      ],
    );
  });

  test('remove and prune drop failed jobs', async () => {
    const { adapter, envelope, clock, failedJobs } = setup();
    await work(adapter, () => FAILED);
    const old = await adapter.enqueue('default', envelope());
    await settle();
    await clock.advance(10_000);
    const recent = await adapter.enqueue('default', envelope());
    await settle();
    const third = await adapter.enqueue('default', envelope());
    await settle();
    assert.equal(await failedJobs.remove(third.id), true);
    assert.equal(await failedJobs.remove(third.id), false);
    assert.equal(await failedJobs.prune({ olderThanMs: 5_000 }), 1);
    assert.equal(await failedJobs.get(old.id), undefined);
    assert.ok((await failedJobs.get(recent.id)) !== undefined);
    assert.equal(await failedJobs.prune({ olderThanMs: 5_000 }), 0);
    await assert.rejects(failedJobs.prune({} as never), code('invalid_option'));
  });
});

describe('memory capabilities: follow-ups', () => {
  test('a settle stores its follow-ups in the same step, deduplicated by key', async () => {
    const { adapter, envelope } = setup();
    const { deliveries } = await work(adapter, (job) =>
      job.envelope.name === 'step'
        ? { kind: 'completed', followUps: [followUp('next', 'jsails:chain:c:1')] }
        : { kind: 'completed' },
    );
    await adapter.enqueue('default', envelope({ name: 'step' }));
    await adapter.enqueue('default', envelope({ name: 'step' }));
    await settle();
    assert.deepEqual(
      deliveries.map((job) => job.envelope.name),
      ['step', 'step', 'next'],
      'the second follow-up deduplicated against the first',
    );
  });

  test('a skipped or discarded job stores its follow-ups too', async () => {
    const { adapter, envelope } = setup();
    const { deliveries } = await work(adapter, (job) => {
      if (job.envelope.name === 'skip') {
        return { kind: 'skipped', reason: 'overlap', followUps: [followUp('after-skip', 'k1')] };
      }
      if (job.envelope.name === 'discard') {
        return { kind: 'discarded', error: ERROR, followUps: [followUp('after-discard', 'k2')] };
      }
      return { kind: 'completed' };
    });
    await adapter.enqueue('default', envelope({ name: 'skip' }));
    await adapter.enqueue('default', envelope({ name: 'discard' }));
    await settle();
    assert.deepEqual(deliveries.map((job) => job.envelope.name).sort(), [
      'after-discard',
      'after-skip',
      'discard',
      'skip',
    ]);
  });

  test('a final failure stores its catch even when it drops the job', async () => {
    const { adapter, envelope, failedJobs } = setup();
    const { deliveries } = await work(adapter, (job) =>
      job.envelope.name === 'job'
        ? {
            ...FAILED,
            catchFired: true,
            drop: true,
            followUps: [followUp('on-catch', 'jsails:chain:c:catch')],
          }
        : { kind: 'completed' },
    );
    const { id } = await adapter.enqueue(
      'default',
      envelope({ flow: { kind: 'chain', id: 'c', step: 0, next: [] } }),
    );
    await settle();
    assert.deepEqual(
      deliveries.map((job) => job.envelope.name),
      ['job', 'on-catch'],
    );
    assert.equal(await failedJobs.get(id), undefined);
  });

  test('the follow-ups of a failure that is not final are ignored', async () => {
    const { adapter, envelope } = setup();
    let attempt = 0;
    const { deliveries, settles } = await work(adapter, (job) => {
      if (job.envelope.name !== 'job') return { kind: 'completed' };
      attempt += 1;
      return attempt === 1
        ? { ...FAILED, retryable: true, followUps: [followUp('never', 'k', 'nope')] }
        : { kind: 'completed' };
    });
    await adapter.enqueue('default', envelope({ options: { attempts: 2 } }));
    await settle();
    assert.deepEqual(
      deliveries.map((job) => job.envelope.name),
      ['job', 'job'],
    );
    assert.equal(settles[0]?.outcome.kind, 'failed');
    assert.equal(settles[0]?.outcome.kind === 'failed' && settles[0].outcome.retryable, true);
  });

  test('a follow-up that does not decode or names an undeclared queue breaks the contract', async () => {
    for (const bad of [
      followUp('next', 'k', 'nope'),
      { queue: 'default', envelope: { v: 2, name: 'next' } as unknown as JobEnvelope },
    ]) {
      const { adapter, envelope } = setup();
      let first = true;
      const { deliveries, settles } = await work(adapter, () => {
        if (!first) return { kind: 'completed' };
        first = false;
        return { kind: 'completed', followUps: [bad] };
      });
      await adapter.enqueue('default', envelope({ options: { attempts: 2 } }));
      await settle();
      assert.deepEqual(settles[0]?.outcome, PROCESSOR_BROKE_CONTRACT);
      assert.equal(settles[0]?.final, false, 'the attempt is retried');
      assert.deepEqual(
        deliveries.map((job) => job.envelope.name),
        ['job', 'job'],
        'nothing was stored',
      );
    }
  });
});

describe('memory capabilities: batches', () => {
  test('holds the finalizer until every child has a final outcome, then releases it once', async () => {
    const { adapter, envelope, flows } = setup();
    assert.deepEqual(await flows.enqueueBatch(batchOf(envelope, 'b1', 3)), { deduplicated: false });
    assert.equal(adapter.counts('default').pending, 1);
    assert.equal(adapter.counts('default').waiting, 3);
    const { deliveries } = await work(adapter, (job) =>
      job.envelope.payload === 1
        ? FAILED
        : job.envelope.payload === 2
          ? { kind: 'skipped', reason: 'overlap' }
          : { kind: 'completed' },
    );
    await settle(8);
    assert.deepEqual(
      deliveries.map((job) => job.envelope.name),
      ['job', 'job', 'job', BATCH_FINALIZER_JOB],
    );
    assert.equal(adapter.counts('default').pending, 0);
    assert.deepEqual(await flows.batchStatus('b1'), {
      total: 3,
      completed: 1,
      failed: 1,
      skipped: 1,
      pending: 0,
      settled: true,
      retriedAfterSettlement: 0,
    });
    assert.deepEqual(await flows.childFailures('b1', 100), [
      { index: 1, name: 'job', error: ERROR },
    ]);
    assert.equal(await flows.batchStatus('missing'), undefined);
    assert.equal(await flows.batchStatus('not an id'), undefined);
    assert.deepEqual(await flows.childFailures('not an id', 1), []);
    for (const limit of [0, 101, 1.5]) {
      await assert.rejects(flows.childFailures('b1', limit), code('invalid_option'));
    }
  });

  test('a redelivered child records nothing new; a retried one after settlement only counts', async () => {
    const { adapter, envelope, flows, failedJobs } = setup();
    await flows.enqueueBatch(batchOf(envelope, 'b1', 2));
    const { deliveries } = await work(adapter, (job) =>
      job.envelope.payload === 1 ? FAILED : { kind: 'completed' },
    );
    await settle(8);
    const child = deliveries.find((job) => job.envelope.payload === 0)!;
    assert.equal(adapter.redeliver(child.id), true);
    await settle();
    const failed = (await failedJobs.list())[0]!;
    assert.equal(await failedJobs.retry(failed.id), 'retried');
    await settle();
    assert.equal(
      deliveries.filter((job) => job.envelope.name === BATCH_FINALIZER_JOB).length,
      1,
      'the finalizer was released again',
    );
    assert.deepEqual(
      [
        (await flows.batchStatus('b1'))?.completed,
        (await flows.batchStatus('b1'))?.retriedAfterSettlement,
      ],
      [1, 1],
    );
  });

  test('a failed child retried before the batch settled is recorded again', async () => {
    const { adapter, envelope, flows, failedJobs } = setup();
    await flows.enqueueBatch(batchOf(envelope, 'b1', 2));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const deliveries: TransportJob[] = [];
    await adapter.startWorker({ queues: ['default'] }, async (job) => {
      deliveries.push(job);
      if (job.envelope.payload === 1) await held;
      runs += 1;
      return job.envelope.payload === 0 && runs === 1 ? FAILED : { kind: 'completed' };
    });
    await settle();
    assert.equal((await flows.batchStatus('b1'))?.failed, 1);
    const [failed] = await failedJobs.list();
    assert.equal(await failedJobs.retry(failed!.id), 'retried');
    assert.equal((await flows.batchStatus('b1'))?.pending, 2, 'the retry cleared its record');
    release();
    await settle(10);
    assert.deepEqual(await flows.batchStatus('b1'), {
      total: 2,
      completed: 2,
      failed: 0,
      skipped: 0,
      pending: 0,
      settled: true,
      retriedAfterSettlement: 0,
    });
    assert.equal(deliveries.filter((job) => job.envelope.name === BATCH_FINALIZER_JOB).length, 1);
  });

  test('a reissued batch deduplicates; another size conflicts', async () => {
    const { adapter, envelope, flows } = setup();
    await flows.enqueueBatch(batchOf(envelope, 'b1', 2));
    assert.deepEqual(await flows.enqueueBatch(batchOf(envelope, 'b1', 2)), { deduplicated: true });
    await assert.rejects(flows.enqueueBatch(batchOf(envelope, 'b1', 3)), code('flow_conflict'));
    assert.equal(adapter.counts('default').waiting, 2);
    assert.equal(adapter.counts('default').pending, 1);
  });

  test('a new batch whose child key another job holds is refused whole', async () => {
    const { adapter, envelope, flows } = setup();
    const taken = await adapter.enqueue(
      'default',
      envelope({ name: 'other', key: { value: 'jsails:batch:b1:1', windowMs: 86_400_000 } }),
    );
    const batch = batchOf(envelope, 'b1', 2);
    const keyed: BatchEnqueue = {
      ...batch,
      children: batch.children.map((child, index) => ({
        queue: child.queue,
        envelope: envelope({
          payload: index,
          key: { value: `jsails:batch:b1:${index}`, windowMs: 86_400_000 },
          flow: { kind: 'batch', id: 'b1', index },
        }),
      })),
    };
    await assert.rejects(flows.enqueueBatch(keyed), code('flow_conflict'));
    assert.equal(await flows.batchStatus('b1'), undefined);
    assert.deepEqual(adapter.counts('default'), {
      waiting: 1,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    });
    assert.equal(taken.deduplicated, false);
    assert.deepEqual(await flows.enqueueBatch(batchOf(envelope, 'b2', 2)), {
      deduplicated: false,
    });
  });

  test('checks the whole batch before storing any of it', async () => {
    const { adapter, envelope, flows } = setup();
    const good = batchOf(envelope, 'b1', 2);
    const cases: readonly [unknown, (error: unknown) => boolean][] = [
      [null, flowRule('shape')],
      [{ ...good, children: 'x' }, flowRule('shape')],
      [{ ...good, chunked: 'no' }, flowRule('shape')],
      [{ ...good, id: 'not an id' }, flowRule('id')],
      [{ ...good, children: [] }, flowRule('empty')],
      [batchOf(envelope, 'b1', MAX_BATCH_ITEMS + 1), flowRule('too_many_items')],
      [{ ...good, children: [good.children[0], { queue: 7 }] }, flowRule('shape')],
      [
        { ...good, children: [good.children[0], { ...good.children[1], queue: 'nope' }] },
        code('unknown_queue'),
      ],
      [
        { ...good, children: [good.children[0], { ...good.children[1], envelope: { v: 0 } }] },
        code('invalid_envelope'),
      ],
      [{ ...good, children: [good.children[1], good.children[0]] }, code('invalid_envelope')],
      [
        { ...good, children: [{ queue: 'default', envelope: envelope() }, good.children[1]] },
        code('invalid_envelope'),
      ],
      [
        { ...good, finalizer: { queue: 'default', envelope: envelope() } },
        code('invalid_envelope'),
      ],
      [
        {
          ...good,
          finalizer: {
            queue: 'default',
            envelope: buildEnvelope({
              name: BATCH_FINALIZER_JOB,
              payload: { id: 'b1', total: 2 },
              options: {},
              key: { value: 'k', windowMs: 1 },
              dispatchedAt: 0,
            }),
          },
        },
        code('invalid_envelope'),
      ],
    ];
    for (const [batch, refused] of cases) {
      await assert.rejects(flows.enqueueBatch(batch as BatchEnqueue), refused);
    }
    assert.deepEqual(adapter.counts('default'), {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    });
    await adapter.close();
    await assert.rejects(flows.enqueueBatch(good), code('adapter_closed'));
  });

  test('a chunked batch takes more children than a plain one', async () => {
    const { adapter, envelope, flows } = setup();
    await flows.enqueueBatch(batchOf(envelope, 'big', MAX_BATCH_ITEMS + 1, true));
    assert.equal(adapter.counts('default').waiting, MAX_BATCH_ITEMS + 1);
    await assert.rejects(
      flows.enqueueBatch({
        ...batchOf(envelope, 'huge', 1, true),
        children: { length: MAX_CHUNKED_BATCH_ITEMS + 1 } as never,
      }),
      flowRule('shape'),
    );
  });
});

describe('memory capabilities: test hooks and the ticker', () => {
  test('redeliver runs a settled job again under its id; anything else is refused', async () => {
    const { adapter, envelope } = setup();
    let fail = false;
    const { deliveries } = await work(adapter, () => (fail ? FAILED : { kind: 'completed' }));
    const done = await adapter.enqueue('default', envelope());
    await settle();
    assert.equal(adapter.redeliver(done.id), true);
    await settle();
    assert.deepEqual(
      deliveries.map((job) => job.id),
      [done.id, done.id],
    );
    fail = true;
    const failed = await adapter.enqueue('default', envelope());
    await settle();
    assert.equal(adapter.redeliver(failed.id), true);
    await settle();
    assert.equal(deliveries.filter((job) => job.id === failed.id).length, 2);
    const later = await adapter.enqueue('default', envelope({ runAt: START + 60_000 }));
    assert.equal(adapter.redeliver(later.id), false);
    assert.equal(adapter.redeliver('999'), false);
  });

  test('evictCompleted drops the retained completed jobs of a queue', async () => {
    const { adapter, envelope } = setup();
    await work(adapter);
    const { id } = await adapter.enqueue('default', envelope());
    await settle();
    assert.equal(adapter.counts('default').completed, 1);
    assert.equal(adapter.evictCompleted('default'), 1);
    assert.equal(adapter.counts('default').completed, 0);
    assert.equal(adapter.redeliver(id), false);
    assert.throws(() => adapter.evictCompleted('nope'), code('unknown_queue'));
  });

  test('schedules fire while a worker runs, not before and not after the last stops', async () => {
    const { adapter, envelope, clock } = setup();
    const schedules = adapter.capabilities.schedules!;
    await schedules.apply(
      {
        upsert: [
          { id: 'tick', queue: 'default', envelope: envelope(), repeat: { everyMs: 60_000 } },
        ],
        remove: [],
        stamp: { app: 'app', fingerprint: 'f', appliedAt: START, by: 'test' },
      },
      0,
    );
    await clock.advance(120_000);
    assert.equal(adapter.counts('default').waiting, 0, 'a producer-only adapter fired');
    const { worker, deliveries } = await work(adapter);
    await settle();
    assert.equal(deliveries.length, 1, 'the missed fires coalesce into one');
    await clock.advance(60_000);
    await settle();
    assert.equal(deliveries.length, 2);
    await worker.drain();
    await clock.advance(180_000);
    assert.equal(adapter.counts('default').waiting, 0, 'fired with no worker');
    await adapter.close();
  });

  test('close stops the ticker', async () => {
    const { adapter, envelope, clock } = setup();
    await work(adapter);
    await adapter.capabilities.schedules!.apply(
      {
        upsert: [
          { id: 'tick', queue: 'default', envelope: envelope(), repeat: { everyMs: 60_000 } },
        ],
        remove: [],
        stamp: { app: 'app', fingerprint: 'f', appliedAt: START, by: 'test' },
      },
      0,
    );
    await adapter.close();
    await clock.advance(120_000);
    assert.equal(clock.pending, 0);
  });

  test('leases are owner-token leases on the adapter clock', async () => {
    const { adapter, clock } = setup();
    const leases = adapter.capabilities.leases!;
    const token = await leases.acquire('k', 1_000);
    assert.equal(await leases.acquire('k', 1_000), undefined);
    await clock.advance(1_000);
    assert.notEqual(await leases.acquire('k', 1_000), undefined);
    assert.equal(await leases.release('k', token!), false);
  });
});
