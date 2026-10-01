/**
 * The tenant identifier.
 *
 * A tenant id is the positive integer primary key of the tenant row. It stays a
 * number everywhere in the package; only a context-propagation codec turns it
 * into a string, so a string id is never compared with a numeric one.
 */

/** A tenant's primary key: a positive safe integer. */
export type TenantId = number;

/** Whether `value` is a valid {@link TenantId}. */
export function isTenantId(value: unknown): value is TenantId {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
