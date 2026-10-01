/**
 * The envelope as a handler observes it: a payload arrives exactly as it was
 * dispatched, whatever the transport does to store it, every attempt starts
 * from the stored payload rather than from what an earlier attempt did to its
 * copy, and a payload the job refuses never reaches the transport.
 */

import assert from 'node:assert/strict';

import { failOnPurpose, noopJob, type ScenarioGroup } from './scenario.js';

/** A payload that exercises every JSON value kind, nesting, and non-ASCII text. */
const RICH_PAYLOAD = Object.freeze({
  text: 'rapport été 日本 \u{1F680}',
  empty: '',
  integer: 42,
  negative: -7,
  fraction: 0.125,
  large: 9_007_199_254_740_991,
  truth: true,
  falsehood: false,
  nothing: null,
  list: [1, 'two', [3], { four: 4 }],
  nested: { depth: { deeper: { deepest: 'end' } } },
  quotes: 'a "quoted" \\ back\\slash and\nnew line',
});

export const envelopeScenarios: ScenarioGroup = {
  name: 'envelope',
  scenarios: [
    {
      name: 'a payload reaches the handler exactly as dispatched',
      async run({ driver, define, log }) {
        define([noopJob('echo')]);
        await driver.startWorker();
        await driver.dispatch({ name: 'echo', payload: RICH_PAYLOAD });
        await driver.settle();
        const seen = log.of('echo').map((execution) => execution.payload);
        assert.equal(seen.length, 1, `the job ran ${seen.length} times`);
        assert.deepEqual(
          seen[0],
          RICH_PAYLOAD,
          'the handler saw a payload other than the dispatched one',
        );
      },
    },
    {
      name: 'a retried attempt sees the stored payload, not the previous attempt mutation',
      async run({ driver, define, log }) {
        define([
          {
            name: 'mutating',
            attempts: 2,
            handle: (payload) => {
              const record = payload as { count: number };
              record.count += 1;
              if (log.count('mutating') === 1) {
                return failOnPurpose('first attempt fails');
              }
              return Promise.resolve();
            },
          },
        ]);
        await driver.startWorker();
        await driver.dispatch({ name: 'mutating', payload: { count: 0 } });
        await driver.settle();
        const counts = log
          .of('mutating')
          .map((execution) => (execution.payload as { count: number }).count);
        assert.deepEqual(
          counts,
          [1, 1],
          `each attempt should start from the stored payload; the handler counted ${JSON.stringify(counts)}`,
        );
      },
    },
    {
      name: 'a payload the job refuses is rejected at dispatch and never runs',
      async run({ driver, define, log }) {
        define([noopJob('strict', { accepts: (payload) => payload === 'good' })]);
        await assert.rejects(
          driver.dispatch({ name: 'strict', payload: 'bad' }),
          'a refused payload was accepted at dispatch',
        );
        await driver.startWorker();
        await driver.settle();
        assert.equal(log.count('strict'), 0, `a refused payload ran ${log.count('strict')} times`);
      },
    },
  ],
};
