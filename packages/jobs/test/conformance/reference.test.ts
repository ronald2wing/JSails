/**
 * The conformance suite against the reference model. Every scenario must
 * pass here: a scenario the model cannot satisfy is a broken scenario, not a
 * finding about an implementation. Nothing in this file may be listed in an
 * expected-failure ledger.
 */

import { describe, test } from 'node:test';

import { conformancePlan, suiteName } from '../../src/testing/index.js';
import { createReferenceDriver } from './reference-driver.js';

describe(suiteName('reference'), () => {
  for (const group of conformancePlan(createReferenceDriver, { virtualTime: true })) {
    describe(group.name, () => {
      for (const entry of group.tests) test(entry.name, () => entry.run());
    });
  }
});
