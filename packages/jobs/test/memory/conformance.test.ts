/**
 * The conformance suite against the new jobs code over the memory adapter:
 * the definitions, the producer, the envelope, the memory adapter and the
 * worker runtime, end to end, through the shared runtime driver. Every group
 * passes; nothing here is listed in `scripts/expected-failures/jobs.json`.
 */

import { describe, test } from 'node:test';

import { MemoryJobsAdapter } from '../../src/memory/memory-adapter.js';
import { conformancePlan, suiteName } from '../../src/testing/index.js';
import { runtimeDriverFactory, type DriverTransport } from '../conformance/runtime-driver.js';
import { flush } from '../timing/virtual-clock.js';

const createMemoryDriver = runtimeDriverFactory(
  ({ queues, clock }): DriverTransport => {
    const adapter = new MemoryJobsAdapter({ namespace: 'conformance:test', queues }, { clock });
    return {
      adapter,
      busy: () => adapter.busy(),
      redeliver: (id) => adapter.redeliver(id),
      evictCompleted: (queue) => adapter.evictCompleted(queue),
      // The memory adapter acts in the timer callback itself; one turn lets its reactions run.
      quiesce: flush,
      close: () => Promise.resolve(),
    };
  },
  () => 1_700_000_000_000,
);

describe(suiteName('memory'), () => {
  for (const group of conformancePlan(createMemoryDriver, { virtualTime: true })) {
    describe(group.name, () => {
      for (const entry of group.tests) test(entry.name, () => entry.run());
    });
  }
});
