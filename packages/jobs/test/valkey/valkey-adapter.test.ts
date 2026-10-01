/**
 * The Valkey transport over a fake BullMQ (`fake-bullmq.ts`), with no
 * server: the factory and its options, how an envelope maps onto a BullMQ
 * add (attempts, backoff, priority, delay, deduplication, retention), how a
 * deduplicated add is told apart, the worker's BullMQ options, and how each
 * attempt outcome maps onto BullMQ's moves and errors, settle events
 * included. The live behaviour is pinned by the files gated on a server.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  AttemptOutcome,
  JobEnvelope,
  ProcessJob,
  SettleEvent,
} from '../../src/contract/index.js';
import { runtimeSummary } from '../../src/errors/error-summary.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import type { QueueOptions } from '../../src/queues/queue-set.js';
import { valkeyJobs } from '../../src/valkey/index.js';
import { decodeFailure } from '../../src/valkey/failure-record.js';
import { deduplicationId } from '../../src/valkey/key-layout.js';
import { fakeBackend, fakeJob } from './fake-bullmq.js';
import { envelope, fakeAdapter as setup, refused } from './fixtures/fake-adapter.js';

describe('valkeyJobs options', () => {
  const connections = fakeBackend().connections;

  test('refuses a bad option when the factory is called, naming it', () => {
    assert.throws(
      () => valkeyJobs({ connections, lockDurationMs: 10 }),
      refused('invalid_option', { option: 'lockDurationMs' }),
    );
    assert.throws(
      () => valkeyJobs({ connections, maxStalledCount: -1 }),
      refused('invalid_option', { option: 'maxStalledCount' }),
    );
    assert.throws(
      () => valkeyJobs({ connections, scheduleSyncMs: 1.5 }),
      refused('invalid_option', { option: 'scheduleSyncMs' }),
    );
    assert.throws(
      () => valkeyJobs({ connections: {} as typeof connections }),
      refused('invalid_option', { option: 'connections' }),
    );
    assert.throws(
      () => valkeyJobs({ connections, onError: 'log' as unknown as () => void }),
      refused('invalid_option', { option: 'onError' }),
    );
    assert.throws(
      () =>
        valkeyJobs({ connections, prefix: 'bull' } as unknown as Parameters<typeof valkeyJobs>[0]),
      refused('unknown_option'),
    );
  });

  test('a server that cannot be reached fails the factory and leaves nothing open', async () => {
    const backend = fakeBackend();
    backend.readyError = new Error('ECONNREFUSED');
    await assert.rejects(setup({ mail: {} }, { backend }), refused('transport_failed'));
    assert.deepEqual([...backend.events].sort(), ['close default', 'close flows', 'close mail']);
  });

  test('a shared transport named valkey with every capability', async () => {
    const { adapter } = await setup();
    assert.equal(adapter.name, 'valkey');
    assert.equal(adapter.reach, 'shared');
    assert.deepEqual(Object.keys(adapter.capabilities).sort(), [
      'failedJobs',
      'flows',
      'leases',
      'schedules',
    ]);
    await adapter.close();
  });
});

describe('enqueue', () => {
  test('maps the envelope onto one BullMQ add', async () => {
    const { backend, adapter } = await setup({
      mail: {
        retention: { completed: { age: '90s', count: 10 }, failed: { age: '7d', count: 0 } },
      },
    });
    const runAt = Date.now() + 60_000;
    const stored = envelope({
      options: { attempts: 3, priority: 5 },
      key: { value: 'invoice:1', windowMs: 3_600_000 },
      runAt,
    });
    const handle = await adapter.enqueue('mail', stored);
    assert.equal(handle.deduplicated, false);
    const [add] = backend.adds;
    assert.equal(add?.queue, 'mail');
    assert.equal(add?.name, 'job');
    assert.deepEqual(add?.data, stored);
    const { jobId, delay, ...options } = add.options;
    assert.equal(jobId, handle.id);
    assert.doesNotMatch(jobId, /:|^\d+$/, 'BullMQ refuses integer and colon ids');
    assert.ok(delay !== undefined && delay > 59_000 && delay <= 60_000, `delay ${delay}`);
    assert.deepEqual(options, {
      attempts: 3,
      backoff: { type: 'jsails' },
      priority: 5,
      deduplication: { id: deduplicationId('invoice:1'), ttl: 3_600_000 },
      removeOnComplete: { age: 90, count: 10 },
      removeOnFail: true,
    });
    await adapter.close();
  });

  test('priority 0 is BullMQ no-priority list, and a job with no key or run time has neither', async () => {
    const { backend, adapter } = await setup();
    await adapter.enqueue('default', envelope({ options: { priority: 0 } }));
    const options = backend.adds[0]!.options;
    assert.equal('priority' in options, false);
    assert.equal('delay' in options, false);
    assert.equal('deduplication' in options, false);
    assert.equal(options.attempts, 1);
    assert.deepEqual(options.removeOnComplete, { age: 3_600, count: 1_000 });
    await adapter.close();
  });

  test('a key taken on its queue hands back the first job id as deduplicated', async () => {
    const { backend, adapter } = await setup({ mail: {} });
    const keyed = envelope({ key: { value: 'k', windowMs: 60_000 } });
    const first = await adapter.enqueue('default', keyed);
    const second = await adapter.enqueue('default', keyed);
    assert.deepEqual({ ...second }, { id: first.id, deduplicated: true });
    const elsewhere = await adapter.enqueue('mail', keyed);
    assert.equal(elsewhere.deduplicated, false, 'a key deduplicates per queue');
    assert.equal(backend.adds.length, 2);
    await adapter.close();
  });

  test('refuses an undeclared queue, a malformed envelope and a closed adapter', async () => {
    const { adapter } = await setup();
    await assert.rejects(adapter.enqueue('mail', envelope()), refused('unknown_queue'));
    await assert.rejects(
      adapter.enqueue('default', { v: 1 } as unknown as JobEnvelope),
      refused('invalid_envelope'),
    );
    await adapter.close();
    await assert.rejects(adapter.enqueue('default', envelope()), refused('adapter_closed'));
  });

  test('a server error leaves as jobs.transport_failed, the original only as its cause', async () => {
    const { backend, adapter } = await setup();
    backend.failAdds = true;
    await assert.rejects(adapter.enqueue('default', envelope()), (error: unknown) => {
      assert.ok(JobsErrors.is(error, 'transport_failed'));
      assert.doesNotMatch(error.message, /unreachable/);
      assert.equal((error.cause as Error).message, 'server unreachable');
      return true;
    });
    await adapter.close();
  });
});

describe('startWorker', () => {
  test('one BullMQ worker per queue on its own queue-role connection', async () => {
    const { backend, adapter } = await setup(
      { mail: { concurrency: 3 } },
      { lockDurationMs: 10_000 },
    );
    const worker = await adapter.startWorker({ queues: ['default', 'mail'] }, () =>
      Promise.resolve({ kind: 'completed' }),
    );
    assert.deepEqual(
      backend.workers.map((entry) => [entry.queue, entry.options.concurrency]),
      [
        ['default', 1],
        ['mail', 3],
      ],
    );
    const options = backend.workers[0]!.options;
    assert.equal(options.prefix, 'app:test:jobs');
    assert.equal(options.lockDuration, 10_000);
    assert.equal(options.stalledInterval, 10_000);
    assert.ok(options.maxStalledCount > 100, 'BullMQ never fails a job for stalling itself');
    assert.deepEqual(
      backend.dedicated.map((entry) => entry.name),
      ['jobs-default', 'jobs-mail'],
    );
    await worker.drain();
    assert.ok(backend.workers.every((entry) => entry.closed));
    assert.ok(backend.dedicated.every((entry) => entry.disconnected));
    await adapter.close();
  });

  test('refuses no queues, an undeclared queue and a bad concurrency', async () => {
    const { adapter } = await setup();
    const process: ProcessJob = () => Promise.resolve({ kind: 'completed' });
    await assert.rejects(adapter.startWorker({ queues: [] }, process), refused('invalid_worker'));
    await assert.rejects(
      adapter.startWorker({ queues: ['mail'] }, process),
      refused('unknown_queue'),
    );
    await assert.rejects(
      adapter.startWorker({ queues: ['default'], concurrency: 0 }, process),
      refused('invalid_worker'),
    );
    await adapter.close();
  });
});

/** Start a worker whose processor answers `outcome`, and deliver `job` to it. */
async function deliver(
  outcome: AttemptOutcome | (() => Promise<AttemptOutcome>),
  job: ReturnType<typeof fakeJob>,
  options: {
    readonly maxStalledCount?: number;
    readonly queues?: Record<string, QueueOptions>;
  } = {},
) {
  const { queues = {}, ...adapterOptions } = options;
  const { backend, adapter, reported } = await setup(queues, adapterOptions);
  const settled: SettleEvent[] = [];
  let processed = 0;
  await adapter.startWorker(
    { queues: ['default'], onSettle: (event) => settled.push(event) },
    () => {
      processed += 1;
      return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome);
    },
  );
  const worker = backend.workers[0]!;
  let result: { value?: unknown; error?: Error } = {};
  try {
    result = { value: await worker.processor(job, 'token-1') };
  } catch (error) {
    result = { error: error as Error };
  }
  return { backend, adapter, reported, worker, settled, result, processed: () => processed };
}

describe('outcomes', () => {
  test('completed returns c and settles final on the completed event', async () => {
    const run = await deliver({ kind: 'completed' }, fakeJob(envelope()));
    assert.equal(run.result.value, 'c');
    assert.deepEqual(run.settled, [], 'no settle before BullMQ applied it');
    run.worker.emit('completed', fakeJob(envelope()));
    assert.deepEqual(run.settled, [], 'another job object is not this settle');
    await run.adapter.close();
  });

  test('a settle is emitted once BullMQ applies it', async () => {
    const job = fakeJob(envelope());
    const run = await deliver({ kind: 'skipped', reason: 'overlap' }, job);
    assert.equal(run.result.value, 's');
    run.worker.emit('completed', job);
    run.worker.emit('completed', job);
    assert.equal(run.settled.length, 1);
    assert.equal(run.settled[0]?.final, true);
    assert.equal(run.settled[0]?.job.id, 'job-1');
    await run.adapter.close();
  });

  test('a shutdown release moves the job back with its token and spends no attempt', async () => {
    const job = fakeJob(envelope());
    const run = await deliver({ kind: 'released', reason: 'shutdown' }, job);
    assert.equal(run.result.error?.name, 'WaitingError');
    assert.deepEqual(job.calls, [{ call: 'moveToWait', token: 'token-1' }]);
    assert.equal(run.settled.length, 1);
    assert.equal(run.settled[0]?.final, false);
    await run.adapter.close();
  });

  test('an unknown_job release counts itself, then moves the job to delayed', async () => {
    const job = fakeJob(envelope(), { progress: 2 });
    const before = Date.now();
    const run = await deliver({ kind: 'released', reason: 'unknown_job', delayMs: 500.2 }, job);
    assert.equal(run.result.error?.name, 'DelayedError');
    assert.deepEqual(job.calls[0], { call: 'updateProgress', progress: 3 });
    const move = job.calls[1];
    assert.equal(move?.call, 'moveToDelayed');
    assert.ok(
      move.call === 'moveToDelayed' && move.timestamp >= before + 501 && move.token === 'token-1',
    );
    await run.adapter.close();
  });

  test('a release whose move fails settles nothing and leaves the lock to lapse', async () => {
    const job = fakeJob(envelope(), { failMoves: true });
    const run = await deliver({ kind: 'released', reason: 'shutdown' }, job);
    assert.equal(run.result.error?.name, 'WaitingError');
    assert.deepEqual(run.settled, []);
    assert.ok(run.reported.every((error) => JobsErrors.is(error, 'transport_failed')));
    assert.equal(run.reported.length, 1);
    await run.adapter.close();
  });

  test('a retryable failure with attempts left throws attempt_failed with no stack', async () => {
    const job = fakeJob(envelope({ options: { attempts: 3 } }), { attempts: 3 });
    const error = runtimeSummary('attempt_timeout');
    const run = await deliver({ kind: 'failed', error, retryable: true }, job);
    assert.ok(JobsErrors.is(run.result.error, 'attempt_failed'));
    assert.notEqual(run.result.error.name, 'UnrecoverableError');
    assert.equal(run.result.error.stack, '');
    run.worker.emit('failed', job);
    assert.equal(run.settled[0]?.final, false);
    await run.adapter.close();
  });

  test('a final failure stores its follow-ups first and throws the unrecoverable record', async () => {
    const job = fakeJob(envelope());
    const followUp = { queue: 'default', envelope: envelope({ name: 'cleanup' }) };
    const error = runtimeSummary('attempt_timeout');
    const run = await deliver(
      { kind: 'failed', error, retryable: false, followUps: [followUp] },
      job,
    );
    assert.equal(run.result.error?.name, 'UnrecoverableError');
    assert.equal(run.result.error?.stack, '');
    assert.deepEqual(decodeFailure(run.result.error?.message), { name: 'job', error });
    assert.deepEqual(
      run.backend.adds.map((add) => add.name),
      ['cleanup'],
    );
    run.worker.emit('failed', job);
    assert.deepEqual({ ...run.settled[0]?.failedJob }, { id: 'job-1', queue: 'default' });
    await run.adapter.close();
  });

  test('a dropped final failure is removed by BullMQ fail and reports no failed job', async () => {
    const job = fakeJob(envelope());
    const run = await deliver(
      { kind: 'failed', error: runtimeSummary('attempt_timeout'), retryable: false, drop: true },
      job,
    );
    assert.equal(job.opts.removeOnFail, true);
    run.worker.emit('failed', job);
    assert.equal(run.settled[0]?.failedJob, undefined);
    await run.adapter.close();
  });

  test('a fired catch marks the stored chain step', async () => {
    const step = envelope({ flow: { kind: 'chain', id: 'c1', step: 0, next: [] } });
    const job = fakeJob(step);
    const run = await deliver(
      {
        kind: 'failed',
        error: runtimeSummary('attempt_timeout'),
        retryable: false,
        catchFired: true,
        followUps: [{ queue: 'default', envelope: envelope({ name: 'on-catch' }) }],
      },
      job,
    );
    const update = job.calls.find((call) => call.call === 'updateData');
    assert.ok(update?.call === 'updateData');
    const flow = (update.data as JobEnvelope).meta.flow;
    assert.ok(flow?.kind === 'chain' && flow.catchFired === true);
    await run.adapter.close();
  });

  test('a processor that rejects or names an undeclared queue broke the contract', async () => {
    const rejected = await deliver(() => Promise.reject(new Error('bug')), fakeJob(envelope()));
    assert.equal(rejected.result.error?.name, 'UnrecoverableError');
    assert.equal(
      decodeFailure(rejected.result.error?.message).error.code,
      'jobs.processor_broke_contract',
    );
    await rejected.adapter.close();
    const stray = await deliver(
      { kind: 'completed', followUps: [{ queue: 'mail', envelope: envelope() }] },
      fakeJob(envelope()),
    );
    assert.equal(stray.result.error?.name, 'UnrecoverableError');
    assert.deepEqual(stray.backend.adds, []);
    await stray.adapter.close();
  });

  test('a job past the stall limit runs no code and fails as job_stalled with its catch', async () => {
    const catchStep = { queue: 'default', name: 'on-catch', payload: null, options: {} };
    const step = envelope({
      flow: { kind: 'chain', id: 'c1', step: 0, next: [], catch: catchStep },
    });
    const job = fakeJob(step, { stalledCounter: 2, attempts: 5 });
    const run = await deliver({ kind: 'completed' }, job, { maxStalledCount: 1 });
    assert.equal(run.processed(), 0);
    assert.equal(run.result.error?.name, 'UnrecoverableError');
    assert.equal(decodeFailure(run.result.error?.message).error.code, 'jobs.job_stalled');
    assert.deepEqual(
      run.backend.adds.map((add) => add.name),
      ['on-catch'],
    );
    assert.ok(
      job.calls.some((call) => call.call === 'updateData'),
      'the catch is marked fired',
    );
    await run.adapter.close();
  });

  test('a job within the stall limit runs', async () => {
    const run = await deliver({ kind: 'completed' }, fakeJob(envelope(), { stalledCounter: 1 }), {
      maxStalledCount: 1,
    });
    assert.equal(run.processed(), 1);
    assert.equal(run.result.value, 'c');
    await run.adapter.close();
  });

  test('a settle whose writes keep failing is abandoned: back to delayed, no settle event', async () => {
    const job = fakeJob(envelope());
    const { backend, adapter, reported } = await setup();
    const settled: SettleEvent[] = [];
    await adapter.startWorker(
      { queues: ['default'], onSettle: (event) => settled.push(event) },
      () =>
        Promise.resolve({
          kind: 'completed',
          followUps: [{ queue: 'default', envelope: envelope({ name: 'next' }) }],
        }),
    );
    backend.failAdds = true;
    const before = Date.now();
    await assert.rejects(backend.workers[0]!.processor(job, 'token-1'), { name: 'DelayedError' });
    const move = job.calls.at(-1);
    assert.ok(move?.call === 'moveToDelayed' && move.timestamp >= before + 30_000);
    backend.workers[0]!.emit('completed', job);
    assert.deepEqual(settled, []);
    assert.equal(reported.length, 1, 'the abandoned settle is reported once');
    await adapter.close();
  });
});

describe('abort', () => {
  test('aborts every in-flight signal at once, and later deliveries start aborted', async () => {
    const { backend, adapter } = await setup();
    const signals: AbortSignal[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = await adapter.startWorker({ queues: ['default'] }, async (_job, signal) => {
      signals.push(signal);
      await held;
      return { kind: 'released', reason: 'shutdown' };
    });
    const running = backend.workers[0]!.processor(fakeJob(envelope()), 'token-1');
    const aborting = worker.abort();
    assert.equal(signals[0]?.aborted, true);
    assert.ok(JobsErrors.is(signals[0]?.reason, 'worker_aborted'));
    const late = backend.workers[0]!.processor(fakeJob(envelope(), { id: 'job-2' }), 'token-2');
    assert.equal(signals[1]?.aborted, true);
    release();
    await assert.rejects(running, { name: 'WaitingError' });
    await assert.rejects(late, { name: 'WaitingError' });
    await aborting;
    await adapter.close();
  });
});

describe('test hooks', () => {
  test('busy: an attempt running here, or a runnable job on a queue a worker fetches from', async () => {
    const { backend, adapter } = await setup({ mail: {} });
    assert.equal(await adapter.busy(), false, 'no worker fetches');
    assert.equal(backend.scriptCalls.length, 0);
    let release: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    await adapter.startWorker({ queues: ['mail'] }, async () => {
      await running;
      return { kind: 'completed' };
    });
    backend.scriptReply = () => 0;
    const before = Date.now();
    assert.equal(await adapter.busy(), false);
    const after = Date.now();
    const call = backend.scriptCalls.at(-1)!;
    assert.equal(call.script, 'busy');
    assert.deepEqual(call.keys, [
      'app:test:jobs:mail:wait',
      'app:test:jobs:mail:prioritized',
      'app:test:jobs:mail:active',
      'app:test:jobs:mail:delayed',
    ]);
    // Due means scored at or before the millisecond of the read: every score
    // below the first one of the next millisecond, whenever the read ran.
    const bound = Number(call.args[0]);
    assert.ok(
      bound >= (before + 1) * 0x1000 && bound <= (after + 1) * 0x1000,
      'due means scored at or before now',
    );
    backend.scriptReply = () => 1;
    assert.equal(await adapter.busy(), true);
    const attempt = backend.workers[0]!.processor(fakeJob(envelope()), 'token-1');
    const calls = backend.scriptCalls.length;
    assert.equal(await adapter.busy(), true, 'an attempt in flight');
    assert.equal(backend.scriptCalls.length, calls, 'which needs no read');
    release();
    await attempt;
    await adapter.close();
  });

  test('promoteDue makes each due delayed job runnable, counting those it moved', async () => {
    const { backend, adapter } = await setup({ mail: {} });
    const due = fakeJob(envelope(), { id: 'due-1' });
    backend.jobs.set('default:due-1', due);
    backend.scriptReply = (_script, keys) =>
      keys[0] === 'app:test:jobs:default:delayed' ? ['due-1', 7, 'gone-1'] : [];
    assert.equal(await adapter.promoteDue(1_000), 1);
    assert.deepEqual(due.calls, [{ call: 'promote' }]);
    assert.deepEqual(backend.scriptCalls[0]!.args, [String(1_001 * 0x1000)]);
    await adapter.close();
  });

  test('redeliver finds the settled job on whichever declared queue holds it', async () => {
    const { backend, adapter } = await setup({ mail: {} });
    backend.scriptReply = (_script, keys) => (keys[0] === 'app:test:jobs:mail:completed' ? 1 : 0);
    assert.equal(await adapter.redeliver('job-1'), true);
    assert.deepEqual(backend.scriptCalls.at(-1)!.keys, [
      'app:test:jobs:mail:completed',
      'app:test:jobs:mail:failed',
      'app:test:jobs:mail:wait',
      'app:test:jobs:mail:marker',
      'app:test:jobs:mail:job-1',
    ]);
    backend.scriptReply = () => 0;
    assert.equal(await adapter.redeliver('job-1'), false);
    await adapter.close();
  });

  test('evictCompleted deletes a declared queue completed jobs', async () => {
    const { backend, adapter } = await setup();
    backend.scriptReply = () => 3;
    assert.equal(await adapter.evictCompleted('default'), 3);
    assert.deepEqual(backend.scriptCalls[0]!.keys, ['app:test:jobs:default:completed']);
    assert.deepEqual(backend.scriptCalls[0]!.args, ['app:test:jobs:default:']);
    await assert.rejects(adapter.evictCompleted('mail'), refused('unknown_queue'));
    await adapter.close();
  });
});
