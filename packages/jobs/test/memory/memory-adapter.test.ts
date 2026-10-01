/**
 * The memory adapter: windowed key deduplication that outlives the job,
 * long-timer delays, priority and per-queue concurrency, attempt counting by
 * outcome, abort that keeps a job held until its processor settles, and
 * retention.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type {
  AttemptOutcome,
  JobEnvelope,
  ProcessJob,
  SettleEvent,
  TransportJob,
} from '../../src/contract/index.js';
import { buildEnvelope, type EnvelopeParts } from '../../src/envelope/codec.js';
import { MemoryJobsAdapter, MemoryJobsError, memoryJobs } from '../../src/memory/memory-adapter.js';
import { defineQueues, type QueueOptions } from '../../src/queues/queue-set.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';

const DAY_MS = 86_400_000;
const START = 1_700_000_000_000;

function setup(queues: Readonly<Record<string, QueueOptions>> = {}) {
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
  return { clock, adapter, envelope };
}

/** A processor that records deliveries and answers with `outcome`. */
function recorder(
  outcome: (job: TransportJob) => AttemptOutcome | Promise<AttemptOutcome> = () => ({
    kind: 'completed',
  }),
) {
  const deliveries: TransportJob[] = [];
  const settles: SettleEvent[] = [];
  const process: ProcessJob = async (job) => {
    deliveries.push(job);
    return outcome(job);
  };
  return { deliveries, settles, process, onSettle: (event: SettleEvent) => settles.push(event) };
}

function payloads(deliveries: readonly TransportJob[]): unknown[] {
  return deliveries.map((delivery) => delivery.envelope.payload);
}

describe('memory adapter', () => {
  test('is a process-reach adapter built by its factory', async () => {
    const adapter = await memoryJobs()({ namespace: 'a:b', queues: defineQueues({}).declarations });
    assert.equal(adapter.reach, 'process');
    assert.equal(adapter.name, 'memory');
    assert.deepEqual(adapter.capabilities, {});
    await adapter.close();
  });

  test('a key deduplicates on its queue inside its window, returning the first job id', async () => {
    const { adapter, envelope } = setup({ other: {} });
    const keyed = envelope({ key: { value: 'k', windowMs: 60_000 } });
    const first = await adapter.enqueue('default', keyed);
    const second = await adapter.enqueue('default', keyed);
    const elsewhere = await adapter.enqueue('other', keyed);
    assert.deepEqual(first, { id: '1', deduplicated: false });
    assert.deepEqual(second, { id: '1', deduplicated: true });
    assert.deepEqual(elsewhere, { id: '2', deduplicated: false });
    assert.equal(adapter.counts('default').waiting, 1);
  });

  test('a key still deduplicates after the first job completed and was evicted, until its window ends', async () => {
    const { adapter, envelope, clock } = setup({
      default: { retention: { completed: { count: 0 } } },
    });
    const { process, deliveries } = recorder();
    await adapter.startWorker({ queues: ['default'] }, process);
    const keyed = envelope({ key: { value: 'k', windowMs: 60_000 } });
    await adapter.enqueue('default', keyed);
    await flush();
    assert.equal(deliveries.length, 1);
    assert.equal(adapter.counts('default').completed, 0, 'the completed job was not evicted');
    assert.equal((await adapter.enqueue('default', keyed)).deduplicated, true);
    await clock.advance(59_999);
    assert.equal((await adapter.enqueue('default', keyed)).deduplicated, true);
    await clock.advance(1);
    assert.equal((await adapter.enqueue('default', keyed)).deduplicated, false);
    await flush();
    assert.equal(deliveries.length, 2);
    await adapter.close();
  });

  test('a 30-day delay runs once, after 30 days, without a timer above the Node limit', async () => {
    const { adapter, envelope, clock } = setup();
    const { process, deliveries } = recorder();
    await adapter.startWorker({ queues: ['default'] }, process);
    await adapter.enqueue('default', envelope({ runAt: START + 30 * DAY_MS }));
    assert.equal(adapter.counts('default').delayed, 1);
    await clock.advance(30 * DAY_MS - 1);
    assert.equal(deliveries.length, 0, 'the delayed job ran early');
    await clock.advance(1);
    await flush();
    assert.equal(deliveries.length, 1);
    await clock.advance(60 * DAY_MS);
    assert.equal(deliveries.length, 1, 'the delayed job ran again');
    await adapter.close();
  });

  test('a run time in the past runs at once', async () => {
    const { adapter, envelope } = setup();
    const { process, deliveries } = recorder();
    await adapter.startWorker({ queues: ['default'] }, process);
    await adapter.enqueue('default', envelope({ runAt: START - 1_000 }));
    await flush();
    assert.equal(deliveries.length, 1);
    await adapter.close();
  });

  test('waiting jobs run by priority, then in arrival order', async () => {
    const { adapter, envelope } = setup();
    const { process, deliveries } = recorder();
    for (const [payload, priority] of [
      ['late-low', 5],
      ['first-high', 0],
      ['mid', 2],
      ['second-high', 0],
    ] as const) {
      await adapter.enqueue('default', envelope({ payload, options: { priority } }));
    }
    await adapter.startWorker({ queues: ['default'] }, process);
    await flush();
    assert.deepEqual(payloads(deliveries), ['first-high', 'second-high', 'mid', 'late-low']);
    await adapter.close();
  });

  test('each queue runs up to its own concurrency; a worker override applies per queue', async () => {
    const held = (): ProcessJob => () => new Promise<AttemptOutcome>(() => undefined);
    const declared = setup({ mail: { concurrency: 2 } });
    for (let index = 0; index < 4; index += 1) {
      await declared.adapter.enqueue('mail', declared.envelope({ payload: index }));
      await declared.adapter.enqueue('default', declared.envelope({ payload: index }));
    }
    await declared.adapter.startWorker({ queues: ['mail', 'default'] }, held());
    await flush();
    assert.equal(declared.adapter.counts('mail').active, 2);
    assert.equal(declared.adapter.counts('default').active, 1);

    const overridden = setup({ mail: { concurrency: 2 } });
    for (let index = 0; index < 4; index += 1) {
      await overridden.adapter.enqueue('mail', overridden.envelope({ payload: index }));
      await overridden.adapter.enqueue('default', overridden.envelope({ payload: index }));
    }
    await overridden.adapter.startWorker({ queues: ['mail', 'default'], concurrency: 3 }, held());
    await flush();
    assert.equal(overridden.adapter.counts('mail').active, 3);
    assert.equal(overridden.adapter.counts('default').active, 3);
  });

  test('a released attempt returns the job without spending an attempt; unknown releases are counted', async () => {
    const { adapter, envelope, clock } = setup();
    const outcomes: AttemptOutcome[] = [
      { kind: 'released', reason: 'shutdown' },
      { kind: 'released', reason: 'unknown_job', delayMs: 50 },
      { kind: 'completed' },
    ];
    const run = recorder(() => outcomes.shift()!);
    await adapter.startWorker({ queues: ['default'], onSettle: run.onSettle }, run.process);
    await adapter.enqueue('default', envelope({ options: { attempts: 1 } }));
    await flush();
    await flush();
    assert.equal(run.deliveries.length, 2);
    await clock.advance(49);
    assert.equal(run.deliveries.length, 2, 'the release delay was not honoured');
    await clock.advance(1);
    await flush();
    assert.deepEqual(
      run.deliveries.map((delivery) => [delivery.attemptsMade, delivery.unknownReleases]),
      [
        [0, 0],
        [0, 0],
        [0, 1],
      ],
    );
    assert.deepEqual(
      run.settles.map((event) => event.final),
      [false, false, true],
    );
    assert.equal(run.deliveries[0]!.id, run.deliveries[2]!.id);
    await adapter.close();
  });

  test('a retryable failure spends an attempt and waits out the backoff; the last one is final', async () => {
    const { adapter, envelope, clock } = setup();
    const run = recorder(() => ({
      kind: 'failed',
      error: { kind: 'handler', name: 'Error' },
      retryable: true,
    }));
    await adapter.startWorker({ queues: ['default'], onSettle: run.onSettle }, run.process);
    await adapter.enqueue(
      'default',
      envelope({ options: { attempts: 3, backoff: { type: 'exponential', delayMs: 1_000 } } }),
    );
    await flush();
    assert.equal(run.deliveries.length, 1);
    await clock.advance(999);
    assert.equal(run.deliveries.length, 1);
    await clock.advance(1);
    await flush();
    assert.equal(run.deliveries.length, 2);
    await clock.advance(1_999);
    assert.equal(run.deliveries.length, 2, 'the second backoff did not double');
    await clock.advance(1);
    await flush();
    assert.deepEqual(
      run.deliveries.map((delivery) => delivery.attemptsMade),
      [0, 1, 2],
    );
    assert.deepEqual(
      run.settles.map((event) => event.final),
      [false, false, true],
    );
    assert.equal(adapter.counts('default').failed, 1);
    await adapter.close();
  });

  test('a non-retryable failure is final at once; completed, discarded and skipped are final', async () => {
    const { adapter, envelope } = setup();
    const outcomes: AttemptOutcome[] = [
      { kind: 'failed', error: { kind: 'validation', name: 'ZodError' }, retryable: false },
      { kind: 'completed' },
      { kind: 'discarded', error: { kind: 'handler', name: 'Error' } },
      { kind: 'skipped', reason: 'overlap' },
    ];
    const run = recorder(() => outcomes.shift()!);
    await adapter.startWorker({ queues: ['default'], onSettle: run.onSettle }, run.process);
    for (let index = 0; index < 4; index += 1) {
      await adapter.enqueue('default', envelope({ options: { attempts: 5 } }));
    }
    await flush();
    await flush();
    assert.deepEqual(
      run.settles.map((event) => [event.outcome.kind, event.final]),
      [
        ['failed', true],
        ['completed', true],
        ['discarded', true],
        ['skipped', true],
      ],
    );
    assert.deepEqual(adapter.counts('default'), {
      waiting: 0,
      delayed: 0,
      active: 0,
      completed: 3,
      failed: 1,
    });
    await adapter.close();
  });

  test('a processor that breaks the contract counts as a retryable failure', async () => {
    const { adapter, envelope } = setup();
    let calls = 0;
    const process: ProcessJob = () => {
      calls += 1;
      if (calls === 1) throw new Error('sync');
      if (calls === 2) return Promise.reject(new Error('async'));
      return Promise.resolve({ kind: 'completed' });
    };
    const settles: SettleEvent[] = [];
    await adapter.startWorker(
      { queues: ['default'], onSettle: (event) => settles.push(event) },
      process,
    );
    await adapter.enqueue(
      'default',
      envelope({ options: { attempts: 3, backoff: { type: 'fixed', delayMs: 0 } } }),
    );
    for (let index = 0; index < 6; index += 1) await flush();
    assert.deepEqual(
      settles.map((event) => [event.outcome.kind, event.final]),
      [
        ['failed', false],
        ['failed', false],
        ['completed', true],
      ],
    );
    await adapter.close();
  });

  test('an outcome that is not one, or a bare return value, counts as a retryable failure', async () => {
    const { adapter, envelope } = setup();
    let calls = 0;
    const process = (() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ kind: 'bogus' });
      if (calls === 2) return { kind: 'completed' };
      return Promise.resolve(undefined);
    }) as unknown as ProcessJob;
    const settles: SettleEvent[] = [];
    await adapter.startWorker(
      { queues: ['default'], onSettle: (event) => settles.push(event) },
      process,
    );
    await adapter.enqueue(
      'default',
      envelope({ options: { attempts: 2, backoff: { type: 'fixed', delayMs: 0 } } }),
    );
    await adapter.enqueue(
      'default',
      envelope({ options: { attempts: 1, backoff: { type: 'fixed', delayMs: 0 } } }),
    );
    for (let index = 0; index < 8; index += 1) await flush();
    assert.deepEqual(
      settles.map((event) => [event.outcome.kind, event.final]),
      [
        ['failed', false],
        ['completed', true],
        ['failed', true],
      ],
    );
    assert.equal(adapter.counts('default').active, 0);
    assert.equal(adapter.counts('default').failed, 1);
    await adapter.close();
  });

  test('a release delay that is not a whole number of milliseconds is bounded, never thrown', async () => {
    const { adapter, envelope, clock } = setup();
    const delays = [Number.NaN, -5, 0.5, Number.POSITIVE_INFINITY];
    const run = recorder((job) =>
      job.unknownReleases < delays.length
        ? { kind: 'released', reason: 'unknown_job', delayMs: delays[job.unknownReleases] }
        : { kind: 'completed' },
    );
    await adapter.startWorker({ queues: ['default'] }, run.process);
    await adapter.enqueue('default', envelope());
    for (let index = 0; index < 6; index += 1) await flush();
    assert.equal(run.deliveries.length, 3, 'NaN and a negative delay release at once');
    await clock.advance(1);
    assert.equal(run.deliveries.length, 4, 'a fractional delay is rounded up');
    await clock.advance(365 * DAY_MS - 1);
    assert.equal(run.deliveries.length, 4, 'an infinite delay waits the longest delay');
    await clock.advance(1);
    assert.equal(run.deliveries.length, 5);
    await adapter.close();
  });

  test('a value that is not a current-version envelope is refused, value-free', async () => {
    const { adapter, envelope } = setup();
    const marker = 'MARKER-41c2';
    const refused = (error: unknown) =>
      error instanceof MemoryJobsError &&
      error.code === 'invalid_envelope' &&
      !error.message.includes(marker);
    for (const value of [
      null,
      { ...envelope(), v: 2 },
      { ...envelope(), extra: marker },
      { ...envelope(), meta: { dispatchedAt: 1, runAt: -1 } },
      { ...envelope(), options: { attempts: 0 } },
    ]) {
      await assert.rejects(adapter.enqueue('default', value as JobEnvelope), refused);
    }
    assert.equal(adapter.counts('default').waiting, 0);
    await adapter.close();
  });

  test('every delivery gets its own copy of the stored envelope', async () => {
    const { adapter, envelope } = setup();
    const run = recorder((job) => {
      (job.envelope.payload as { count: number }).count += 1;
      return run.deliveries.length === 1
        ? { kind: 'failed', error: { kind: 'handler', name: 'Error' }, retryable: true }
        : { kind: 'completed' };
    });
    await adapter.startWorker({ queues: ['default'] }, run.process);
    await adapter.enqueue(
      'default',
      envelope({
        payload: { count: 0 },
        options: { attempts: 2, backoff: { type: 'fixed', delayMs: 0 } },
      }),
    );
    for (let index = 0; index < 4; index += 1) await flush();
    assert.deepEqual(payloads(run.deliveries), [{ count: 1 }, { count: 1 }]);
    await adapter.close();
  });

  test('abort signals in-flight attempts and keeps each job held until its processor settles', async () => {
    const { adapter, envelope } = setup();
    let release: () => void = () => undefined;
    const signals: AbortSignal[] = [];
    let calls = 0;
    const process: ProcessJob = (_job, signal) => {
      calls += 1;
      signals.push(signal);
      if (calls > 1) return Promise.resolve({ kind: 'completed' });
      return new Promise((resolve) => {
        release = () => resolve({ kind: 'released', reason: 'shutdown' });
      });
    };
    const first = await adapter.startWorker({ queues: ['default'] }, process);
    await adapter.enqueue('default', envelope());
    await flush();
    const aborted = first.abort();
    await flush();
    assert.equal(signals[0]!.aborted, true);
    const second = await adapter.startWorker({ queues: ['default'] }, process);
    await flush();
    assert.equal(
      calls,
      1,
      'a held job was delivered to another worker before its processor settled',
    );
    release();
    await aborted;
    await flush();
    assert.equal(calls, 2, 'the released job did not reach the next worker');
    await second.drain();
    await adapter.close();
  });

  test('drain waits for in-flight attempts without aborting them, then stops fetching', async () => {
    const { adapter, envelope } = setup();
    let release: () => void = () => undefined;
    const signals: AbortSignal[] = [];
    const process: ProcessJob = (_job, signal) => {
      signals.push(signal);
      return new Promise((resolve) => {
        release = () => resolve({ kind: 'completed' });
      });
    };
    const worker = await adapter.startWorker({ queues: ['default'] }, process);
    await adapter.enqueue('default', envelope());
    await flush();
    let drained = false;
    const draining = worker.drain().then(() => (drained = true));
    await adapter.enqueue('default', envelope());
    await flush();
    assert.equal(drained, false);
    assert.equal(signals.length, 1, 'a draining worker fetched a new job');
    assert.equal(signals[0]!.aborted, false);
    release();
    await draining;
    assert.equal(adapter.counts('default').waiting, 1);
    await adapter.close();
  });

  test('retention evicts settled jobs by count and by age', async () => {
    const { adapter, envelope, clock } = setup({
      default: { retention: { completed: { count: 2, age: '1h' } } },
    });
    const run = recorder();
    await adapter.startWorker({ queues: ['default'] }, run.process);
    for (let index = 0; index < 3; index += 1) await adapter.enqueue('default', envelope());
    await flush();
    await flush();
    assert.equal(adapter.counts('default').completed, 2);
    await clock.advance(3_600_001);
    await adapter.enqueue('default', envelope());
    await flush();
    await flush();
    assert.equal(adapter.counts('default').completed, 1);
    await adapter.close();
  });

  test('refuses undeclared queues, bad workers, and use after close, value-free', async () => {
    const { adapter, envelope } = setup();
    const code = (expected: string) => (error: unknown) =>
      error instanceof MemoryJobsError && error.code === expected;
    await assert.rejects(adapter.enqueue('nope', envelope()), code('unknown_queue'));
    await assert.rejects(
      adapter.startWorker({ queues: ['nope'] }, recorder().process),
      code('unknown_queue'),
    );
    await assert.rejects(
      adapter.startWorker({ queues: [] }, recorder().process),
      code('invalid_worker'),
    );
    await assert.rejects(
      adapter.startWorker({ queues: ['default'], concurrency: 0 }, recorder().process),
      code('invalid_worker'),
    );
    assert.throws(() => adapter.counts('nope'), code('unknown_queue'));
    await adapter.close();
    await assert.rejects(adapter.enqueue('default', envelope()), code('adapter_closed'));
    await assert.rejects(
      adapter.startWorker({ queues: ['default'] }, recorder().process),
      code('adapter_closed'),
    );
  });

  test('close cancels delayed jobs and stops workers', async () => {
    const { adapter, envelope, clock } = setup();
    const run = recorder();
    await adapter.startWorker({ queues: ['default'] }, run.process);
    await adapter.enqueue('default', envelope({ runAt: START + DAY_MS }));
    await adapter.close();
    assert.equal(clock.pending, 0);
    await clock.advance(2 * DAY_MS);
    assert.equal(run.deliveries.length, 0);
  });
});
