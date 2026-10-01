/**
 * Version skew during a rolling deploy: a worker that does not know a job
 * releases it instead of failing it, so a worker that knows it runs it.
 */

import assert from 'node:assert/strict';

import { eventually } from './recorder.js';
import { noopJob, type ScenarioGroup } from './scenario.js';

export const skewScenarios: ScenarioGroup = {
  name: 'skew',
  scenarios: [
    {
      name: 'a job unknown to a worker is released, then run by a worker that knows it',
      async run({ driver, define, log }) {
        define([noopJob('known'), noopJob('novel')]);
        const old = await driver.startWorker({ knows: ['known'] });
        await driver.dispatch({ name: 'novel', payload: null });
        await driver.settle();
        await driver.drain(old);
        await driver.startWorker();
        await eventually(() => log.count('novel') > 0, 2_000);
        await driver.settle();
        const failed = await driver.failed();
        assert.deepEqual(
          { runs: log.count('novel'), failed: failed.length },
          { runs: 1, failed: 0 },
          'a job unknown to the first worker was not left for a worker that knows it',
        );
      },
    },
  ],
};
