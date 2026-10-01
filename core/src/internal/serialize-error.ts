/**
 * JSON-safe error serialization.
 *
 * Errors keep `name`, `message`, `stack`, `cause`, and enumerable own properties
 * (such as `code`). Non-Error values become a `NonError` record. Circular
 * references are replaced with `[Circular]`.
 */

function jsonSafe(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (type === 'undefined' || type === 'function' || type === 'symbol') return undefined;
  if (value instanceof Error) return serializeError(value, seen);
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, seen));
  if (type !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  if (seen.has(record)) return '[Circular]';
  seen.add(record);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const safe = jsonSafe(entry, seen);
    if (safe !== undefined) result[key] = safe;
  }
  seen.delete(record);
  return result;
}

/** Serialize any thrown value into a plain, JSON-safe object. */
export function serializeError(
  error: unknown,
  seen: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      name: 'NonError',
      message: typeof error === 'string' ? error : String(error),
    };
  }

  if (seen.has(error)) return { name: 'Circular', message: '[Circular]' };
  seen.add(error);

  const result: Record<string, unknown> = { name: error.name, message: error.message };
  if (typeof error.stack === 'string') result.stack = error.stack;
  if (error.cause !== undefined) result.cause = serializeError(error.cause, seen);

  for (const key of Object.keys(error)) {
    if (key in result) continue;
    const safe = jsonSafe((error as unknown as Record<string, unknown>)[key], seen);
    if (safe !== undefined) result[key] = safe;
  }

  return result;
}
