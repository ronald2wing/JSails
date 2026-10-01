/**
 * The bounds of a lease operation, checked the same way by every transport
 * that provides the `leases` capability: a key of 1 to
 * {@link MAX_LEASE_KEY_LENGTH} characters, a TTL of 1 s to one hour, and a
 * token of 1 to 128 characters. Each refusal is a value-free
 * `jobs.invalid_option` naming `key`, `ttlMs` or `token`.
 */

import { MAX_OVERLAP_TTL_MS, MIN_OVERLAP_TTL_MS } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';

/** The longest lease key: a 512-character overlap key under its prefix. */
export const MAX_LEASE_KEY_LENGTH = 520;

/** The longest lease token a transport accepts back. */
export const MAX_LEASE_TOKEN_LENGTH = 128;

function refuse(option: 'key' | 'ttlMs' | 'token'): Error {
  return new JobsErrors.Error('invalid_option', { option });
}

/** @throws `jobs.invalid_option` naming `key`. */
export function checkLeaseKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_LEASE_KEY_LENGTH) {
    throw refuse('key');
  }
}

/** @throws `jobs.invalid_option` naming `ttlMs`. */
export function checkLeaseTtl(ttlMs: unknown): asserts ttlMs is number {
  if (
    typeof ttlMs !== 'number' ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < MIN_OVERLAP_TTL_MS ||
    ttlMs > MAX_OVERLAP_TTL_MS
  ) {
    throw refuse('ttlMs');
  }
}

/** @throws `jobs.invalid_option` naming `token`. */
export function checkLeaseToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_LEASE_TOKEN_LENGTH) {
    throw refuse('token');
  }
}
