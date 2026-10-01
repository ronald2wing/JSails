/**
 * The plain-JSON rule for everything an envelope carries. A transport may
 * serialize the envelope, so a value is accepted only when `JSON.parse(JSON.stringify(v))`
 * gives back an equal value: no `undefined` (JSON drops it), no non-finite
 * number (JSON turns it into `null`), no class instance such as a `Date` or a
 * `Map` (JSON flattens it), no `-0` (JSON writes `0`), and no cycle.
 */

/** Deeper nesting is refused rather than walked, which also bounds a cyclic value. */
export const MAX_JSON_DEPTH = 64;

/** Whether `value` survives a JSON round trip unchanged. */
export function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !isPlainJson(value[index], depth + 1)) return false;
    }
    return true;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    if (key === '__proto__') return false;
    if (!isPlainJson((value as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}
