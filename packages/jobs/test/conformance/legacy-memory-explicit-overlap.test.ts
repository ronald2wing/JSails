/**
 * The overlap scenarios against today's `jsails/jobs` runtime with overlap
 * registered by hand after the chain middleware
 * (`[chainMiddleware, batch, createOverlapMiddleware(mutex)]`), the per-job
 * stack the jobs docs keep available. The runtime then adds no automatic
 * overlap, so the overlap middleware runs inside the chain middleware, which
 * advances the chain after a skip. Only the overlap scenarios run here: every
 * other scenario sees the same stack as `legacy-memory.test.ts`. Failures are
 * listed in `scripts/expected-failures/jobs.json`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryJobsAdapter } from 'jsails/jobs';

import { conformancePlan, suiteName, type DriverFactory } from '../../src/testing/index.js';
import { createLegacyDriver } from './legacy-driver.js';

const legacyExplicitOverlap: DriverFactory = (options) =>
  createLegacyDriver(
    {
      adapter: new MemoryJobsAdapter(),
      queueName: 'default',
      prefix: 'conformance',
      close: () => Promise.resolve(),
    },
    options,
    { overlap: 'explicit' },
  );

const plan = conformancePlan(legacyExplicitOverlap, { virtualTime: true }).map((group) => ({
  name: group.name,
  tests: group.tests.filter((entry) => entry.name.includes('overlap skip')),
}));

describe(suiteName('legacy-memory-explicit-overlap'), () => {
  test('the overlap scenarios are selected', () => {
    // A renamed scenario must not silently empty this file.
    assert.deepEqual(
      plan.flatMap((group) => group.tests.map((entry) => `${group.name} > ${entry.name}`)),
      [
        'outcomes > an overlap skip is reported as skipped, not completed',
        'outcomes > an overlap skip does not advance a chain',
      ],
    );
  });

  for (const group of plan) {
    if (group.tests.length === 0) continue;
    describe(group.name, () => {
      for (const entry of group.tests) test(entry.name, () => entry.run());
    });
  }
});
