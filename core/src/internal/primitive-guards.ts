/**
 * Primitive and range guards shared by the support namespaces.
 *
 * The guards are predicates; each caller supplies its own domain error and
 * operation label, so messages stay specific without duplicating the checks.
 */

/** True for a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** True for a finite positive integer. */
export function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 1 && Number.isInteger(value)
  );
}

/** True for a finite non-negative integer. */
export function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value)
  );
}
