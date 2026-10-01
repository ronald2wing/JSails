/**
 * Failed jobs: a retry runs the job once however many callers race it, keeps
 * its envelope (payload and tags), continues the chain it belonged to, and
 * leaves the failed set when it succeeds.
 */

import assert from 'node:assert/strict';

import type { ScenarioJob } from './driver.js';
import { noopJob, ScenarioJobFailure, type Harness, type ScenarioGroup } from './scenario.js';

/** A job that fails on its first execution and succeeds afterwards. */
function failsOnce(name: string, harness: Harness): ScenarioJob {
  return {
    name,
    handle: () =>
      harness.log.count(name) === 1
        ? Promise.reject(new ScenarioJobFailure(`${name} failed`))
        : Promise.resolve(),
  };
}

/** The one failed job, after the queue settled. */
async function onlyFailed({ driver }: Harness): Promise<string> {
  await driver.settle();
  const failed = await driver.failed();
  assert.equal(failed.length, 1, `expected one failed job, found ${failed.length}`);
  return failed[0]!.id;
}

export const failedScenarios: ScenarioGroup = {
  name: 'failed jobs',
  scenarios: [
    {
      name: '50 concurrent retries of one failed job run it once',
      async run(harness) {
        const { driver, define, log } = harness;
        define([failsOnce('flaky', harness)]);
        await driver.startWorker();
        await driver.dispatch({ name: 'flaky', payload: null });
        const id = await onlyFailed(harness);
        const results = await Promise.all(Array.from({ length: 50 }, () => driver.retry(id)));
        await driver.settle();
        assert.equal(
          log.count('flaky') - 1,
          1,
          `50 concurrent retries ran the job ${log.count('flaky') - 1} times`,
        );
        assert.equal(
          results.filter((result) => result === 'retried').length,
          1,
          `more than one concurrent retry reported success: ${JSON.stringify(results)}`,
        );
      },
    },
    {
      name: 'a retried job keeps its payload and tags',
      async run(harness) {
        const { driver, define } = harness;
        define([
          {
            name: 'doomed',
            handle: () => Promise.reject(new ScenarioJobFailure('doomed failed')),
          },
        ]);
        await driver.startWorker();
        await driver.dispatch({ name: 'doomed', payload: { n: 7 } }, { tags: ['billing'] });
        const id = await onlyFailed(harness);
        assert.equal(await driver.retry(id), 'retried');
        await onlyFailed(harness);
        const [entry] = await driver.failed();
        assert.deepEqual(
          { payload: entry?.envelope.payload, tags: entry?.envelope.meta.tags },
          { payload: { n: 7 }, tags: ['billing'] },
          'a retried job lost part of its envelope',
        );
      },
    },
    {
      name: 'retrying a failed chain step continues the chain',
      async run(harness) {
        const { driver, define, log } = harness;
        define([noopJob('chain-a'), failsOnce('chain-b', harness), noopJob('chain-c')]);
        await driver.startWorker();
        await driver.chain([
          { name: 'chain-a', payload: null },
          { name: 'chain-b', payload: null },
          { name: 'chain-c', payload: null },
        ]);
        const id = await onlyFailed(harness);
        assert.equal(log.count('chain-c'), 0, 'the chain continued past a failed step');
        assert.equal(await driver.retry(id), 'retried');
        await driver.settle();
        assert.equal(log.count('chain-b'), 2, 'the retried chain step did not run');
        assert.equal(
          log.count('chain-c'),
          1,
          `retrying a failed chain step did not continue the chain (${log.count('chain-c')} runs of the next step)`,
        );
      },
    },
    {
      name: 'a successful retry removes the job from the failed set',
      async run(harness) {
        const { driver, define } = harness;
        define([failsOnce('flaky', harness)]);
        await driver.startWorker();
        await driver.dispatch({ name: 'flaky', payload: null });
        const id = await onlyFailed(harness);
        assert.equal(await driver.retry(id), 'retried');
        await driver.settle();
        const failed = await driver.failed();
        assert.equal(
          failed.length,
          0,
          `a successfully retried job is still in the failed set (${failed.length} entries)`,
        );
      },
    },
  ],
};
