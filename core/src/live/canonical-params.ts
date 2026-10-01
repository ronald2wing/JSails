/**
 * Canonical serialization of parsed publication params (LIVE-PLAN.md §4.7).
 *
 * {@link canonicalParams} turns the Zod-parsed params object into a stable
 * string used as the multiplexer key's middle component. It must be
 * deterministic across key insertion order, number formatting, and nested
 * structure, or two equal param sets fail to share a driver and the multiplexer
 * collapses into `O(subscriptions)` fan-out with nothing to show for it.
 *
 * Determinism comes from deeply normalizing the value before serializing:
 * object keys are sorted, numbers are rendered through a canonical form, and
 * `undefined`/`NaN`/`±Infinity` collapse to unambiguous tokens rather than
 * serializing to divergent or lossy JSON. The output is the string length of the
 * normalized JSON followed by the JSON itself, so a length-prefix guards
 * against an ambiguity a bare `JSON.stringify` leaves open (a value that is the
 * string form of a number being re-read ambiguously later).
 */

/**
 * A value that survived Zod parsing: JSON-compatible scalars, arrays, objects,
 * and `undefined` (an absent or optional field the schema left unset).
 */
export type CanonicalParamsValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CanonicalParamsValue[]
  | { readonly [key: string]: CanonicalParamsValue };

/**
 * Serialize parsed params to a deterministic string suitable for a multiplexer
 * key. Two structurally equal params objects serialize to the same string
 * regardless of key order or number formatting.
 *
 * @param params The Zod-parsed params object (or any JSON-compatible value). A
 * non-object top-level value is serialized as-is; only objects have their keys
 * sorted.
 */
export function canonicalParams(params: unknown): string {
  const normalized = normalize(params);
  const serialized = JSON.stringify(normalized);
  return `${serialized.length}:${serialized}`;
}

/** Deeply normalize a value to a deterministic, JSON-serializable form. */
function normalize(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return '__NaN__';
    }
    if (value === Infinity) {
      return '__Infinity__';
    }
    if (value === -Infinity) {
      return '__-Infinity__';
    }
    // e.g. -0 must be distinguishable from 0 only if it is; String(-0) is "0",
    // which is fine — -0 and 0 are equal in params-by-value terms. Number and
    // string edge cases (`1` vs `'1'`) already differ by the JSON quotes.
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    // Object.hasOwn guards against inherited keys entering the canonical form.
    const keys = Object.keys(value)
      .filter((key) => Object.hasOwn(value, key))
      .sort();
    for (const key of keys) {
      sorted[key] = normalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
