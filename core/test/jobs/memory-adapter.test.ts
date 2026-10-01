/** Tests for the in-process job adapter driven through the neutral runtime. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { MAX_TIMER_MS, MemoryJobsAdapter } from '../../src/jobs/memory-adapter.js';
import { createJobRegistry, defineJob } from '../../src/jobs/registry.js';
import { JobsRuntimeError, JobsRuntimeImpl } from '../../src/jobs/runtime.js';

describe('MemoryJobsAdapter', () => {
  it('runs dispatched jobs in-process and reports counts', async () => {
    const seen: string[] = [];
    const registry = createJobRegistry({
      greet: defineJob(z.object({ who: z.string() }), (data) => {
        seen.push(data.who);
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, concurrency: 2 });
    await runtime.startWorker();
    await runtime.dispatch('greet', { who: 'a' });
    await runtime.dispatch('greet', { who: 'b' }, { delay: 5 });
    await runtime.dispatch('greet', { who: 'a-again' }, { jobId: 'once' });
    await runtime.dispatch('greet', { who: 'dup' }, { jobId: 'once' });
    await adapter.drain();
    assert.deepEqual(seen.sort(), ['a', 'a-again', 'b']);
    assert.deepEqual(await runtime.readCounts(), {
      waiting: 0,
      active: 0,
      completed: 3,
      failed: 0,
      delayed: 0,
    });
    await runtime.close();
  });

  it('retries with backoff, then fails terminally', async () => {
    let calls = 0;
    const registry = createJobRegistry({
      flaky: defineJob(z.object({}), () => {
        calls += 1;
        if (calls < 2) throw new Error('transient');
      }),
      broken: defineJob(z.object({}), () => {
        throw new Error('always');
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    await runtime.startWorker();
    await runtime.dispatch('flaky', {}, { backoff: 1 });
    await runtime.dispatch('broken', {}, { attempts: 2, backoff: { type: 'fixed', delay: 1 } });
    await adapter.drain();
    assert.equal(calls, 2);
    const counts = await runtime.readCounts();
    assert.equal(counts.completed, 1);
    assert.equal(counts.failed, 1);
    await runtime.close();
  });

  it('does not retry a non-retryable failure', async () => {
    let calls = 0;
    const registry = createJobRegistry({
      permanent: defineJob(
        z.object({}),
        () => {
          calls += 1;
          throw new Error('bad input');
        },
        { onError: { retryOn: () => false } },
      ),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    await runtime.startWorker();
    await runtime.dispatch('permanent', {}, { backoff: 1 });
    await adapter.drain();
    assert.equal(calls, 1);
    await runtime.close();
  });

  it('deduplicates a jobId only while that job exists', async () => {
    const seen: string[] = [];
    let failNext = true;
    const registry = createJobRegistry({
      greet: defineJob(z.object({ who: z.string() }), (data) => {
        seen.push(data.who);
      }),
      fragile: defineJob(z.object({}), () => {
        if (failNext) {
          failNext = false;
          throw new Error('first run fails');
        }
        seen.push('fragile');
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    await runtime.startWorker();
    await runtime.dispatch('greet', { who: 'first' }, { jobId: 'same' });
    await adapter.drain();
    await runtime.dispatch('greet', { who: 'second' }, { jobId: 'same' });
    await adapter.drain();
    assert.deepEqual(seen, ['first', 'second'], 'a completed jobId can be dispatched again');

    await runtime.dispatch('fragile', {}, { jobId: 'retry-me', attempts: 1 });
    await adapter.drain();
    await runtime.dispatch('fragile', {}, { jobId: 'retry-me', attempts: 1 });
    await adapter.drain();
    assert.deepEqual(
      seen,
      ['first', 'second', 'fragile'],
      'a failed jobId can be dispatched again',
    );
    await runtime.close();
  });

  it('holds jobs while paused and runs them on resume', async () => {
    const seen: number[] = [];
    const registry = createJobRegistry({
      count: defineJob(z.object({ n: z.number() }), (data) => {
        seen.push(data.n);
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runtime.pauseQueue();
    await runtime.dispatch('count', { n: 1 });
    await adapter.drain();
    assert.deepEqual(seen, []);
    await runtime.resumeQueue();
    await adapter.drain();
    assert.deepEqual(seen, [1]);
    await runtime.close();
  });

  it('registers interval schedules, prunes stale ones, and rejects cron', async () => {
    const registry = createJobRegistry({ tick: defineJob(z.object({}), () => undefined) });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.upsertSchedules([
      { id: 'a', job: 'tick', intervalMs: 60_000 },
      { id: 'b', job: 'tick', intervalMs: 60_000 },
    ]);
    await runtime.upsertSchedules([{ id: 'a', job: 'tick', intervalMs: 60_000 }]);
    assert.deepEqual(
      (await runtime.listSchedules()).map((entry) => entry.id),
      ['a'],
    );
    await assert.rejects(
      runtime.upsertSchedules([{ id: 'c', job: 'tick', cron: '* * * * *' }]),
      JobsRuntimeError,
    );
    await runtime.close();
  });

  it('holds a delay or retry backoff longer than a Node timer can, without running it early', async () => {
    let runs = 0;
    const registry = createJobRegistry({
      tick: defineJob(z.object({}), () => {
        runs += 1;
      }),
      failOnce: defineJob(z.object({}), () => {
        runs += 1;
        if (runs === 1) throw new Error('transient');
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    await runtime.startWorker();

    await runtime.dispatch('tick', {}, { delay: MAX_TIMER_MS + 1 });
    // A common BullMQ setting: 1000 ms doubled over 24 retries reaches about
    // 97 days, which only matters if that late retry is ever reached.
    await runtime.dispatch('tick', {}, { attempts: 25, delay: MAX_TIMER_MS + 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs, 0, 'a delay past the timer limit does not fire after 1 ms');
    assert.equal((await runtime.readCounts()).delayed, 2);
    await runtime.close();

    const retrying = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    await retrying.startWorker();
    await retrying.dispatch('failOnce', {}, { attempts: 2, backoff: MAX_TIMER_MS + 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs, 1, 'a backoff past the timer limit does not retry after 1 ms');
    assert.equal((await retrying.readCounts()).delayed, 1);
    await retrying.close();
  });

  it('runs a job whose delay spans several timer steps once the whole delay has passed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let runs = 0;
    const registry = createJobRegistry({
      tick: defineJob(z.object({}), () => {
        runs += 1;
      }),
    });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.startWorker();
    await runtime.dispatch('tick', {}, { delay: MAX_TIMER_MS + 5 });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    t.mock.timers.tick(MAX_TIMER_MS);
    await settle();
    assert.equal(runs, 0, 'the first step re-arms for the remainder');
    t.mock.timers.tick(5);
    await adapter.drain();
    assert.equal(runs, 1);
    await runtime.close();
  });

  it('refuses a schedule interval a Node timer would fire after 1 ms', async () => {
    const registry = createJobRegistry({ tick: defineJob(z.object({}), () => undefined) });
    const adapter = new MemoryJobsAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await assert.rejects(
      runtime.upsertSchedules([
        { id: 'ok', job: 'tick', intervalMs: 60_000 },
        { id: 'far', job: 'tick', intervalMs: MAX_TIMER_MS + 1 },
      ]),
      (error: unknown) => {
        assert.ok(error instanceof JobsRuntimeError);
        assert.equal(error.code, 'unsupported_operation');
        assert.match(error.message, /longer than 2147483647 ms/);
        return true;
      },
    );
    assert.deepEqual(await runtime.listSchedules(), [], 'a refused list registers nothing');
    await runtime.close();
  });
});
