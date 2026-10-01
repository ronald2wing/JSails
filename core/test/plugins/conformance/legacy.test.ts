/**
 * The marketplace conformance suite against today's implementation
 * (`legacy-driver.ts`). Its expected failures are listed in
 * `scripts/expected-failures/marketplace.json`; the file is deleted with the
 * legacy driver in MKT-15.
 *
 * The `it` calls stay in this file rather than in `scenarios.ts`: node:test
 * reports a test under the file that declares it, and the ledger names this
 * file.
 */

import { describe, it } from 'node:test';

import { createLegacyDriver } from './legacy-driver.js';
import { MARKETPLACE_SCENARIOS, runScenario } from './scenarios.js';

describe('marketplace conformance (legacy driver)', () => {
  for (const group of MARKETPLACE_SCENARIOS) {
    describe(group.name, () => {
      for (const scenario of group.scenarios) {
        it(scenario.title, () => runScenario(createLegacyDriver, scenario));
      }
    });
  }
});
