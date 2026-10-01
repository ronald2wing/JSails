/**
 * The marketplace conformance suite against today's kernel
 * (`kernel-driver.ts`), which has no marketplace yet. Its expected failures
 * are listed in `scripts/expected-failures/marketplace.json`, each with the
 * package that closes it; the file is deleted with the kernel driver in
 * MKT-15b.
 *
 * The `it` calls stay in this file rather than in `scenarios.ts`: node:test
 * reports a test under the file that declares it, and the ledger names this
 * file.
 */

import { describe, it } from 'node:test';

import { createKernelDriver } from './kernel-driver.js';
import { MARKETPLACE_SCENARIOS, runScenario } from './scenarios.js';

describe('marketplace conformance (kernel driver)', () => {
  for (const group of MARKETPLACE_SCENARIOS) {
    describe(group.name, () => {
      for (const scenario of group.scenarios) {
        it(scenario.title, () => runScenario(createKernelDriver, scenario));
      }
    });
  }
});
