/**
 * Idempotency keys: a key deduplicates every dispatch of the same key for its
 * window, whatever happened to the first job, and any string is a valid key.
 */

import assert from 'node:assert/strict';

import { noopJob, type ScenarioGroup } from './scenario.js';

const WINDOW_MS = 60_000;

export const keyScenarios: ScenarioGroup = {
  name: 'keys',
  scenarios: [
    {
      name: 'a duplicate key inside its window runs once',
      async run({ driver, define, log }) {
        define([noopJob('keyed')]);
        await driver.dispatch({ name: 'keyed', payload: 1 }, { key: 'k', keyWindowMs: WINDOW_MS });
        await driver.dispatch({ name: 'keyed', payload: 2 }, { key: 'k', keyWindowMs: WINDOW_MS });
        await driver.startWorker();
        await driver.settle();
        assert.equal(
          log.count('keyed'),
          1,
          `two dispatches of one key inside its window ran ${log.count('keyed')} times`,
        );
      },
    },
    {
      name: 'a key still deduplicates after the first job was evicted',
      async run({ driver, define, log }) {
        define([noopJob('keyed')]);
        await driver.startWorker();
        await driver.dispatch({ name: 'keyed', payload: 1 }, { key: 'k', keyWindowMs: WINDOW_MS });
        await driver.settle();
        await driver.evictCompleted();
        await driver.dispatch({ name: 'keyed', payload: 2 }, { key: 'k', keyWindowMs: WINDOW_MS });
        await driver.settle();
        assert.equal(
          log.count('keyed'),
          1,
          'a keyed dispatch inside its window ran again after the first job completed ' +
            `and was evicted (${log.count('keyed')} runs)`,
        );
      },
    },
    {
      name: 'keys with a colon and non-ASCII characters are accepted and deduplicate',
      async run({ driver, define, log }) {
        define([noopJob('keyed')]);
        const keys = ['tenant:42:report', 'rapport-été-日本'];
        for (const key of keys) {
          await driver.dispatch({ name: 'keyed', payload: key }, { key, keyWindowMs: WINDOW_MS });
          await driver.dispatch({ name: 'keyed', payload: key }, { key, keyWindowMs: WINDOW_MS });
        }
        await driver.startWorker();
        await driver.settle();
        const runs = log.of('keyed').map((execution) => execution.payload);
        assert.deepEqual(
          runs.toSorted(),
          keys.toSorted(),
          `each key should run once; runs were ${JSON.stringify(runs)}`,
        );
      },
    },
  ],
};
