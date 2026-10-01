/**
 * Tests for the domain verification failure policy: pending claims verify,
 * fail and expire; verified claims survive short failure runs and are
 * withdrawn only after N failures spanning the minimum time; withdrawal keeps
 * a recoverable pending claim; option and state validation; and a seeded
 * property that a verified claim is never withdrawn early.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DomainCheckStatus } from '../src/domain-verification.js';
import {
  DEFAULT_DOMAIN_VERIFICATION_POLICY,
  domainVerificationPolicy,
  nextDomainVerification,
  pendingDomainVerification,
  type DomainVerificationState,
} from '../src/domain-verification-policy.js';
import { seededPrng } from './seeded-prng.js';
import { thrownCode } from './thrown-code.js';

const HOUR = 3_600_000;
const t0 = new Date('2026-11-19T00:00:00Z');
const at = (hours: number): Date => new Date(t0.getTime() + hours * HOUR);

const verified: DomainVerificationState = {
  verifiedAt: t0,
  failures: 0,
  failingSince: null,
  expiresAt: null,
};

describe('domainVerificationPolicy', () => {
  it('defaults to 7 days pending, 3 failures over 24 hours', () => {
    assert.deepEqual(DEFAULT_DOMAIN_VERIFICATION_POLICY, {
      pendingTtlMs: 7 * 24 * HOUR,
      failAfter: 3,
      minFailingSpanMs: 24 * HOUR,
    });
    assert.ok(Object.isFrozen(DEFAULT_DOMAIN_VERIFICATION_POLICY));
  });

  it('refuses out-of-range options with invalid_domain_policy', () => {
    for (const options of [
      { pendingTtlMs: 0 },
      { pendingTtlMs: 1.5 },
      { failAfter: 0 },
      { minFailingSpanMs: -1 },
      { minFailingSpanMs: Number.POSITIVE_INFINITY },
    ]) {
      assert.equal(
        thrownCode(() => domainVerificationPolicy(options)),
        'invalid_domain_policy',
      );
    }
  });
});

describe('nextDomainVerification: pending claims', () => {
  const pending = pendingDomainVerification(at(168));

  it('verifies on a passing check', () => {
    assert.deepEqual(nextDomainVerification(pending, 'verified', at(1)), {
      action: 'verified',
      state: { verifiedAt: at(1), failures: 0, failingSince: null, expiresAt: null },
    });
  });

  it('records failures while the window is open', () => {
    const first = nextDomainVerification(pending, 'absent', at(1));
    assert.equal(first.action, 'pending');
    assert.deepEqual(first.state, { ...pending, failures: 1, failingSince: at(1) });
    const second = nextDomainVerification(first.state, 'timeout', at(2));
    assert.deepEqual(second.state.failingSince, at(1));
    assert.equal(second.state.failures, 2);
  });

  it('expires at the end of the window, even on a passing check', () => {
    assert.equal(nextDomainVerification(pending, 'verified', at(168)).action, 'expired');
    assert.equal(nextDomainVerification(pending, 'mismatch', at(200)).action, 'expired');
  });
});

describe('nextDomainVerification: verified claims', () => {
  it('stays verified on a pass and resets the failure run', () => {
    const failingState = { ...verified, failures: 2, failingSince: at(1) };
    assert.deepEqual(nextDomainVerification(failingState, 'verified', at(5)), {
      action: 'still_verified',
      state: verified,
    });
  });

  it('keeps routing through failures that are too few or too quick', () => {
    let state = verified;
    for (const hour of [1, 2, 3, 4, 5]) {
      const outcome = nextDomainVerification(state, 'dns_error', at(hour));
      assert.equal(outcome.action, 'failing', `hour ${hour}`);
      state = outcome.state;
    }
    assert.equal(state.failures, 5);
    assert.deepEqual(state.failingSince, at(1));
  });

  it('withdraws after N failures spanning 24 hours, leaving a recoverable pending claim', () => {
    let state = verified;
    state = nextDomainVerification(state, 'absent', at(0)).state;
    state = nextDomainVerification(state, 'absent', at(12)).state;
    const third = nextDomainVerification(state, 'mismatch', at(24));
    assert.equal(third.action, 'unverified');
    assert.deepEqual(third.state, {
      verifiedAt: null,
      failures: 0,
      failingSince: null,
      expiresAt: at(24 + 168),
    });
    assert.equal(nextDomainVerification(third.state, 'verified', at(30)).action, 'verified');
  });

  it('does not withdraw a long span with too few failures', () => {
    let state = verified;
    state = nextDomainVerification(state, 'absent', at(0)).state;
    assert.equal(nextDomainVerification(state, 'absent', at(100)).action, 'failing');
  });

  it('never withdraws before failAfter failures over minFailingSpanMs (seeded property)', () => {
    const random = seededPrng(0xd0a1);
    const results: readonly DomainCheckStatus[] = [
      'verified',
      'absent',
      'mismatch',
      'dns_error',
      'timeout',
    ];
    for (let walk = 0; walk < 300; walk += 1) {
      const policy = domainVerificationPolicy({
        failAfter: 1 + random.int(5),
        minFailingSpanMs: random.int(48) * HOUR,
      });
      let state = verified;
      let hour = 0;
      let run: number[] = [];
      for (let step = 0; step < 40 && state.verifiedAt !== null; step += 1) {
        hour += random.int(12);
        const check = random.int(3) === 0 ? 'verified' : random.pick(results);
        const outcome = nextDomainVerification(state, check, at(hour), policy);
        run = check === 'verified' ? [] : [...run, hour];
        if (outcome.action === 'unverified') {
          const first = run[0] ?? hour;
          assert.ok(run.length >= policy.failAfter, `walk ${walk}`);
          assert.ok((hour - first) * HOUR >= policy.minFailingSpanMs, `walk ${walk}`);
        } else {
          assert.ok(outcome.action === 'still_verified' || outcome.action === 'failing');
        }
        state = outcome.state;
      }
    }
  });
});

describe('nextDomainVerification: validation', () => {
  it('refuses a malformed state or clock', () => {
    const cases: readonly DomainVerificationState[] = [
      { ...verified, failures: -1 },
      { ...verified, failures: 0.5 },
      { ...verified, verifiedAt: new Date(Number.NaN) },
      { verifiedAt: null, failures: 0, failingSince: null, expiresAt: null },
    ];
    for (const state of cases) {
      assert.equal(
        thrownCode(() => nextDomainVerification(state, 'absent', t0)),
        'invalid_domain_policy',
      );
    }
    assert.equal(
      thrownCode(() => nextDomainVerification(verified, 'absent', new Date(Number.NaN))),
      'invalid_domain_policy',
    );
  });
});
