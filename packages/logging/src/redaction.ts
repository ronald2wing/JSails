/**
 * Context redaction for log records: values under secret-looking keys are
 * replaced with a fixed marker before any channel, formatter, or signal
 * observer sees the record.
 *
 * Matching is by key name, not value. A key matches when its normalized form
 * (lower-cased, with `-` and `_` removed) ends with one of the configured
 * names, so the default `token` also covers `accessToken` and `csrf_token`,
 * and `cookie` covers `set-cookie`. Plain objects, arrays, and class
 * instances (an ORM entity, a DTO) are walked to a fixed depth (anything
 * deeper, and a cycle, becomes a marker, so nothing unwalked can carry a
 * secret through). A class instance becomes a plain copy of its own
 * enumerable properties, which is exactly what `JSON.stringify` would have
 * written, so an entity's `apiToken` column is redacted like a plain key.
 * Objects that serialize themselves or carry meaning beyond their own
 * properties are kept as they are: anything with a `toJSON` method (`Date`,
 * `Buffer`), `Error` (the formatters reduce it to name, message, and code),
 * `Map`, `Set`, and typed arrays.
 */

/** The marker that replaces a redacted value. */
export const REDACTED = '[redacted]';

/** Key names redacted when the logger is given no `redact` option. */
export const DEFAULT_REDACT_KEYS: readonly string[] = Object.freeze([
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'credentials',
]);

/** How deep nested plain objects and arrays are walked. */
const MAX_DEPTH = 8;

/** Replaces a structure nested deeper than {@link MAX_DEPTH}. */
const TRUNCATED = '[truncated]';

/** Replaces a reference back to an object on the current path. */
const CIRCULAR = '[circular]';

/** Normalize a key for matching: lower-case, separators removed. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** A compiled key matcher, or `undefined` when nothing is redacted. */
export type RedactionMatcher = (key: string) => boolean;

/**
 * Compile the configured key names. Throws a value-free `TypeError` when the
 * option is not an array of non-empty strings.
 */
export function compileRedaction(keys: readonly string[]): RedactionMatcher | undefined {
  if (!Array.isArray(keys)) {
    throw new TypeError('redact must be an array of key names');
  }
  const names = keys.map((key: unknown, index) => {
    if (typeof key !== 'string' || normalizeKey(key) === '') {
      throw new TypeError(`redact[${index}] must be a non-empty key name`);
    }
    return normalizeKey(key);
  });
  if (names.length === 0) {
    return undefined;
  }
  return (key) => {
    const normalized = normalizeKey(key);
    return names.some((name) => normalized.endsWith(name));
  };
}

/** Whether `value` is an object literal (or a null-prototype record). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether `value` is an object kept as is rather than walked: it serializes
 * itself (`toJSON`) or its content is not its own enumerable properties.
 */
function isOpaqueObject(value: object): boolean {
  return (
    typeof (value as { toJSON?: unknown }).toJSON === 'function' ||
    value instanceof Error ||
    value instanceof Map ||
    value instanceof Set ||
    ArrayBuffer.isView(value)
  );
}

/**
 * Copy `value` with matching keys replaced. `ancestors` holds the objects on
 * the current path only, so a cycle is cut where it closes while an object
 * referenced twice is still redacted both times.
 */
function redactValue(
  value: unknown,
  matches: RedactionMatcher,
  depth: number,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (!Array.isArray(value) && !isPlainObject(value) && isOpaqueObject(value)) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactValue(item, matches, depth + 1, ancestors));
    }
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = matches(key) ? REDACTED : redactValue(entry, matches, depth + 1, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/** A frozen copy of `context` with every matching key's value replaced. */
export function redactContext(
  context: Readonly<Record<string, unknown>>,
  matches: RedactionMatcher,
): Readonly<Record<string, unknown>> {
  return Object.freeze(redactValue(context, matches, 0, new Set()) as Record<string, unknown>);
}
