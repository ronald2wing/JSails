/**
 * The portable-type layer of the column codec chain: for each portable type
 * and dialect, `encode` turns an application value into the {@link SqlValue}
 * the engine binds and `decode` turns what the engine returns back into the
 * application value. Codecs see non-null values only; `NULL` handling is the
 * caller's.
 *
 * Every encoding is chosen so the fidelity rule of `portable-type.ts` holds:
 * the round trip is lossless and the database's order and equality are the
 * application's. A value that would be stored differently on some dialect
 * (a string with U+0000, which PostgreSQL cannot store; a lone surrogate,
 * which UTF-8 cannot encode; a decimal digit past the scale, which the
 * servers would round; a year before 1000, which MariaDB cannot store) is
 * refused on every dialect, so a value accepted in development on SQLite is
 * accepted in production on a server.
 *
 * Per-dialect choices: strings bind as text on every dialect and are stored
 * binary-collated. `timestamp` binds as ISO 8601 UTC (`timestamptz(3)` on
 * PostgreSQL), as UTC wall-clock text on MariaDB (`datetime(3)`, with the
 * engine's session time zone pinned to UTC), and as fixed-width ISO text on
 * SQLite, whose text order is then chronological. A `decimal` of at most 18
 * digits is a scaled `INTEGER` on SQLite, so it stays exact, ordered and
 * summable; a wider one is fixed-width sortable text there. `uuid` is
 * `BINARY(16)` on MariaDB, whose own `UUID` type does not order bytewise.
 */

import type { Dialect, SqlValue } from '../engine/contract.js';
import { ColumnValueError, type ColumnValueErrorCode } from './model-error.js';
import type { DecimalType, JsonValue, PortableType, PortableValue } from './portable-type.js';

/** Encodes and decodes the non-null values of one portable type on one dialect. */
export interface PortableCodec<T extends PortableType = PortableType> {
  readonly type: T;
  readonly dialect: Dialect;
  /** The bound form of an application value; throws {@link ColumnValueError}. */
  encode(value: PortableValue<T>): SqlValue;
  /** The application value of a stored value; throws {@link ColumnValueError}. */
  decode(value: SqlValue): PortableValue<T>;
}

/** The widest `decimal` SQLite stores as a scaled 64-bit integer. */
export const SQLITE_SCALED_DECIMAL_PRECISION = 18;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
/** 1000-01-01T00:00:00.000Z and 9999-12-31T23:59:59.999Z: MariaDB's `DATETIME` range. */
const TIMESTAMP_MIN = Date.UTC(1000, 0, 1);
const TIMESTAMP_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const JSON_MAX_DEPTH = 256;

const DECIMAL_INPUT = /^(-)?(\d+)(?:\.(\d+))?$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_INPUT = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const TIME_STORED = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
const TIMESTAMP_STORED =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An unpaired surrogate: text UTF-8 cannot encode (`String#isWellFormed` is past ES2023). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NUL = '\u0000';

/** Whether every dialect stores `text` unchanged: well-formed UTF-16 with no U+0000. */
export function isStorableText(text: string): boolean {
  return !LONE_SURROGATE.test(text) && !text.includes(NUL);
}

type Fail = (code: ColumnValueErrorCode) => never;

function failer(type: PortableType, field: string | undefined): Fail {
  return (code) => {
    throw new ColumnValueError(code, type.kind, field);
  };
}

/** A string every dialect stores unchanged: well-formed UTF-16 with no U+0000. */
function storableString(value: unknown, fail: Fail): string {
  if (typeof value !== 'string') return fail('invalid_value');
  if (!isStorableText(value)) return fail('invalid_value');
  return value;
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

function storedString(value: SqlValue, fail: Fail): string {
  return typeof value === 'string' ? value : fail('invalid_stored_value');
}

/** An integer the engine returned, as a `bigint`. */
function storedInteger(value: SqlValue, fail: Fail): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return fail('invalid_stored_value');
}

/** A plain `Uint8Array` view of driver bytes (a `Buffer` on the server drivers). */
function plainBytes(value: Uint8Array): Uint8Array {
  return Object.getPrototypeOf(value) === Uint8Array.prototype
    ? value
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

// --- decimal -------------------------------------------------------------

interface DecimalParts {
  readonly negative: boolean;
  /** Integer digits with no leading zeros (empty for zero). */
  readonly integer: string;
  /** Fraction digits padded to the scale. */
  readonly fraction: string;
}

function decimalParts(text: string, type: DecimalType, fail: Fail, stored: boolean): DecimalParts {
  const match = DECIMAL_INPUT.exec(text);
  if (match === null) return fail(stored ? 'invalid_stored_value' : 'invalid_value');
  const integer = (match[2] ?? '').replace(/^0+/, '');
  let fraction = match[3] ?? '';
  if (fraction.length > type.scale) {
    if (!/^0*$/.test(fraction.slice(type.scale))) {
      return fail(stored ? 'invalid_stored_value' : 'too_precise');
    }
    fraction = fraction.slice(0, type.scale);
  }
  fraction = fraction.padEnd(type.scale, '0');
  if (integer.length > type.precision - type.scale) {
    return fail(stored ? 'invalid_stored_value' : 'out_of_range');
  }
  const zero = integer === '' && /^0*$/.test(fraction);
  return { negative: match[1] === '-' && !zero, integer, fraction };
}

function canonicalDecimal(parts: DecimalParts): string {
  const integer = parts.integer === '' ? '0' : parts.integer;
  const body = parts.fraction === '' ? integer : `${integer}.${parts.fraction}`;
  return parts.negative ? `-${body}` : body;
}

/** The decimal as an integer count of its smallest unit (`10^-scale`). */
function scaledDecimal(parts: DecimalParts): bigint {
  const magnitude = BigInt(`${parts.integer}${parts.fraction}` || '0');
  return parts.negative ? -magnitude : magnitude;
}

function decimalFromScaled(scaled: bigint, type: DecimalType, fail: Fail): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString();
  if (digits.length > type.precision) return fail('invalid_stored_value');
  const padded = digits.padStart(type.scale + 1, '0');
  const integer = padded.slice(0, padded.length - type.scale).replace(/^0+/, '');
  const fraction = padded.slice(padded.length - type.scale);
  return canonicalDecimal({ negative, integer, fraction });
}

/**
 * Fixed-width text whose byte order is numeric order: a sign digit (`0`
 * negative, `1` otherwise) then the scaled magnitude in `precision` digits,
 * nines-complemented when negative so a larger magnitude sorts first.
 */
function sortableDecimal(parts: DecimalParts, type: DecimalType): string {
  const digits = `${parts.integer}${parts.fraction}`.padStart(type.precision, '0');
  if (!parts.negative) return `1${digits}`;
  return `0${digits.replace(/\d/g, (digit) => String(9 - Number(digit)))}`;
}

function decimalFromSortable(text: string, type: DecimalType, fail: Fail): string {
  if (text.length !== type.precision + 1 || !/^[01]\d+$/.test(text)) {
    return fail('invalid_stored_value');
  }
  const negative = text.startsWith('0');
  const raw = text.slice(1);
  const digits = negative ? raw.replace(/\d/g, (digit) => String(9 - Number(digit))) : raw;
  return decimalFromScaled(BigInt(negative ? `-${digits}` : digits), type, fail);
}

// --- dates and times -----------------------------------------------------

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Milliseconds from a fraction of up to 6 digits, refusing digits past the millisecond. */
function milliseconds(fraction: string | undefined, fail: Fail): number {
  if (fraction === undefined) return 0;
  const padded = fraction.padEnd(6, '0');
  if (padded.slice(3) !== '000') return fail('invalid_stored_value');
  return Number(padded.slice(0, 3));
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(2000, month - 1, day));
  probe.setUTCFullYear(year);
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function encodeTimestamp(value: unknown, dialect: Dialect, fail: Fail): string {
  if (!(value instanceof Date)) return fail('invalid_value');
  const time = value.getTime();
  if (Number.isNaN(time)) return fail('invalid_value');
  if (time < TIMESTAMP_MIN || time > TIMESTAMP_MAX) return fail('out_of_range');
  const iso = value.toISOString();
  return dialect === 'mariadb' ? `${iso.slice(0, 10)} ${iso.slice(11, 23)}` : iso;
}

function offsetMinutes(zone: string | undefined): number {
  if (zone === undefined || zone === 'Z') return 0;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(/:/g, '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4) || '0');
  const seconds = Number(digits.slice(4, 6) || '0');
  return sign * (hours * 60 + minutes + seconds / 60);
}

function decodeTimestamp(value: SqlValue, fail: Fail): Date {
  const text = storedString(value, fail);
  const match = TIMESTAMP_STORED.exec(text);
  if (match === null) return fail('invalid_stored_value');
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
    return fail('invalid_stored_value');
  }
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  date.setUTCFullYear(year);
  const time = date.getTime() + milliseconds(match[7], fail) - offsetMinutes(match[8]) * 60_000;
  return new Date(time);
}

function encodeDate(value: unknown, fail: Fail): string {
  if (typeof value !== 'string') return fail('invalid_value');
  const match = DATE_TEXT.exec(value);
  if (match === null) return fail('invalid_value');
  if (!validDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return fail('out_of_range');
  }
  return value;
}

function decodeDate(value: SqlValue, fail: Fail): string {
  const text = storedString(value, fail);
  const match = DATE_TEXT.exec(text);
  if (match === null || !validDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
    return fail('invalid_stored_value');
  }
  return text;
}

function canonicalTime(
  match: RegExpExecArray,
  millis: number,
  fail: Fail,
  stored: boolean,
): string {
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    return fail(stored ? 'invalid_stored_value' : 'out_of_range');
  }
  return `${match[1]}:${match[2]}:${match[3]}.${pad(millis, 3)}`;
}

function encodeTime(value: unknown, fail: Fail): string {
  if (typeof value !== 'string') return fail('invalid_value');
  const match = TIME_INPUT.exec(value);
  if (match === null) return fail('invalid_value');
  return canonicalTime(match, Number((match[4] ?? '').padEnd(3, '0')), fail, false);
}

function decodeTime(value: SqlValue, fail: Fail): string {
  const match = TIME_STORED.exec(storedString(value, fail));
  if (match === null) return fail('invalid_stored_value');
  return canonicalTime(match, milliseconds(match[4], fail), fail, true);
}

// --- json and uuid -------------------------------------------------------

function checkJson(value: unknown, depth: number, fail: Fail): void {
  if (depth > JSON_MAX_DEPTH) fail('invalid_value');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_value');
    return;
  }
  if (typeof value === 'string') {
    storableString(value, fail);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1, fail);
    return;
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('invalid_value');
    if (Object.getOwnPropertySymbols(value).length > 0) fail('invalid_value');
    for (const [key, item] of Object.entries(value)) {
      storableString(key, fail);
      if (item === undefined) fail('invalid_value');
      checkJson(item, depth + 1, fail);
    }
    return;
  }
  fail('invalid_value');
}

function uuidBytes(text: string): Uint8Array {
  const hex = text.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function uuidText(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// --- the codec table -----------------------------------------------------

interface Pair {
  encode(value: unknown): SqlValue;
  decode(value: SqlValue): unknown;
}

function pair(type: PortableType, dialect: Dialect, fail: Fail): Pair {
  switch (type.kind) {
    case 'id':
      return {
        encode: (value) =>
          typeof value === 'number' && Number.isSafeInteger(value) ? value : fail('invalid_value'),
        decode: (value) => {
          const integer = storedInteger(value, fail);
          if (
            integer > BigInt(Number.MAX_SAFE_INTEGER) ||
            integer < -BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            return fail('unsafe_integer');
          }
          return Number(integer);
        },
      };
    case 'integer':
      return {
        encode: (value) => {
          if (typeof value !== 'number' || !Number.isInteger(value)) return fail('invalid_value');
          return value < INT32_MIN || value > INT32_MAX ? fail('out_of_range') : value;
        },
        decode: (value) => {
          const integer = storedInteger(value, fail);
          if (integer < BigInt(INT32_MIN) || integer > BigInt(INT32_MAX)) {
            return fail('invalid_stored_value');
          }
          return Number(integer);
        },
      };
    case 'bigint':
      return {
        encode: (value) => {
          if (typeof value !== 'bigint') return fail('invalid_value');
          return value < INT64_MIN || value > INT64_MAX ? fail('out_of_range') : value;
        },
        decode: (value) => storedInteger(value, fail),
      };
    case 'float':
      return {
        encode: (value) => {
          if (typeof value !== 'number' || !Number.isFinite(value)) return fail('invalid_value');
          // -0 and 0 are one value in every dialect's order and equality.
          return value === 0 ? 0 : value;
        },
        decode: (value) =>
          typeof value === 'number' && Number.isFinite(value)
            ? value === 0
              ? 0
              : value
            : typeof value === 'bigint'
              ? Number(value)
              : fail('invalid_stored_value'),
      };
    case 'decimal': {
      const scaled = dialect === 'sqlite' && type.precision <= SQLITE_SCALED_DECIMAL_PRECISION;
      return {
        encode: (value) => {
          if (typeof value !== 'string') return fail('invalid_value');
          const parts = decimalParts(value, type, fail, false);
          if (dialect !== 'sqlite') return canonicalDecimal(parts);
          return scaled ? scaledDecimal(parts) : sortableDecimal(parts, type);
        },
        decode: (value) => {
          if (dialect !== 'sqlite') {
            return canonicalDecimal(decimalParts(storedString(value, fail), type, fail, true));
          }
          return scaled
            ? decimalFromScaled(storedInteger(value, fail), type, fail)
            : decimalFromSortable(storedString(value, fail), type, fail);
        },
      };
    }
    case 'boolean':
      return {
        encode: (value) => {
          if (typeof value !== 'boolean') return fail('invalid_value');
          return dialect === 'postgres' ? value : value ? 1 : 0;
        },
        decode: (value) => {
          if (typeof value === 'boolean') return value;
          if (value === 0 || value === 0n) return false;
          if (value === 1 || value === 1n) return true;
          return fail('invalid_stored_value');
        },
      };
    case 'string':
      return {
        encode: (value) => {
          const text = storableString(value, fail);
          return codePointLength(text) > type.length ? fail('too_long') : text;
        },
        decode: (value) => storedString(value, fail),
      };
    case 'text':
      return {
        encode: (value) => storableString(value, fail),
        decode: (value) => storedString(value, fail),
      };
    case 'timestamp':
      return {
        encode: (value) => encodeTimestamp(value, dialect, fail),
        decode: (value) => decodeTimestamp(value, fail),
      };
    case 'date':
      return {
        encode: (value) => encodeDate(value, fail),
        decode: (value) => decodeDate(value, fail),
      };
    case 'time':
      return {
        encode: (value) => encodeTime(value, fail),
        decode: (value) => decodeTime(value, fail),
      };
    case 'json':
      return {
        encode: (value) => {
          if (value === null) return fail('invalid_value');
          checkJson(value, 0, fail);
          return JSON.stringify(value);
        },
        decode: (value) => {
          const text = storedString(value, fail);
          try {
            return JSON.parse(text) as JsonValue;
          } catch {
            // The parse error quotes the stored text, which may be secret.
            return fail('invalid_stored_value');
          }
        },
      };
    case 'uuid':
      return {
        encode: (value) => {
          if (typeof value !== 'string' || !UUID_TEXT.test(value)) return fail('invalid_value');
          const text = value.toLowerCase();
          return dialect === 'mariadb' ? uuidBytes(text) : text;
        },
        decode: (value) => {
          if (dialect === 'mariadb') {
            return value instanceof Uint8Array && value.length === 16
              ? uuidText(value)
              : fail('invalid_stored_value');
          }
          const text = storedString(value, fail);
          return UUID_TEXT.test(text) ? text.toLowerCase() : fail('invalid_stored_value');
        },
      };
    case 'binary':
      return {
        encode: (value) => {
          if (!(value instanceof Uint8Array)) return fail('invalid_value');
          return type.length !== undefined && value.length > type.length ? fail('too_long') : value;
        },
        decode: (value) =>
          value instanceof Uint8Array ? plainBytes(value) : fail('invalid_stored_value'),
      };
  }
}

/**
 * The codec of `type` on `dialect`. `field` names the property in the errors
 * it throws.
 */
export function portableCodec<T extends PortableType>(
  type: T,
  dialect: Dialect,
  field?: string,
): PortableCodec<T> {
  const { encode, decode } = pair(type, dialect, failer(type, field));
  return Object.freeze({
    type,
    dialect,
    encode,
    decode: decode as (value: SqlValue) => PortableValue<T>,
  });
}
