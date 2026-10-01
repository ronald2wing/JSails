/**
 * JSON value checks and frozen copies.
 *
 * Tool inputs and provider-native blocks are opaque to the package but must
 * survive a JSON round trip unchanged (they are persisted in conversations and
 * replayed to providers). {@link copyJson} accepts only plain JSON (plain
 * objects, arrays, strings, finite numbers, booleans, `null`) and returns a
 * deep-frozen copy, so a caller cannot mutate history after handing it over.
 */

/** The deepest nesting {@link copyJson} accepts. */
export const MAX_JSON_DEPTH = 128;

/** A JSON value. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Whether `value` is a plain object: an object whose prototype is `Object.prototype` or `null`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copy(value: unknown, depth: number, path: Set<object>): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth > MAX_JSON_DEPTH || path.has(value)) return undefined;
  path.add(value);
  try {
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      for (const item of value as readonly unknown[]) {
        const copied = copy(item, depth + 1, path);
        if (copied === undefined) return undefined;
        items.push(copied);
      }
      return Object.freeze(items);
    }
    if (!isPlainObject(value)) return undefined;
    const record: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const copied = copy(value[key], depth + 1, path);
      if (copied === undefined) return undefined;
      Object.defineProperty(record, key, {
        value: copied,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(record);
  } finally {
    path.delete(value);
  }
}

/**
 * A deep-frozen copy of `value` when it is plain JSON, otherwise `undefined`.
 * Cycles, class instances, functions, symbols, `undefined`, bigints, and
 * non-finite numbers make the whole value non-JSON.
 */
export function copyJson(value: unknown): JsonValue | undefined {
  return copy(value, 0, new Set());
}

/** Whether `value` is plain JSON (see {@link copyJson}). */
export function isJsonValue(value: unknown): value is JsonValue {
  return copyJson(value) !== undefined;
}
