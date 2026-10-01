/**
 * The one encoding of a primary key as a map/wire string, shared by relation
 * loading, live change capture, and the `@jsails/live` row identity so the
 * three never drift: a single column is its `String()` form, a composite key
 * is the JSON array of its values in column order.
 */

/** Serialize single or composite primary-key values into a stable string key. */
export function serializePrimaryKey(values: readonly unknown[]): string {
  return values.length === 1 ? String(values[0]) : JSON.stringify(values);
}
