/**
 * Tests for the runtime's failed-job history hook: a job is recorded once,
 * only when it fails for the last time, and a failing history never replaces
 * the job's own error.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  InMemoryFailedJobHistory,
  type FailedJobHistory,
} from '../../src/jobs/failed-job-history.js';
import { MemoryJobsAdapter } from '../../src/jobs/memory-adapter.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { JobsRuntimeImpl, UnrecoverableJobError } from '../../src/jobs/runtime.js';
import { createExecutionContext, runInContext } from '../../src/context/execution-context.js';

/** Run `fn` as the request `requestId`, the way the request stage enters its context. */
function withRequestId<T>(requestId: string, fn: () => T): T {
  return runInContext(createExecutionContext({ requestId }), fn);
}

function setup(history: FailedJobHistory, handlers: { flaky?: () => void } = {}) {
  let flakyCalls = 0;
  const registry = createJobRegistry({
    broken: defineJob(z.object({ secretless: z.string() }), () => {
      throw new Error('always fails');
    }),
    flaky: defineJob(z.object({}), () => {
      flakyCalls += 1;
      handlers.flaky?.();
      if (flakyCalls < 2) throw new Error('transient');
    }),
    fatal: defineJob(z.object({}), () => {
      throw new UnrecoverableJobError('give up');
    }),
    ok: defineJob(z.object({}), () => undefined),
  });
  const adapter = new MemoryJobsAdapter();
  const runtime = new JobsRuntimeImpl({
    registry,
    adapter,
    queueName: 'mail',
    onJobFailed: false,
    failedJobs: history,
  });
  return { adapter, runtime };
}

const FAST = { backoff: { type: 'fixed', delay: 1 } };

describe('JobsRuntimeImpl failedJobs', () => {
  it('records a job once, after its last attempt, with queue, payload, attempts, and summary', async () => {
    const history = new InMemoryFailedJobHistory();
    const { adapter, runtime } = setup(history);
    await runtime.startWorker();
    await withRequestId('req-42', () =>
      runtime.dispatch('broken', { secretless: 'v' }, { attempts: 3, ...FAST }),
    );
    await adapter.drain();

    const entries = await history.list();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry);
    assert.equal(entry.queue, 'mail');
    assert.equal(entry.name, 'broken');
    assert.deepEqual(entry.data, { secretless: 'v' });
    assert.equal(entry.attempts, 3);
    assert.equal(entry.error, 'always fails');
    assert.equal(entry.errorName, 'Error');
    assert.equal(entry.requestId, 'req-42');
    await runtime.close();
  });

  it('does not record an attempt that will be retried, nor a job that later succeeds', async () => {
    const history = new InMemoryFailedJobHistory();
    const { adapter, runtime } = setup(history);
    await runtime.startWorker();
    await runtime.dispatch('flaky', {}, { attempts: 3, ...FAST });
    await runtime.dispatch('ok', {});
    await adapter.drain();
    assert.deepEqual(await history.list(), []);
    await runtime.close();
  });

  it('records a non-retryable failure at once, with its code', async () => {
    const history = new InMemoryFailedJobHistory();
    const { adapter, runtime } = setup(history);
    await runtime.startWorker();
    await runtime.dispatch('fatal', {}, { attempts: 5, ...FAST });
    await adapter.drain();
    const [entry] = await history.list();
    assert.equal(entry?.attempts, 1);
    assert.equal(entry?.errorCode, 'unrecoverable');
    await runtime.close();
  });

  it('keeps the job failing when the history rejects the record', async () => {
    const failing: FailedJobHistory = {
      record: () => Promise.reject(new Error('db down')),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      remove: () => Promise.resolve(false),
      take: () => Promise.resolve(undefined),
      restore: (entry) => Promise.resolve(entry),
      clear: () => Promise.resolve(0),
    };
    const { adapter, runtime } = setup(failing);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => logged.push(line);
    try {
      await runtime.startWorker();
      await runtime.dispatch('broken', { secretless: 'v' }, { attempts: 1 });
      await adapter.drain();
    } finally {
      console.error = original;
    }
    assert.equal((await runtime.readCounts()).failed, 1);
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', /could not record failed job "broken"/);
    assert.doesNotMatch(logged[0] ?? '', /secretless|db down/);
    await runtime.close();
  });

  it('records the dispatch options a retry replays and the batch it cannot rejoin', async () => {
    const history = new InMemoryFailedJobHistory();
    const { adapter, runtime } = setup(history);
    await runtime.startWorker();
    await runtime.dispatch(
      'broken',
      { secretless: 'v' },
      {
        attempts: 2,
        priority: 5,
        jobId: 'once',
        backoff: { type: 'fixed', delay: 1 },
        __jsailsBatch: { id: 'b1', total: 1, index: 0 },
      },
    );
    await adapter.drain();

    const [entry] = await history.list();
    assert.deepEqual(entry?.options, {
      attempts: 2,
      priority: 5,
      backoff: { type: 'fixed', delay: 1 },
    });
    assert.deepEqual(entry?.membership, ['batch']);
    await runtime.close();
  });

  it('records nothing and reports nothing for an attempt the shutdown aborted', async () => {
    const history = new InMemoryFailedJobHistory();
    const reported: unknown[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({
      registry: createJobRegistry({
        hang: defineJob(z.object({}), () => {
          started();
          return new Promise<void>(() => undefined);
        }),
      }),
      adapter,
      queueName: 'mail',
      shutdownTimeoutMs: 10,
      onJobFailed: (failure) => reported.push(failure),
      failedJobs: history,
    });
    await runtime.startWorker();
    await runtime.dispatch('hang', {}, { attempts: 1 });
    await running;

    await runtime.close();
    await adapter.drain();

    assert.deepEqual(await history.list(), [], 'the transport, not the history, owns the job');
    assert.deepEqual(reported, []);
  });

  it('requeues a job the shutdown aborted on its last attempt, whatever its error policy says', async () => {
    const history = new InMemoryFailedJobHistory();
    const reported: unknown[] = [];
    const reran: Array<[string, number]> = [];
    let hang = true;
    let startedCount = 0;
    let bothStarted!: () => void;
    const running = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const handler =
      (name: string) =>
      (_data: unknown, context: { attemptsMade: number }): Promise<void> => {
        if (!hang) {
          reran.push([name, context.attemptsMade]);
          return Promise.resolve();
        }
        startedCount += 1;
        if (startedCount === 2) bothStarted();
        return new Promise<void>(() => undefined);
      };
    // `retryOn` returning false would make the abort terminal and `discardOn`
    // would complete the job: neither may judge an error the job never threw.
    const registry = createJobRegistry({
      strict: defineJob(z.object({}), handler('strict'), {
        onError: { retryOn: () => false },
      }),
      lenient: defineJob(z.object({}), handler('lenient'), {
        onError: { discardOn: () => true },
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const options = {
      registry,
      adapter,
      queueName: 'mail',
      onJobFailed: (failure: unknown) => reported.push(failure),
      failedJobs: history,
    };
    const runtime = new JobsRuntimeImpl({ ...options, concurrency: 2, shutdownTimeoutMs: 10 });
    await runtime.startWorker();
    await runtime.dispatch('strict', {}, { attempts: 1 });
    await runtime.dispatch('lenient', {}, { attempts: 1 });
    await running;
    await runtime.close();

    hang = false;
    const next = new JobsRuntimeImpl(options);
    await next.startWorker();
    await adapter.drain();

    assert.deepEqual(
      reran.sort(),
      [
        ['lenient', 0],
        ['strict', 0],
      ],
      'both jobs run again on the next worker, with the interrupted attempt not counted',
    );
    const counts = await next.readCounts();
    assert.equal(counts.failed, 0);
    assert.equal(counts.completed, 2);
    assert.deepEqual(await history.list(), []);
    assert.deepEqual(reported, []);
    await next.close();
  });

  it('rejects a failedJobs value that is not a history', () => {
    assert.throws(
      () =>
        new JobsRuntimeImpl({
          registry: createJobRegistry({}),
          adapter: new MemoryJobsAdapter(),
          failedJobs: {} as FailedJobHistory,
        }),
      /failedJobs must implement/,
    );
  });
});
