/**
 * Primitive and range guards shared by the support namespaces.
 *
 * Each guard names what it found wrong as an {@link ArgumentProblem} code and
 * hands it, with the caller's operation label, to the caller's own error
 * factory, so every namespace raises the failure from its own error registry
 * without duplicating the checks. Each registry declares the codes of the
 * guards it calls as literals, so its type stays inferable under
 * `isolatedDeclarations`: an `internal` code with an `{operation}` slot.
 */

/**
 * What a guard found wrong with an argument.
 *
 * @public
 */
export type ArgumentProblem =
  'expected_string' | 'expected_positive_integer' | 'expected_non_negative_integer';

/**
 * Builds the caller's error for a failed guard. `P` narrows the codes a
 * factory must handle to the guards its namespace calls.
 *
 * @public
 */
export type ArgumentErrorFactory<P extends ArgumentProblem = ArgumentProblem> = (
  problem: P,
  operation: string,
) => Error;

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

/** Throw `makeError('expected_string', operation)` unless `value` is a string. */
export function assertString(
  value: unknown,
  operation: string,
  makeError: ArgumentErrorFactory<'expected_string'>,
): asserts value is string {
  if (!isString(value)) throw makeError('expected_string', operation);
}

/** Throw `makeError('expected_positive_integer', operation)` unless `value` is a positive integer. */
export function assertPositiveInteger(
  value: unknown,
  operation: string,
  makeError: ArgumentErrorFactory<'expected_positive_integer'>,
): asserts value is number {
  if (!isPositiveInteger(value)) throw makeError('expected_positive_integer', operation);
}

/**
 * Throw `makeError('expected_non_negative_integer', operation)` unless `value`
 * is a non-negative integer.
 */
export function assertNonNegativeInteger(
  value: unknown,
  operation: string,
  makeError: ArgumentErrorFactory<'expected_non_negative_integer'>,
): asserts value is number {
  if (!isNonNegativeInteger(value)) throw makeError('expected_non_negative_integer', operation);
}
