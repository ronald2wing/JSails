/**
 * The pure policy deciding what a domain check result does to a claim.
 *
 * A claim is either pending (never verified, or verification withdrawn) or
 * verified. {@link nextDomainVerification} folds one check result into the
 * claim's state and names the action the caller must apply:
 *
 * - `verified`: a pending claim passed; it now routes, and the caller evicts
 *   other tenants' pending claims for the hostname.
 * - `still_verified`: a verified claim passed again; its failure run resets.
 * - `failing`: a verified claim failed, but not yet enough to withdraw it; it
 *   keeps routing.
 * - `unverified`: a verified claim failed at least `failAfter` times in a row
 *   over at least `minFailingSpanMs`; it stops routing but stays as a pending
 *   claim with a fresh pending window, so publishing the record again recovers
 *   it for the same tenant.
 * - `pending`: a pending claim failed and its window is still open.
 * - `expired`: a pending claim's window has closed; the caller deletes it.
 *
 * Every non-passing result counts as a failure, `dns_error` and `timeout`
 * included: a record that cannot be read does not prove control. The time span
 * requirement is what keeps a short resolver outage, on either side, from
 * withdrawing every domain at once. Persistent records prove control only
 * while they keep passing (draft-ietf-dnsop-domain-verification-techniques-13
 * §6.3), hence the periodic re-check.
 */

import type { DomainCheckStatus } from './domain-verification.js';
import { TenancyError } from './tenancy-error.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The thresholds of the domain verification policy. Built by {@link domainVerificationPolicy}. */
export interface DomainVerificationPolicy {
  /** How long a pending claim stays open; defaults to 7 days. */
  readonly pendingTtlMs: number;
  /** Consecutive failures before a verified claim is withdrawn; defaults to 3. */
  readonly failAfter: number;
  /** The least time the failure run must span before withdrawal; defaults to 24 hours. */
  readonly minFailingSpanMs: number;
}

/** A claim's verification state, as the store keeps it. */
export interface DomainVerificationState {
  /** When the claim was verified; `null` while pending. */
  readonly verifiedAt: Date | null;
  /** Consecutive failed checks. */
  readonly failures: number;
  /** When the current failure run started; `null` without one. */
  readonly failingSince: Date | null;
  /** When a pending claim lapses; `null` once verified. */
  readonly expiresAt: Date | null;
}

/** The action a check result requires. */
export type DomainVerificationAction =
  'verified' | 'still_verified' | 'failing' | 'unverified' | 'pending' | 'expired';

/** The outcome of {@link nextDomainVerification}. */
export interface DomainVerificationOutcome {
  readonly action: DomainVerificationAction;
  readonly state: DomainVerificationState;
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TenancyError('invalid_domain_policy');
  }
  return value;
}

/** Build a frozen policy. Throws `invalid_domain_policy` on out-of-range options. */
export function domainVerificationPolicy(
  options: Partial<DomainVerificationPolicy> = {},
): DomainVerificationPolicy {
  return Object.freeze({
    pendingTtlMs: bounded(options.pendingTtlMs ?? 7 * DAY_MS, 60_000, 90 * DAY_MS),
    failAfter: bounded(options.failAfter ?? 3, 1, 1000),
    minFailingSpanMs: bounded(options.minFailingSpanMs ?? DAY_MS, 0, 365 * DAY_MS),
  });
}

/** The policy used when none is given. */
export const DEFAULT_DOMAIN_VERIFICATION_POLICY: DomainVerificationPolicy =
  domainVerificationPolicy();

/** The state of a claim that was just opened and expires at `expiresAt`. */
export function pendingDomainVerification(expiresAt: Date): DomainVerificationState {
  return Object.freeze({ verifiedAt: null, failures: 0, failingSince: null, expiresAt });
}

function validDate(value: Date | null): boolean {
  return value === null || (value instanceof Date && !Number.isNaN(value.getTime()));
}

/**
 * Fold one check result taken at `now` into a claim's state. Throws
 * `invalid_domain_policy` when the state or the clock is malformed.
 */
export function nextDomainVerification(
  state: DomainVerificationState,
  check: DomainCheckStatus,
  now: Date,
  policy: DomainVerificationPolicy = DEFAULT_DOMAIN_VERIFICATION_POLICY,
): DomainVerificationOutcome {
  if (
    !validDate(now) ||
    !validDate(state.verifiedAt) ||
    !validDate(state.failingSince) ||
    !validDate(state.expiresAt) ||
    !Number.isSafeInteger(state.failures) ||
    state.failures < 0 ||
    (state.verifiedAt === null && state.expiresAt === null)
  ) {
    throw new TenancyError('invalid_domain_policy');
  }
  const at = now.getTime();
  const outcome = (
    action: DomainVerificationAction,
    next: DomainVerificationState,
  ): DomainVerificationOutcome => Object.freeze({ action, state: Object.freeze({ ...next }) });
  const failed: DomainVerificationState = {
    ...state,
    failures: state.failures + 1,
    failingSince: state.failingSince ?? now,
  };

  if (state.verifiedAt === null) {
    if (state.expiresAt !== null && at >= state.expiresAt.getTime()) {
      return outcome('expired', state);
    }
    if (check === 'verified') {
      return outcome('verified', {
        verifiedAt: now,
        failures: 0,
        failingSince: null,
        expiresAt: null,
      });
    }
    return outcome('pending', failed);
  }

  if (check === 'verified') {
    return outcome('still_verified', {
      ...state,
      failures: 0,
      failingSince: null,
      expiresAt: null,
    });
  }
  const since = failed.failingSince?.getTime() ?? at;
  if (failed.failures >= policy.failAfter && at - since >= policy.minFailingSpanMs) {
    return outcome('unverified', {
      verifiedAt: null,
      failures: 0,
      failingSince: null,
      expiresAt: new Date(at + policy.pendingTtlMs),
    });
  }
  return outcome('failing', failed);
}
