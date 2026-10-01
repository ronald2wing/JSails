/**
 * Plan limits of a tenant and the one comparison every limit check uses.
 *
 * A limit is a named non-negative integer, or `Infinity`, in a plain object
 * the app derives from the tenant's plan. A name that is absent (or only
 * inherited, so `constructor` is never read as a limit) is unlimited.
 *
 * {@link checkLimit} asks whether adding `delta` to `current` stays within
 * the limit: `current + delta <= limit`. A `delta` of 0 asks whether the
 * tenant is within the limit now, which reports `limit_exceeded` after a
 * downgrade left it over. Removing never needs a check, so a negative delta
 * is a developer error, like a count that is not a non-negative integer or a
 * limit value that is not one (`invalid_limits`).
 */

import { TenancyError } from './tenancy-error.js';

/** Limits for one tenant, by name. */
export interface TenantLimits {
  /** Members, owner included; unlimited when absent. */
  readonly seats?: number;
  /** Invitations sent in any 24 hours; the lifecycle defaults it to 50. */
  readonly invitationsPerDay?: number;
  /** Domain claims, pending ones included; the lifecycle defaults it to 10. */
  readonly domains?: number;
  /** App-defined limits. */
  readonly [name: string]: number | undefined;
}

/** The result of {@link checkLimit}. */
export type LimitCheck = 'ok' | 'limit_exceeded';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The value of one limit: a non-negative integer, `Infinity`, or `undefined`
 * when the limit is not set. Throws `invalid_limits` for any other value or
 * for `limits` that is not an object.
 */
export function limitValue(limits: unknown, name: string): number | undefined {
  if (typeof limits !== 'object' || limits === null || typeof name !== 'string') {
    throw new TenancyError('invalid_limits');
  }
  if (!Object.hasOwn(limits, name)) {
    return undefined;
  }
  const value: unknown = Reflect.get(limits, name);
  if (value === undefined) {
    return undefined;
  }
  if (value !== Number.POSITIVE_INFINITY && !isCount(value)) {
    throw new TenancyError('invalid_limits');
  }
  return value;
}

/**
 * Whether `current + delta` stays within the named limit. An unset limit is
 * unlimited. Throws `invalid_limits` when the limit, `current` or `delta` is
 * not a non-negative integer (the limit may also be `Infinity`).
 */
export function checkLimit(
  limits: TenantLimits,
  name: string,
  current: number,
  delta = 1,
): LimitCheck {
  const limit = limitValue(limits, name);
  if (name.length === 0 || !isCount(current) || !isCount(delta)) {
    throw new TenancyError('invalid_limits');
  }
  if (limit === undefined || limit === Number.POSITIVE_INFINITY) {
    return 'ok';
  }
  return current + delta > limit ? 'limit_exceeded' : 'ok';
}
