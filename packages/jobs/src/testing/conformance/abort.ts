/**
 * Abort: it finishes in bounded time whatever handlers and middleware do, the
 * aborting worker never fetches the job it released, and a handler that
 * ignores its signal never runs alongside its own next attempt.
 */

import assert from 'node:assert/strict';

import { eventually, latch, realDelay, within } from './recorder.js';
import { noopJob, untilAborted, type ScenarioGroup } from './scenario.js';

const STARTED_MS = 2_000;
const ABORT_BOUND_MS = 5_000;

export const abortScenarios: ScenarioGroup = {
  name: 'abort',
  scenarios: [
    {
      name: 'abort is bounded with a handler that ignores its signal',
      async run({ driver, define, log }) {
        const stuck = latch();
        define([{ name: 'stubborn', handle: () => stuck.promise }]);
        try {
          const worker = await driver.startWorker();
          await driver.dispatch({ name: 'stubborn', payload: null });
          assert.ok(
            await eventually(() => log.count('stubborn') === 1, STARTED_MS),
            'job never started',
          );
          await within(
            driver.abort(worker),
            ABORT_BOUND_MS,
            `abort did not resolve within ${ABORT_BOUND_MS} ms with a handler that ignores its signal`,
          );
        } finally {
          stuck.open();
        }
      },
    },
    {
      name: 'abort is bounded with a middleware that never returns',
      async run({ driver, define }) {
        const stuck = latch();
        let entered = false;
        define([
          noopJob('guarded', {
            middleware: async (_context, next) => {
              entered = true;
              await stuck.promise;
              await next();
            },
          }),
        ]);
        try {
          const worker = await driver.startWorker();
          await driver.dispatch({ name: 'guarded', payload: null });
          assert.ok(await eventually(() => entered, STARTED_MS), 'middleware never ran');
          await within(
            driver.abort(worker),
            ABORT_BOUND_MS,
            `abort did not resolve within ${ABORT_BOUND_MS} ms with a middleware that never returns`,
          );
        } finally {
          stuck.open();
        }
      },
    },
    {
      name: 'a job released by abort is not fetched again by the aborting worker',
      async run({ driver, define, log }) {
        define([
          {
            name: 'held',
            attempts: 3,
            handle: (_payload, context) =>
              log.count('held') === 1 ? untilAborted(context.signal) : Promise.resolve(),
          },
        ]);
        const worker = await driver.startWorker();
        await driver.dispatch({ name: 'held', payload: null });
        assert.ok(await eventually(() => log.count('held') === 1, STARTED_MS), 'job never started');
        await within(driver.abort(worker), ABORT_BOUND_MS, 'abort did not resolve');
        await realDelay(100);
        assert.equal(
          log.count('held'),
          1,
          `the aborting worker fetched the job it released (${log.count('held')} runs)`,
        );
        await driver.startWorker();
        await driver.settle();
        assert.equal(log.count('held'), 2, 'the released job did not run on the next worker');
      },
    },
    {
      name: 'a job never runs alongside its own attempt abandoned by abort',
      async run({ driver, define, log }) {
        const stuck = latch();
        define([
          {
            name: 'stubborn',
            attempts: 3,
            handle: () => (log.count('stubborn') === 1 ? stuck.promise : Promise.resolve()),
          },
        ]);
        try {
          const first = await driver.startWorker();
          await driver.dispatch({ name: 'stubborn', payload: null });
          assert.ok(
            await eventually(() => log.count('stubborn') === 1, STARTED_MS),
            'job never started',
          );
          await within(driver.abort(first), ABORT_BOUND_MS, 'abort did not resolve');
          await driver.startWorker();
          await realDelay(300);
          assert.equal(
            log.maxConcurrent,
            1,
            `a job ran alongside its own abandoned attempt (${log.maxConcurrent} runs in flight)`,
          );
        } finally {
          stuck.open();
        }
      },
    },
  ],
};
