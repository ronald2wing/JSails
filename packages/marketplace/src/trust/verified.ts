/**
 * The record of values the verifiers produced. A verified delegation or
 * catalog carries trust (a key, a revocation) into `createTrust`, so a value
 * of that type built by hand must not pass for one: the verifiers record what
 * they return in module-private weak collections, and `createTrust` accepts
 * nothing else. A verified delegation is recorded with the key it delegates,
 * ready for signature checks.
 */

import type { TrustedKey } from './trust-set.js';

const catalogs = new WeakSet<object>();
const delegatedKeys = new WeakMap<object, TrustedKey>();

/** Record `value` as a catalog `verifyCatalog` produced, and return it. */
export function markVerifiedCatalog<T extends object>(value: T): T {
  catalogs.add(value);
  return value;
}

/** Whether `value` is a catalog `verifyCatalog` produced. */
export function isVerifiedCatalog(value: unknown): boolean {
  return typeof value === 'object' && value !== null && catalogs.has(value);
}

/** Record `value` as a verified delegation of `key`, and return it. */
export function markVerifiedDelegation<T extends object>(value: T, key: TrustedKey): T {
  delegatedKeys.set(value, key);
  return value;
}

/** The key a verified delegation delegates, or `undefined` for any other value. */
export function delegatedKey(value: unknown): TrustedKey | undefined {
  return typeof value === 'object' && value !== null ? delegatedKeys.get(value) : undefined;
}
