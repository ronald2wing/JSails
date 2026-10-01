/**
 * Tests for the lane admission layer: the limits schema (defaults, overrides,
 * value-free refusals), the slot pools per lane and per principal, and the
 * principal a request is counted against.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ComponentLimitsErrors,
  DEFAULT_RUNTIME_LIMITS,
  LANES,
  createAdmission,
  principalOf,
  resolveRuntimeLimits,
} from '../../src/server-components/runtime/admission.js';

function assertLimitsCode(input: unknown, code: string): void {
  assert.throws(
    () => resolveRuntimeLimits(input),
    (error: unknown) => {
      assert.ok(ComponentLimitsErrors.is(error));
      assert.equal((error as { code: string }).code, `component_limits.${code}`);
      assert.doesNotMatch((error as Error).message, /12345|evil/);
      return true;
    },
  );
}

describe('resolveRuntimeLimits', () => {
  it('returns the frozen defaults when no limits are given', () => {
    const limits = resolveRuntimeLimits(undefined);
    assert.equal(limits, DEFAULT_RUNTIME_LIMITS);
    assert.deepEqual(Object.keys(limits), [...LANES]);
    assert.equal(Object.isFrozen(limits.update), true);
  });

  it('overrides only the fields given, per lane', () => {
    const limits = resolveRuntimeLimits({ upload: { totalMs: 60_000 } });
    assert.equal(limits.upload.totalMs, 60_000);
    assert.equal(limits.upload.maxConcurrent, DEFAULT_RUNTIME_LIMITS.upload.maxConcurrent);
    assert.deepEqual(limits.update, DEFAULT_RUNTIME_LIMITS.update);
    assert.equal(Object.isFrozen(limits.upload), true);
  });

  it('narrows the default per-principal cap to a lowered lane total', () => {
    const limits = resolveRuntimeLimits({ update: { maxConcurrent: 1 } });
    assert.equal(limits.update.maxConcurrentPerPrincipal, 1);
  });

  it('refuses an explicit per-principal cap above the lane total', () => {
    assertLimitsCode(
      { update: { maxConcurrent: 2, maxConcurrentPerPrincipal: 3 } },
      'principal_over_total',
    );
  });

  it('refuses malformed limits without echoing the value', () => {
    assertLimitsCode(12345, 'invalid_limits');
    assertLimitsCode({ evil: {} }, 'unknown_lane');
    assertLimitsCode({ update: 12345 }, 'invalid_lane');
    assertLimitsCode({ update: { evil: 1 } }, 'unknown_field');
    assertLimitsCode({ update: { totalMs: 0 } }, 'invalid_value');
    assertLimitsCode({ update: { totalMs: -12345 } }, 'invalid_value');
    assertLimitsCode({ update: { totalMs: 1.5 } }, 'invalid_value');
    assertLimitsCode({ update: { totalMs: '12345' } }, 'invalid_value');
  });
});

describe('createAdmission', () => {
  it('caps a lane across principals and per principal, independently per lane', () => {
    const admission = createAdmission(
      resolveRuntimeLimits({ update: { maxConcurrent: 3, maxConcurrentPerPrincipal: 2 } }),
    );
    const a1 = admission.acquire('update', 'subject:a');
    const a2 = admission.acquire('update', 'subject:a');
    assert.ok(a1 && a2);
    assert.equal(admission.acquire('update', 'subject:a'), undefined, 'per-principal cap');
    const b1 = admission.acquire('update', 'subject:b');
    assert.ok(b1);
    assert.equal(admission.acquire('update', 'subject:c'), undefined, 'lane cap');
    assert.ok(admission.acquire('refresh', 'subject:c'), 'another lane is unaffected');
    assert.equal(admission.inFlight('update'), 3);

    a1.release();
    a1.release();
    assert.equal(admission.inFlight('update'), 2, 'release is idempotent');
    assert.ok(admission.acquire('update', 'subject:c'));
  });
});

describe('principalOf', () => {
  it('counts a subject by its tag and an anonymous request by its client bucket', () => {
    assert.equal(principalOf('tag-1', undefined), 'subject:tag-1');
    assert.equal(
      principalOf(null, { address: '203.0.113.9', bucket: '203.0.113.0/24' } as never),
      'client:203.0.113.0/24',
    );
    assert.equal(principalOf(null, undefined), 'client:unknown');
  });
});
