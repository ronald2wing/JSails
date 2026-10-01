/**
 * `requireCapability`: hands back a declared capability, and refuses a
 * missing one with a value-free `capability_missing` naming it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { JobsAdapterCapabilities } from '../../src/contract/adapter.js';
import { requireCapability } from '../../src/contract/capabilities.js';
import { JobsErrors } from '../../src/errors/jobs-errors.js';

describe('requireCapability', () => {
  test('returns the declared capability', () => {
    const leases = {} as NonNullable<JobsAdapterCapabilities['leases']>;
    assert.equal(requireCapability({ capabilities: { leases } }, 'leases'), leases);
  });

  test('refuses a missing capability, naming it', () => {
    for (const name of ['flows', 'failedJobs', 'schedules', 'leases'] as const) {
      assert.throws(
        () => requireCapability({ capabilities: {} }, name),
        (error: unknown) =>
          JobsErrors.is(error, 'capability_missing') && error.context.capability === name,
      );
    }
  });
});
