/**
 * Byte-stable wire encoding shared by the first-party adapters.
 *
 * A prompt cache matches on the exact bytes of the request prefix, so the
 * same run options must always serialize to the same body. Schemas are
 * re-emitted with their keywords in sorted order (a schema assembled by
 * different code paths can list the same keywords in a different order),
 * while the entries of a name-keyed map (`properties`, `$defs`, ...) keep
 * their declared order, which is what the model sees as field order. Data
 * keywords (`const`, `enum`, `default`, `examples`) are copied as they are.
 *
 * Tool-call ids cross providers: each provider restricts the characters and
 * length of an id it accepts, so {@link fitToolCallId} maps a foreign id to a
 * conforming one, deterministically, so the call and its result still match.
 * A streamed tool input that is not a JSON object is kept under the reserved
 * {@link INVALID_JSON_KEY}.
 */

import { isPlainObject } from '../content/json-value.js';

/** Keywords whose value is a map from names to subschemas, kept in declared order. */
const NAMED_MAPS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/** Keywords whose value is data, not a schema. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['const', 'enum', 'default', 'examples']);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return (value as readonly unknown[]).map(canonicalValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    let copied: unknown;
    if (DATA_KEYWORDS.has(key)) {
      copied = field;
    } else if (NAMED_MAPS.has(key) && isPlainObject(field)) {
      const map: Record<string, unknown> = {};
      for (const name of Object.keys(field)) {
        Object.defineProperty(map, name, {
          value: canonicalValue(field[name]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      copied = map;
    } else {
      copied = canonicalValue(field);
    }
    Object.defineProperty(out, key, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * A copy of a JSON Schema with its keywords in sorted order at every level and
 * the entries of name-keyed maps in their declared order.
 */
export function canonicalSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return canonicalValue(schema) as Record<string, unknown>;
}

/** 32-bit FNV-1a over the UTF-16 code units of `text`, from `seed`. */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * `id` when it is made only of letters, digits, `_`, and `-` and is at most
 * `maxLength` long; otherwise a conforming id derived from it (a sanitized
 * prefix plus a 64-bit hash), the same for the same input every time.
 */
export function fitToolCallId(id: string, maxLength: number): string {
  if (id.length > 0 && id.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(id)) return id;
  const hash =
    fnv1a(id, 0x811c9dc5).toString(16).padStart(8, '0') +
    fnv1a(id, 0x01000193).toString(16).padStart(8, '0');
  const prefix = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, Math.max(0, maxLength - 21));
  return `call_${prefix}${prefix.length > 0 ? '_' : ''}${hash}`.slice(0, maxLength);
}

/** The UTF-8 text of valid base64 `data`. */
export function decodeBase64Text(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * The reserved key of the wrapper around a tool input that was not a JSON
 * object. No tool may declare an input property of this name, so a wrapped
 * input can never be mistaken for real arguments.
 */
export const INVALID_JSON_KEY = 'INVALID_JSON';

/**
 * Parse a tool input the model streamed as JSON text. Empty text is `{}`;
 * text that is not JSON, or JSON that is not an object, is wrapped as
 * `{ INVALID_JSON: text }`, the form Anthropic documents for replaying an
 * unparseable eager input, so the transcript still replays byte for byte.
 * {@link isUnparsedInput} recognizes the wrapper, and the run turns such a
 * call into an `is_error` result before the tool's schema is consulted: a
 * schema whose fields are all optional would otherwise strip the key and
 * accept `{}`.
 */
export function parseStreamedInput(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { [INVALID_JSON_KEY]: text };
  }
  return isPlainObject(value) ? value : { [INVALID_JSON_KEY]: text };
}

/** Whether a raw tool input carries the reserved {@link INVALID_JSON_KEY}. */
export function isUnparsedInput(value: unknown): boolean {
  return isPlainObject(value) && Object.hasOwn(value, INVALID_JSON_KEY);
}
