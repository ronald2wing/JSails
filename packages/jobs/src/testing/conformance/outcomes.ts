/**
 * Attempt outcomes: a shutdown releases a job without spending an attempt or
 * recording a failure, an in-flight handler keeps working while its worker
 * drains, and an overlap skip is its own outcome that never advances a chain.
 */

import assert from 'node:assert/strict';

import { eventually, latch, realDelay } from './recorder.js';
import { noopJob, untilAborted, type ScenarioGroup } from './scenario.js';

const STARTED_MS = 2_000;

export const outcomeScenarios: ScenarioGroup = {
  name: 'outcomes',
  scenarios: [
    {
      name: 'a shutdown release does not consume an attempt',
      async run({ driver, define, log }) {
        define([
          {
            name: 'long',
            attempts: 3,
            handle: (_payload, context) =>
              log.count('long') === 1 ? untilAborted(context.signal) : Promise.resolve(),
          },
        ]);
        const first = await driver.startWorker();
        await driver.dispatch({ name: 'long', payload: null });
        assert.ok(await eventually(() => log.count('long') === 1, STARTED_MS), 'job never started');
        await driver.drain(first);
        await driver.startWorker();
        await driver.settle();
        const attempts = log.of('long').map((execution) => execution.attempt);
        assert.deepEqual(
          attempts,
          [1, 1],
          `a shutdown release must not consume an attempt; attempts seen ${JSON.stringify(attempts)}`,
        );
      },
    },
    {
      name: 'an attempts:1 job released by shutdown is not in the failed set',
      async run({ driver, define, log }) {
        define([
          {
            name: 'single',
            attempts: 1,
            handle: (_payload, context) =>
              log.count('single') === 1 ? untilAborted(context.signal) : Promise.resolve(),
          },
        ]);
        const first = await driver.startWorker();
        await driver.dispatch({ name: 'single', payload: null });
        assert.ok(
          await eventually(() => log.count('single') === 1, STARTED_MS),
          'job never started',
        );
        await driver.drain(first);
        const failed = await driver.failed();
        assert.equal(
          failed.length,
          0,
          `a job released by shutdown was recorded as failed (${failed.length} entries)`,
        );
        await driver.startWorker();
        await driver.settle();
        assert.equal(log.count('single'), 2, 'the released job did not run again');
      },
    },
    {
      name: 'an in-flight handler can dispatch while its worker drains',
      async run({ driver, define, log }) {
        const draining = latch();
        define([
          {
            name: 'parent',
            handle: async (_payload, context) => {
              await draining.promise;
              await context.dispatch({ name: 'child', payload: null });
            },
          },
          noopJob('child'),
        ]);
        const first = await driver.startWorker();
        await driver.dispatch({ name: 'parent', payload: null });
        assert.ok(
          await eventually(() => log.count('parent') === 1, STARTED_MS),
          'job never started',
        );
        const drained = driver.drain(first);
        draining.open();
        await drained;
        assert.equal(
          log.of('parent')[0]?.outcome,
          'returned',
          'an in-flight handler could not dispatch while its worker drained',
        );
        await driver.startWorker();
        await driver.settle();
        assert.equal(log.count('child'), 1, 'the job dispatched during the drain never ran');
      },
    },
    {
      name: 'an overlap skip is reported as skipped, not completed',
      async run({ driver, define, log }) {
        const release = latch();
        define([
          {
            name: 'exclusive',
            overlap: { key: 'exclusive', ttlMs: 60_000 },
            handle: () => release.promise,
          },
        ]);
        await driver.startWorker({ concurrency: 2 });
        await driver.dispatch({ name: 'exclusive', payload: 1 });
        assert.ok(
          await eventually(() => log.count('exclusive') === 1, STARTED_MS),
          'job never started',
        );
        await driver.dispatch({ name: 'exclusive', payload: 2 });
        await eventually(
          () => driver.events().some((event) => event.kind === 'skipped'),
          STARTED_MS,
        );
        release.open();
        await driver.settle();
        const kinds = driver.events().map((event) => event.kind);
        assert.equal(log.count('exclusive'), 1, 'the overlapping run was not skipped');
        assert.deepEqual(
          kinds.toSorted(),
          ['completed', 'skipped'],
          `an overlap skip was not reported as skipped (events: ${JSON.stringify(kinds)})`,
        );
      },
    },
    {
      name: 'an overlap skip does not advance a chain',
      async run({ driver, define, log }) {
        const release = latch();
        define([
          {
            name: 'exclusive-step',
            overlap: { key: 'exclusive-step', ttlMs: 60_000 },
            handle: (payload) => (payload === 'holder' ? release.promise : Promise.resolve()),
          },
          noopJob('after'),
        ]);
        await driver.startWorker({ concurrency: 2 });
        await driver.dispatch({ name: 'exclusive-step', payload: 'holder' });
        assert.ok(
          await eventually(() => log.count('exclusive-step') === 1, STARTED_MS),
          'job never started',
        );
        await driver.chain([
          { name: 'exclusive-step', payload: 'chained' },
          { name: 'after', payload: null },
        ]);
        // The chained step meets the held key and is skipped; give it time to.
        await realDelay(300);
        release.open();
        await driver.settle();
        assert.equal(log.count('exclusive-step'), 1, 'the overlapping chain step was not skipped');
        assert.equal(
          log.count('after'),
          0,
          `an overlap-skipped chain step advanced the chain (${log.count('after')} runs)`,
        );
      },
    },
  ],
};
