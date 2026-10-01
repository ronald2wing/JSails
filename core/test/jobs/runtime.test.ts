/**
 * Tests for the neutral runtime's execution policy: per-attempt timeouts and
 * the abort signal, the shutdown drain deadline, terminal (non-retryable)
 * failures, the middleware's final-failure view, and schedule pruning. Every
 * case runs against an in-memory fake adapter; nothing connects.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import type { JobMiddlewareContext } from '../../src/jobs/middleware.js';
import { createJobRegistry, defineJob, JobPayloadError } from '../../src/jobs/registry.js';
import {
  isJobErrorNonRetryable,
  JobsRuntimeClosedError,
  JobsRuntimeImpl,
  JobTimeoutError,
  UnrecoverableJobError,
  type JobsRuntimeAdapter,
  type ProcessJob,
  type RuntimeJob,
  type ScheduleInfo,
} from '../../src/jobs/runtime.js';
import { ScheduleError, type PreparedSchedule } from '../../src/jobs/scheduler.js';

interface FakeState {
  processJob: ProcessJob | undefined;
  upserted: string[];
  registered: string[];
  removed: string[];
  workerClosed: Array<boolean | undefined>;
}

/** A fake adapter whose worker close waits for `inFlight` unless forced. */
function fakeAdapter(inFlight: Set<Promise<unknown>> = new Set()): {
  adapter: JobsRuntimeAdapter;
  state: FakeState;
} {
  const state: FakeState = {
    processJob: undefined,
    upserted: [],
    registered: [],
    removed: [],
    workerClosed: [],
  };
  const adapter: JobsRuntimeAdapter = {
    name: 'fake',
    createProducer: () => ({
      dispatch: () => Promise.resolve({ id: 'job-1' }),
      close: () => Promise.resolve(),
    }),
    createWorker: (_context, processJob) => {
      state.processJob = processJob;
      return {
        close: async (force) => {
          state.workerClosed.push(force);
          if (force !== true) {
            await Promise.allSettled([...inFlight]);
          }
        },
      };
    },
    upsertSchedules: (_producer, schedules: readonly PreparedSchedule[]) => {
      for (const entry of schedules) {
        state.upserted.push(entry.id);
        if (!state.registered.includes(entry.id)) state.registered.push(entry.id);
      }
      return Promise.resolve();
    },
    listSchedules: (): Promise<readonly ScheduleInfo[]> =>
      Promise.resolve(state.registered.map((id) => ({ id, job: 'work', repeat: 'every 1000ms' }))),
    removeSchedules: (_producer, ids) => {
      state.removed.push(...ids);
      state.registered = state.registered.filter((id) => !ids.includes(id));
      return Promise.resolve();
    },
  };
  return { adapter, state };
}

function runtimeJob(overrides: Partial<RuntimeJob> = {}): RuntimeJob {
  return {
    name: 'work',
    id: 'job-1',
    data: {},
    attemptsMade: 0,
    attemptsStarted: 1,
    opts: { attempts: 3 },
    log: () => Promise.resolve(),
    updateProgress: () => Promise.resolve(),
    ...overrides,
  };
}

async function startedWorker(runtime: JobsRuntimeImpl, state: FakeState): Promise<ProcessJob> {
  await runtime.startWorker();
  assert.ok(state.processJob !== undefined);
  return state.processJob;
}

describe('job timeouts', () => {
  it('fails an attempt past its timeout and aborts the context signal', async () => {
    let seen: AbortSignal | undefined;
    const registry = createJobRegistry({
      work: defineJob({
        schema: z.object({}),
        timeoutMs: 20,
        handler: (_data, context) => {
          seen = context.signal;
          return new Promise<void>(() => undefined);
        },
      }),
    });
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    const processJob = await startedWorker(runtime, state);
    await assert.rejects(processJob(runtimeJob()), (error: unknown) => {
      assert.ok(error instanceof JobTimeoutError);
      assert.equal(error.code, 'timed_out');
      assert.equal(isJobErrorNonRetryable(error), false, 'a timeout is retried');
      return true;
    });
    assert.equal(seen?.aborted, true);
    assert.ok(seen?.reason instanceof JobTimeoutError);
    await runtime.close();
  });

  it('applies the runtime jobTimeoutMs to jobs that declare none', async () => {
    const registry = createJobRegistry({
      work: defineJob(z.object({}), () => new Promise<void>(() => undefined)),
    });
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      jobTimeoutMs: 20,
      onJobFailed: false,
    });
    const processJob = await startedWorker(runtime, state);
    await assert.rejects(processJob(runtimeJob()), JobTimeoutError);
    await runtime.close();
  });

  it('rejects an invalid timeout at definition time', () => {
    assert.throws(
      () => defineJob({ schema: z.object({}), handler: () => undefined, timeoutMs: 0 }),
      /timeoutMs must be an integer/,
    );
    const { adapter } = fakeAdapter();
    assert.throws(
      () => new JobsRuntimeImpl({ registry: {}, adapter, jobTimeoutMs: -1 }),
      /jobTimeoutMs must be an integer/,
    );
  });
});

describe('shutdown drain deadline', () => {
  it('aborts a hung job after shutdownTimeoutMs so close() completes', async () => {
    const inFlight = new Set<Promise<unknown>>();
    let seen: AbortSignal | undefined;
    const registry = createJobRegistry({
      work: defineJob(z.object({}), (_data, context) => {
        seen = context.signal;
        return new Promise<void>(() => undefined);
      }),
    });
    const { adapter, state } = fakeAdapter(inFlight);
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      shutdownTimeoutMs: 20,
      onJobFailed: false,
    });
    const processJob = await startedWorker(runtime, state);
    const running = processJob(runtimeJob());
    inFlight.add(running);
    const outcome = assert.rejects(running, JobsRuntimeClosedError);

    await runtime.close();
    await outcome;
    assert.equal(seen?.aborted, true);
    assert.deepEqual(state.workerClosed, [undefined, true]);
  });

  it('closes without forcing when jobs drain in time', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry: {}, adapter, shutdownTimeoutMs: 1000 });
    await runtime.startWorker();
    await runtime.close();
    assert.deepEqual(state.workerClosed, [undefined]);
  });
});

describe('terminal failures', () => {
  it('marks unknown jobs, invalid payloads, and retryOn=false errors non-retryable', async () => {
    class Permanent extends Error {}
    const registry = createJobRegistry({
      work: defineJob(
        z.object({ kind: z.string() }),
        (data) => {
          throw data.kind === 'permanent' ? new Permanent('no') : new Error('flaky');
        },
        { onError: { retryOn: (error) => !(error instanceof Permanent) } },
      ),
    });
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter, onJobFailed: false });
    const processJob = await startedWorker(runtime, state);

    const outcomes: unknown[] = [];
    for (const job of [
      runtimeJob({ name: 'ghost' }),
      runtimeJob({ data: { kind: 1 } }),
      runtimeJob({ data: { kind: 'permanent' } }),
      runtimeJob({ data: { kind: 'transient' } }),
    ]) {
      await processJob(job).catch((error: unknown) => outcomes.push(error));
    }
    assert.ok(outcomes[1] instanceof JobPayloadError);
    assert.deepEqual(outcomes.map(isJobErrorNonRetryable), [true, true, true, false]);
    assert.equal(isJobErrorNonRetryable(new UnrecoverableJobError('stop')), true);
    const bullmqUnrecoverable = new Error('stop');
    bullmqUnrecoverable.name = 'UnrecoverableError';
    assert.equal(isJobErrorNonRetryable(bullmqUnrecoverable), true);
    await runtime.close();
  });

  it('tells middleware whether a failure is final', async () => {
    const verdicts: boolean[] = [];
    const registry = createJobRegistry({
      work: defineJob(z.object({}), () => {
        throw new Error('boom');
      }),
    });
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({
      registry,
      adapter,
      onJobFailed: false,
      middleware: {
        work: [
          async (_data, context: JobMiddlewareContext, next) => {
            try {
              return await next();
            } catch (error) {
              verdicts.push(context.isFinalFailure?.(error) ?? true);
              throw error;
            }
          },
        ],
      },
    });
    const processJob = await startedWorker(runtime, state);
    for (const attemptsMade of [0, 1, 2]) {
      await assert.rejects(processJob(runtimeJob({ attemptsMade })));
    }
    assert.deepEqual(verdicts, [false, false, true]);
    await runtime.close();
  });
});

describe('schedule reconciliation', () => {
  const registry = createJobRegistry({ work: defineJob(z.object({}), () => undefined) });

  it('removes provider schedules that are no longer declared', async () => {
    const { adapter, state } = fakeAdapter();
    state.registered.push('renamed-away', 'keep');
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.upsertSchedules([{ id: 'keep', job: 'work', intervalMs: 1000 }]);
    assert.deepEqual(state.removed, ['renamed-away']);
    assert.deepEqual(state.registered, ['keep']);
    await runtime.close();
  });

  it('keeps undeclared schedules with prune: false', async () => {
    const { adapter, state } = fakeAdapter();
    state.registered.push('other');
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await runtime.upsertSchedules([{ id: 'keep', job: 'work', intervalMs: 1000 }], {
      prune: false,
    });
    assert.deepEqual(state.removed, []);
    await runtime.close();
  });

  it('rejects an invalid cron pattern before writing any schedule', async () => {
    const { adapter, state } = fakeAdapter();
    const runtime = new JobsRuntimeImpl({ registry, adapter });
    await assert.rejects(
      runtime.upsertSchedules([
        { id: 'first', job: 'work', intervalMs: 1000 },
        { id: 'broken', job: 'work', cron: '61 * * * *' },
      ]),
      (error: unknown) => error instanceof ScheduleError && error.code === 'invalid_cron',
    );
    assert.deepEqual(state.upserted, []);
    await runtime.close();
  });
});
