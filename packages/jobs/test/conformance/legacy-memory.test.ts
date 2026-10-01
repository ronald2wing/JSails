/**
 * The conformance suite against today's `jsails/jobs` runtime over the
 * in-process `MemoryJobsAdapter`. Scenarios it fails are listed in
 * `scripts/expected-failures/jobs.json`; each entry names the work package
 * whose fix removes it.
 */

import { describe, test } from 'node:test';

import { MemoryJobsAdapter } from 'jsails/jobs';

import { conformancePlan, suiteName, type DriverFactory } from '../../src/testing/index.js';
import { createLegacyDriver } from './legacy-driver.js';

const legacyMemory: DriverFactory = (options) =>
  createLegacyDriver(
    {
      adapter: new MemoryJobsAdapter(),
      queueName: 'default',
      prefix: 'conformance',
      close: () => Promise.resolve(),
    },
    options,
  );

describe(suiteName('legacy-memory'), () => {
  for (const group of conformancePlan(legacyMemory, { virtualTime: true })) {
    describe(group.name, () => {
      for (const entry of group.tests) test(entry.name, () => entry.run());
    });
  }
});
