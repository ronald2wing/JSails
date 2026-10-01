/**
 * Flows: a batch fires `then` or `catch` (never both) and `finally` exactly
 * once, survives redelivery and a producer restart, validates every item
 * before enqueueing any, and reports its counts (a child retried after the
 * batch settled is counted and fires nothing); a redelivered chain step
 * never forks the chain.
 */

import assert from 'node:assert/strict';

import type { ScenarioBatchCallbacks, ScenarioJob } from './driver.js';
import { eventually, latch, realDelay } from './recorder.js';
import { failOnPurpose, noopJob, type Harness, type ScenarioGroup } from './scenario.js';

const CALLBACK_MS = 3_000;
const STARTED_MS = 2_000;

const CALLBACK_JOBS: readonly ScenarioJob[] = [
  noopJob('on-then'),
  noopJob('on-catch'),
  noopJob('on-finally'),
];

const CALLBACKS: ScenarioBatchCallbacks = {
  then: { name: 'on-then', payload: null },
  catch: { name: 'on-catch', payload: null },
  finally: { name: 'on-finally', payload: null },
};

/** A child that fails when its payload says so. */
const CHILD: ScenarioJob = {
  name: 'child',
  handle: (payload) => (payload === 'fail' ? failOnPurpose('child failed') : Promise.resolve()),
};

/** Wait for `finally`, then a little longer so a duplicate callback has time to show. */
async function settledCallbacks({ driver, log }: Harness): Promise<{
  readonly then: number;
  readonly catch: number;
  readonly finally: number;
}> {
  await driver.settle();
  await eventually(() => log.count('on-finally') > 0, CALLBACK_MS);
  await realDelay(100);
  await driver.settle();
  return {
    then: log.count('on-then'),
    catch: log.count('on-catch'),
    finally: log.count('on-finally'),
  };
}

export const flowScenarios: ScenarioGroup = {
  name: 'flows',
  scenarios: [
    {
      name: 'a batch whose children all succeed fires then and finally, not catch',
      async run(harness) {
        const { driver, define } = harness;
        define([CHILD, ...CALLBACK_JOBS]);
        await driver.startWorker();
        await driver.batch(
          [1, 2, 3].map((payload) => ({ name: 'child', payload })),
          CALLBACKS,
        );
        const fired = await settledCallbacks(harness);
        assert.deepEqual(
          fired,
          { then: 1, catch: 0, finally: 1 },
          `a batch whose children all succeeded fired ${JSON.stringify(fired)}`,
        );
      },
    },
    {
      name: 'a batch with a failed child fires catch and finally, not then',
      async run(harness) {
        const { driver, define } = harness;
        define([CHILD, ...CALLBACK_JOBS]);
        await driver.startWorker();
        await driver.batch(
          [1, 'fail', 3].map((payload) => ({ name: 'child', payload })),
          CALLBACKS,
        );
        const fired = await settledCallbacks(harness);
        assert.deepEqual(
          fired,
          { then: 0, catch: 1, finally: 1 },
          `a batch with a failed child fired ${JSON.stringify(fired)}`,
        );
      },
    },
    {
      name: 'finally fires exactly once when batch children are redelivered',
      async run(harness) {
        const { driver, define, log } = harness;
        define([CHILD, ...CALLBACK_JOBS]);
        await driver.startWorker();
        await driver.batch(
          [1, 2].map((payload) => ({ name: 'child', payload })),
          CALLBACKS,
        );
        await settledCallbacks(harness);
        // Redelivering a callback job itself re-runs it (at-least-once); what
        // must not happen is a redelivered child settling the batch again.
        for (const execution of log.of('child')) {
          await driver.redeliver(execution.jobId);
        }
        const fired = await settledCallbacks(harness);
        assert.deepEqual(
          fired,
          { then: 1, catch: 0, finally: 1 },
          `redelivering a settled batch's jobs fired ${JSON.stringify(fired)}`,
        );
      },
    },
    {
      name: 'a batch with an invalid item enqueues nothing',
      async run({ driver, define, log }) {
        define([noopJob('strict-child', { accepts: (payload) => payload !== 'bad' })]);
        await assert.rejects(
          driver.batch(
            ['a', 'b', 'bad', 'c'].map((payload) => ({ name: 'strict-child', payload })),
            {},
          ),
          'a batch with an invalid item was accepted',
        );
        await driver.startWorker();
        await driver.settle();
        assert.equal(
          log.count('strict-child'),
          0,
          `a batch with an invalid item enqueued ${log.count('strict-child')} of its items`,
        );
      },
    },
    {
      name: 'a redelivered chain step does not enqueue the next step twice',
      async run({ driver, define, log }) {
        define([noopJob('step-a'), noopJob('step-b')]);
        await driver.startWorker();
        await driver.chain([
          { name: 'step-a', payload: null },
          { name: 'step-b', payload: null },
        ]);
        await driver.settle();
        const first = log.of('step-a')[0];
        assert.ok(first !== undefined && log.count('step-b') === 1, 'the chain did not run');
        await driver.redeliver(first.jobId);
        await driver.settle();
        assert.equal(
          log.count('step-b'),
          1,
          `redelivering chain step 1 ran step 2 ${log.count('step-b')} times`,
        );
      },
    },
    {
      name: 'batch callbacks fire after the producer restarts',
      async run(harness) {
        const { driver, define, log } = harness;
        const release = latch();
        define([{ name: 'gated-child', handle: () => release.promise }, ...CALLBACK_JOBS]);
        await driver.startWorker({ concurrency: 3 });
        await driver.batch(
          [1, 2, 3].map((payload) => ({ name: 'gated-child', payload })),
          CALLBACKS,
        );
        assert.ok(
          await eventually(() => log.count('gated-child') === 3, STARTED_MS),
          'children never started',
        );
        await driver.restartProducer();
        release.open();
        const fired = await settledCallbacks(harness);
        assert.deepEqual(
          fired,
          { then: 1, catch: 0, finally: 1 },
          `batch callbacks after a producer restart fired ${JSON.stringify(fired)}`,
        );
      },
    },
    {
      name: 'batch status counts children and reports settlement',
      async run(harness) {
        const { driver, define } = harness;
        define([CHILD, ...CALLBACK_JOBS]);
        await driver.startWorker();
        const batch = await driver.batch(
          [1, 'fail', 3].map((payload) => ({ name: 'child', payload })),
          CALLBACKS,
        );
        await settledCallbacks(harness);
        const status = await driver.batchStatus(batch.id);
        assert.ok(status !== undefined, 'the implementation reports no batch status');
        assert.deepEqual(
          {
            total: status.total,
            completed: status.completed,
            failed: status.failed,
            settled: status.settled,
          },
          { total: 3, completed: 2, failed: 1, settled: true },
          `batch status was ${JSON.stringify(status)}`,
        );
      },
    },
    {
      name: 'a child retried after its batch settled does not fire the callbacks again',
      async run(harness) {
        const { driver, define } = harness;
        define([CHILD, ...CALLBACK_JOBS]);
        await driver.startWorker();
        const batch = await driver.batch(
          [1, 'fail', 3].map((payload) => ({ name: 'child', payload })),
          CALLBACKS,
        );
        await settledCallbacks(harness);
        const failed = await driver.failed();
        assert.equal(failed.length, 1, `expected one failed child, found ${failed.length}`);
        // The child fails again on its payload; what matters is that its new
        // final outcome reaches no callback.
        assert.equal(await driver.retry(failed[0]!.id), 'retried');
        const fired = await settledCallbacks(harness);
        const status = await driver.batchStatus(batch.id);
        assert.ok(status !== undefined, 'the implementation reports no batch status');
        assert.equal(
          status.retriedAfterSettlement,
          1,
          `batch status counted ${status.retriedAfterSettlement} retries after settlement`,
        );
        assert.deepEqual(
          fired,
          { then: 0, catch: 1, finally: 1 },
          `retrying a child of a settled batch fired ${JSON.stringify(fired)}`,
        );
      },
    },
  ],
};
