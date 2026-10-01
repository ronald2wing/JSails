/**
 * The conformance suite against the new jobs code over `memoryJobs`. The keys
 * and envelope groups (definitions, producer, envelope, adapter) pass with no
 * ledger entry. Scenarios that need the worker runtime, flows, failed-job
 * operations, overlap leases or schedules fail until those land; each is listed
 * in `scripts/expected-failures/jobs.json` with the work package that removes
 * the entry.
 */

import { describe, test } from 'node:test';

import { conformancePlan, suiteName } from '../../src/testing/index.js';
import { createMemoryDriver } from './conformance-driver.js';

describe(suiteName('memory'), () => {
  for (const group of conformancePlan(createMemoryDriver, { virtualTime: true })) {
    describe(group.name, () => {
      for (const entry of group.tests) test(entry.name, () => entry.run());
    });
  }
});
