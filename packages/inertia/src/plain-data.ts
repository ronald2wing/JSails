/**
 * The two predicates the props walk, the serializer, and the metadata builders
 * share: which keys may never appear in a page object, and which objects count
 * as plain data.
 *
 * `__proto__`, `constructor`, and `prototype` are rejected everywhere because
 * the client's `JSON.parse` creates them as own keys and later merges (deep
 * merge, error-bag scoping) would treat them as prototype access. A plain
 * object is one whose prototype is `Object.prototype` or `null`; every class
 * instance, ORM records included, fails the test, which is what keeps them out
 * of the browser.
 */

/** Keys that never appear in a page object. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Whether `value` is a literal or null-prototype object. */
export function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
