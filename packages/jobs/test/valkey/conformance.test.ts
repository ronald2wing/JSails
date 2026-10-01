/**
 * The conformance suite against the new jobs code over the Valkey transport
 * on a real server: the definitions, the producer, the envelope, BullMQ
 * through `valkeyJobs`, and the worker runtime, end to end, through the
 * shared runtime driver on `valkeyTransport` (a fresh namespace per
 * scenario, deleted when it ends). Live and opt-in (see `live-server.ts`).
 * Every scenario passes, the virtual-time ones included; nothing here is
 * listed in `scripts/expected-failures/jobs.json`.
 */

import { describe, test } from 'node:test';

import { conformancePlan, suiteName } from '../../src/testing/index.js';
import { runtimeDriverFactory } from '../conformance/runtime-driver.js';
import { LIVE, SKIP_REASON, valkeyTransport } from './live-server.js';

const createValkeyDriver = runtimeDriverFactory(valkeyTransport, () => Date.now());

if (LIVE) {
  describe(suiteName('valkey'), () => {
    for (const group of conformancePlan(createValkeyDriver, { virtualTime: true })) {
      describe(group.name, () => {
        for (const entry of group.tests) test(entry.name, () => entry.run());
      });
    }
  });
} else {
  test(suiteName('valkey'), { skip: SKIP_REASON }, () => undefined);
}
