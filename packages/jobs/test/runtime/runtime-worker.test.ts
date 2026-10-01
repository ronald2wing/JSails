/**
 * The runtime worker over the memory adapter, on the real clock unless a
 * test needs to count its timers: its states, drain with and without a
 * deadline, abort bounded while the job stays held, idempotence, an abort or
 * a poisoning ending a drain with a deadline, poisoning outside shutdown
 * (stops fetching, releases the cooperative attempts, reports once), a stuck
 * job never running twice at once, and option validation.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { createJobCatalog } from '../../src/definition/catalog.js';
import { defineJob, type JobContext } from '../../src/definition/define-job.js';
import { createProducer } from '../../src/definition/jobs-service.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { defineQueues } from '../../src/queues/queue-set.js';
import {
  startRuntimeWorker,
  type PoisonedWorkerReport,
  type RuntimeWorkerOptions,
} from '../../src/runtime/runtime-worker.js';
import { VirtualClock } from '../timing/virtual-clock.js';

const BOUND_MS = 5_000;

type Role = 'stuck' | 'cooperative' | 'quick';

interface Run {
  readonly role: Role;
  readonly attempt: number;
  readonly finish: () => void;
  readonly fail: () => void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + BOUND_MS;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await wait(2);
  }
}

/** A queue whose jobs say by payload how they behave, with a log of every run. */
function setup() {
  const runs: Run[] = [];
  let inFlight = 0;
  let maxInFlightStuck = 0;
  let stuckInFlight = 0;
  const handle = (payload: { role: Role }, context: JobContext): Promise<void> =>
    new Promise((resolve, reject) => {
      inFlight += 1;
      if (payload.role === 'stuck') {
        stuckInFlight += 1;
        maxInFlightStuck = Math.max(maxInFlightStuck, stuckInFlight);
      }
      const done = (): void => {
        inFlight -= 1;
        if (payload.role === 'stuck') stuckInFlight -= 1;
      };
      const finish = (): void => {
        done();
        resolve();
      };
      const fail = (): void => {
        done();
        reject(new Error('failed on purpose'));
      };
      runs.push({ role: payload.role, attempt: context.attempt, finish, fail });
      if (payload.role === 'quick') finish();
      if (payload.role === 'cooperative') {
        context.signal.addEventListener('abort', () => reject(context.signal.reason), {
          once: true,
        });
      }
    });
  const Work = defineJob({
    name: 'work',
    schema: z.object({ role: z.enum(['stuck', 'cooperative', 'quick']) }),
    attempts: 2,
    backoff: { type: 'fixed', delayMs: 0 },
    handle,
  });
  const catalog = createJobCatalog({
    queues: defineQueues({ default: { concurrency: 2 } }),
    definitions: [Work],
  });
  const adapter = new MemoryJobsAdapter({
    namespace: 'app:test',
    queues: catalog.queues.declarations,
  });
  const producer = createProducer({ catalog, adapter });
  const start = (options: Partial<RuntimeWorkerOptions<'default'>> = {}) =>
    startRuntimeWorker({
      catalog,
      adapter,
      jobs: producer,
      onPoisoned: () => {
        throw new Error('poisoned unexpectedly');
      },
      ...options,
    });
  const dispatch = (role: Role, timeoutMs?: number) =>
    producer.dispatch(Work.with({ role }), timeoutMs === undefined ? {} : { timeoutMs });
  const close = async (): Promise<void> => {
    producer.close();
    await adapter.close();
  };
  return {
    adapter,
    runs,
    start,
    dispatch,
    close,
    inFlight: () => inFlight,
    maxInFlightStuck: () => maxInFlightStuck,
  };
}

describe('runtime worker', () => {
  test('drain moves open, draining, closed and waits for in-flight attempts', async () => {
    const { runs, start, dispatch, close, adapter } = setup();
    const worker = await start();
    assert.equal(worker.state, 'open');
    await dispatch('stuck');
    await until(() => runs.length === 1, 'the job ran');
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    assert.equal(worker.state, 'draining');
    assert.equal(worker.held, 1);
    await wait(20);
    assert.equal(drained, false, 'drain returned with an attempt in flight');
    runs[0]?.finish();
    await draining;
    assert.equal(worker.state, 'closed');
    assert.equal(worker.held, 0);
    assert.equal(adapter.counts('default').completed, 1);
    await close();
  });

  test('a drain deadline aborts stragglers and returns within its bound', async () => {
    const { runs, start, dispatch, close, adapter } = setup();
    const worker = await start({ abortCollectMs: 50 });
    await dispatch('cooperative');
    await until(() => runs.length === 1, 'the job ran');
    const started = performance.now();
    await worker.drain({ deadlineMs: 50 });
    assert.ok(performance.now() - started < 50 + 50 + 500);
    assert.equal(worker.state, 'closed');
    assert.equal(adapter.counts('default').waiting, 1, 'the cooperative attempt was released');
    await close();
  });

  test('abort is bounded while a stuck job stays held, and the job never runs twice at once', async () => {
    const { runs, start, dispatch, close, adapter, maxInFlightStuck } = setup();
    const first = await start({ abortCollectMs: 50 });
    await dispatch('stuck');
    await until(() => runs.length === 1, 'the job ran');
    const started = performance.now();
    await first.abort();
    assert.ok(performance.now() - started < 50 + 500, 'abort was not bounded');
    assert.equal(first.state, 'closed');
    assert.equal(first.held, 1);
    assert.equal(adapter.counts('default').active, 1);
    const second = await start();
    await wait(30);
    assert.equal(runs.length, 1, 'a second worker took a job still held');
    runs[0]?.finish();
    await until(() => first.held === 0, 'the stuck attempt settled');
    await wait(20);
    assert.equal(runs.length, 1, 'a job completed after abort ran again');
    assert.equal(adapter.counts('default').completed, 1);
    assert.equal(maxInFlightStuck(), 1);
    await second.drain();
    await close();
  });

  test('abort and drain are idempotent; abort during a drain ends the drain', async () => {
    const { runs, start, dispatch, close } = setup();
    const worker = await start({ abortCollectMs: 50 });
    await dispatch('stuck');
    await until(() => runs.length === 1, 'the job ran');
    const draining = worker.drain();
    assert.equal(worker.drain(), draining);
    const aborting = worker.abort();
    assert.equal(worker.abort(), aborting);
    await draining;
    await aborting;
    assert.equal(worker.state, 'closed');
    assert.equal(worker.drain(), aborting, 'a drain after abort is the abort');
    runs[0]?.finish();
    await until(() => worker.held === 0, 'the attempt settled');
    await close();
  });

  test('an abort during a drain with a deadline ends the drain and cancels its deadline', async () => {
    const clock = new VirtualClock(Date.now());
    const { runs, start, dispatch, close } = setup();
    const worker = await start({ clock, abortCollectMs: 50, handlerGraceMs: 60_000 });
    await dispatch('stuck');
    await until(() => runs.length === 1, 'the job ran');
    let drained = false;
    const draining = worker.drain({ deadlineMs: 3_600_000 }).then(() => {
      drained = true;
    });
    const aborting = worker.abort();
    await clock.advance(50);
    await aborting;
    await until(() => drained, 'the drain ended with the abort');
    await draining;
    assert.equal(worker.state, 'closed');
    assert.equal(worker.held, 1);
    assert.equal(clock.pending, 1, "only the stuck attempt's grace may stay pending");
    runs[0]?.finish();
    await until(() => worker.held === 0, 'the attempt settled');
    assert.equal(clock.pending, 0);
    await close();
  });

  test('a poisoning during a drain with a deadline ends the drain', async () => {
    const { runs, start, dispatch, close } = setup();
    const reports: PoisonedWorkerReport[] = [];
    const worker = await start({
      handlerGraceMs: 100,
      abortCollectMs: 50,
      onPoisoned: (report) => reports.push(report),
    });
    await dispatch('stuck', 50);
    await until(() => runs.length === 1, 'the job ran');
    let drained = false;
    const draining = worker.drain({ deadlineMs: 60_000 }).then(() => {
      drained = true;
    });
    await until(() => drained, 'the drain ended with the poisoning');
    await draining;
    assert.equal(worker.poisoned, true);
    assert.equal(worker.state, 'closed');
    await until(() => reports.length === 1, 'the poisoning was reported');
    runs[0]?.finish();
    await until(() => worker.held === 0, 'the attempt settled');
    await close();
  });

  test('a drained worker aborts to its drain', async () => {
    const { start, close } = setup();
    const worker = await start();
    const drained = worker.drain();
    await drained;
    assert.equal(worker.abort(), drained);
    await close();
  });

  test('an attempt past its grace poisons the worker: it stops, releases the rest, and reports once', async () => {
    const { runs, start, dispatch, close, adapter } = setup();
    const reports: { report: PoisonedWorkerReport; poisoned: boolean; state: string }[] = [];
    const worker = await start({
      handlerGraceMs: 100,
      abortCollectMs: 50,
      onPoisoned: (report) => {
        reports.push({ report, poisoned: worker.poisoned, state: worker.state });
      },
    });
    await dispatch('stuck', 50);
    await dispatch('cooperative');
    await dispatch('quick');
    await until(() => runs.length === 2, 'both attempts started');
    await until(() => reports.length === 1, 'the worker was poisoned');
    assert.deepEqual(reports, [{ report: { held: 1 }, poisoned: true, state: 'closed' }]);
    assert.equal(worker.poisoned, true);
    await wait(30);
    assert.equal(reports.length, 1);
    assert.deepEqual(
      runs.map((run) => run.role),
      ['stuck', 'cooperative'],
      'the poisoned worker kept fetching',
    );
    assert.equal(adapter.counts('default').waiting, 2, 'the cooperative job was released');
    const healthy = await start();
    await until(() => runs.length === 4, 'the healthy worker ran the waiting jobs');
    const cooperative = runs.slice(2).find((run) => run.role === 'cooperative');
    assert.equal(cooperative?.attempt, 1, 'a shutdown release spent an attempt');
    cooperative?.finish();
    runs[0]?.finish();
    await until(() => worker.held === 0, 'the stuck attempt settled');
    await healthy.drain();
    assert.equal(adapter.counts('default').completed, 3);
    await close();
  });

  test('after poisoning, a stuck job that then fails runs again only once its first run settled', async () => {
    const { runs, start, dispatch, close, adapter, maxInFlightStuck } = setup();
    const first = await start({
      handlerGraceMs: 50,
      abortCollectMs: 20,
      onPoisoned: () => undefined,
    });
    await dispatch('stuck', 30);
    await until(() => first.poisoned, 'the worker was poisoned');
    const second = await start();
    await wait(30);
    assert.equal(runs.length, 1, 'the job ran again while its first run was in flight');
    runs[0]?.fail();
    await until(() => runs.length === 2, 'the retry ran');
    assert.equal(runs[1]?.attempt, 2);
    assert.equal(maxInFlightStuck(), 1);
    runs[1]?.finish();
    await second.drain();
    assert.equal(adapter.counts('default').completed, 1);
    await close();
  });

  test('options are checked, value-free', async () => {
    const { adapter, close } = setup();
    const catalog = createJobCatalog({ queues: defineQueues({}), definitions: [] });
    const producer = createProducer({ catalog, adapter });
    const base = { catalog, adapter, jobs: producer };
    const refusals: [Record<string, unknown>, string | undefined][] = [
      [{ ...base, catalog: {} }, 'catalog'],
      [{ ...base, adapter: {} }, 'adapter'],
      [{ ...base, jobs: { dispatch: () => undefined } }, 'jobs'],
      [{ ...base, jobs: { ...producer, chain: undefined } }, 'jobs'],
      [{ ...base, catalog: { get: () => undefined, queues: catalog.queues } }, 'catalog'],
      [{ ...base, adapter: { startWorker: () => undefined, enqueue: () => undefined } }, 'adapter'],
      [{ ...base, queues: [] }, 'queues'],
      [{ ...base, queues: ['mail'] }, 'queues'],
      [{ ...base, concurrency: 0 }, 'concurrency'],
      [{ ...base, handlerGraceMs: -1 }, 'handlerGraceMs'],
      [{ ...base, abortCollectMs: 60_001 }, 'abortCollectMs'],
      [{ ...base, storeErrorMessages: 'yes' }, 'storeErrorMessages'],
      [{ ...base, signals: {} }, 'signals'],
      [{ ...base, clock: {} }, 'clock'],
      [{ ...base, onPoisoned: 1 }, 'onPoisoned'],
      [{ ...base, timeout: 1 }, undefined],
    ];
    for (const [options, option] of refusals) {
      await assert.rejects(
        startRuntimeWorker(options as unknown as RuntimeWorkerOptions),
        (error: unknown) =>
          option === undefined
            ? JobsErrors.is(error, 'unknown_option')
            : JobsErrors.is(error, 'invalid_worker') &&
              (error.context as { option?: unknown }).option === option,
        option,
      );
    }
    await assert.rejects(
      startRuntimeWorker(null as unknown as RuntimeWorkerOptions),
      (error: unknown) => JobsErrors.is(error, 'invalid_worker'),
    );
    const worker = await startRuntimeWorker(base);
    await assert.rejects(worker.drain({ deadlineMs: -1 }), (error: unknown) =>
      JobsErrors.is(error, 'invalid_worker'),
    );
    await worker.drain();
    producer.close();
    await close();
  });

  test('a catalog with overlap control needs an adapter with leases', async () => {
    const Locked = defineJob({
      name: 'locked',
      schema: z.unknown(),
      overlap: true,
      handle: () => {},
    });
    const catalog = createJobCatalog({ queues: defineQueues({}), definitions: [Locked] });
    const leaseless = {
      name: 'leaseless',
      reach: 'process' as const,
      capabilities: {},
      enqueue: () => Promise.reject(new Error('not used')),
      startWorker: () => Promise.reject(new Error('not used')),
      close: () => Promise.resolve(),
    };
    const memory = new MemoryJobsAdapter({
      namespace: 'app:test',
      queues: catalog.queues.declarations,
    });
    const producer = createProducer({ catalog, adapter: memory });
    await assert.rejects(
      startRuntimeWorker({ catalog, adapter: leaseless, jobs: producer }),
      (error: unknown) =>
        JobsErrors.is(error, 'capability_missing') && error.context.capability === 'leases',
    );
    const worker = await startRuntimeWorker({ catalog, adapter: memory, jobs: producer });
    await worker.drain();
    producer.close();
    await memory.close();
  });
});
