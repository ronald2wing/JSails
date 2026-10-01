/**
 * The portable column types: the only types a model can declare. Each one is
 * plain data (`{ kind, ...parameters }`), means the same thing on PostgreSQL,
 * MariaDB and SQLite, and obeys the fidelity rule: for every value `x` the
 * type accepts, `decode(encode(x))` is `x` in its canonical form, and the
 * database orders and compares stored values exactly as {@link compareValues}
 * orders the application values. `portable-codec.ts` holds the per-dialect
 * encoding and `physical-table.ts` the per-dialect column types.
 *
 * Application values: `id` and `integer` and `float` are `number`, `bigint` a
 * JS `bigint`, `decimal` a canonical decimal string, `string`/`text` a
 * string, `boolean` a boolean, `timestamp` a `Date` (millisecond precision,
 * UTC), `date` a `YYYY-MM-DD` string, `time` an `HH:MM:SS.sss` string, `json`
 * a plain JSON value, `uuid` a lowercase canonical UUID string, and `binary`
 * a `Uint8Array`. SQL `NULL` is `null` for every type, so a `json` column
 * cannot hold the JSON literal `null` as distinct from `NULL`.
 */

import { ModelSpecError } from './model-error.js';

/** A portable column type. */
export type PortableType =
  | IdType
  | StringType
  | TextType
  | IntegerType
  | BigintType
  | DecimalType
  | FloatType
  | BooleanType
  | TimestampType
  | DateType
  | TimeType
  | JsonType
  | UuidType
  | BinaryType;

/**
 * A 64-bit key read as a `number`; reading one above
 * `Number.MAX_SAFE_INTEGER` throws. As the sole primary key it is generated
 * by the database (an identity that never reuses a value); elsewhere it is a
 * plain key value, the type of every foreign key to such a primary key.
 */
export interface IdType {
  readonly kind: 'id';
}
/** Text of at most `length` characters (code points), binary-collated. */
export interface StringType {
  readonly kind: 'string';
  readonly length: number;
}
/** Text of any length, binary-collated; not indexable. */
export interface TextType {
  readonly kind: 'text';
}
/** A 32-bit signed integer. */
export interface IntegerType {
  readonly kind: 'integer';
}
/** A 64-bit signed integer, read as a JS `bigint`. */
export interface BigintType {
  readonly kind: 'bigint';
}
/** An exact decimal of `precision` digits, `scale` of them after the point, read as a string. */
export interface DecimalType {
  readonly kind: 'decimal';
  readonly precision: number;
  readonly scale: number;
}
/** An IEEE 754 double; `NaN` and the infinities are refused. */
export interface FloatType {
  readonly kind: 'float';
}
export interface BooleanType {
  readonly kind: 'boolean';
}
/** An instant with millisecond precision, from year 1000 to 9999 UTC. */
export interface TimestampType {
  readonly kind: 'timestamp';
}
/** A calendar date with no time zone, from 1000-01-01 to 9999-12-31. */
export interface DateType {
  readonly kind: 'date';
}
/** A time of day with millisecond precision and no time zone. */
export interface TimeType {
  readonly kind: 'time';
}
/** A plain JSON value; not orderable, not indexable. */
export interface JsonType {
  readonly kind: 'json';
}
export interface UuidType {
  readonly kind: 'uuid';
}
/** Bytes, at most `length` of them when it is set; unbounded bytes are not indexable. */
export interface BinaryType {
  readonly kind: 'binary';
  readonly length?: number;
}

/** A plain JSON value. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The application value of a portable type, without `null`. */
export type PortableValue<T extends PortableType> = T extends IdType | IntegerType | FloatType
  ? number
  : T extends BigintType
    ? bigint
    : T extends BooleanType
      ? boolean
      : T extends TimestampType
        ? Date
        : T extends JsonType
          ? JsonValue
          : T extends BinaryType
            ? Uint8Array
            : string;

/** Every portable type kind. */
export const PORTABLE_KINDS: readonly PortableType['kind'][] = Object.freeze([
  'id',
  'string',
  'text',
  'integer',
  'bigint',
  'decimal',
  'float',
  'boolean',
  'timestamp',
  'date',
  'time',
  'json',
  'uuid',
  'binary',
]);

/**
 * The longest `string`: MariaDB's `VARCHAR` limit in utf8mb4 characters
 * (65,535 bytes over 4 bytes per character, less the length prefix).
 */
export const MAX_STRING_LENGTH = 16383;
/** The longest bounded `binary`: MariaDB's `VARBINARY` limit less the length prefix. */
export const MAX_BINARY_LENGTH = 65532;
/** The most digits of a `decimal`: the precision every dialect keeps exactly and orders. */
export const MAX_DECIMAL_PRECISION = 38;

/**
 * The largest index entry, in bytes, that fits every dialect: PostgreSQL's
 * B-tree limit (2704 bytes, the 8-byte tuple header and alignment included;
 * MariaDB's InnoDB key limit is 3072). {@link indexEntryBytes} counts a key
 * against it at its worst case.
 */
export const MAX_INDEX_KEY_BYTES = 2704;
/** MariaDB's row size limit, which counts each column at its worst case. */
export const MAX_ROW_BYTES = 65535;

function isPositiveInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

/**
 * Check that `type` is a portable type with parameters in range, and return
 * a frozen copy holding only its own fields.
 */
export function portableType(type: unknown, model?: string, field?: string): PortableType {
  const fail = (): ModelSpecError => new ModelSpecError('invalid_type', { model, field });
  if (type === null || typeof type !== 'object' || Array.isArray(type)) throw fail();
  const record = type as Record<string, unknown>;
  const kind = record.kind;
  const keys = Object.keys(record);
  const only = (...allowed: string[]): void => {
    if (!keys.every((key) => key === 'kind' || allowed.includes(key))) throw fail();
  };
  switch (kind) {
    case 'string':
      only('length');
      if (!isPositiveInteger(record.length, MAX_STRING_LENGTH)) throw fail();
      return Object.freeze({ kind, length: record.length });
    case 'decimal': {
      only('precision', 'scale');
      const { precision, scale } = record;
      if (!isPositiveInteger(precision, MAX_DECIMAL_PRECISION)) throw fail();
      if (typeof scale !== 'number' || !Number.isSafeInteger(scale) || scale < 0) throw fail();
      if (scale > precision) throw fail();
      return Object.freeze({ kind, precision, scale });
    }
    case 'binary':
      only('length');
      if (record.length === undefined) return Object.freeze({ kind });
      if (!isPositiveInteger(record.length, MAX_BINARY_LENGTH)) throw fail();
      return Object.freeze({ kind, length: record.length });
    case 'id':
    case 'text':
    case 'integer':
    case 'bigint':
    case 'float':
    case 'boolean':
    case 'timestamp':
    case 'date':
    case 'time':
    case 'json':
    case 'uuid':
      only();
      return Object.freeze({ kind });
    default:
      throw fail();
  }
}

/** Whether two portable types are the same type with the same parameters. */
export function sameType(a: PortableType, b: PortableType): boolean {
  return describeType(a) === describeType(b);
}

/** A short, stable spelling of a portable type: `string(255)`, `decimal(10,2)`, `binary`. */
export function describeType(type: PortableType): string {
  switch (type.kind) {
    case 'string':
      return `string(${type.length})`;
    case 'decimal':
      return `decimal(${type.precision},${type.scale})`;
    case 'binary':
      return type.length === undefined ? 'binary' : `binary(${type.length})`;
    default:
      return type.kind;
  }
}

/** Whether the database orders values of `type` as {@link compareValues} does. */
export function isOrdered(type: PortableType): boolean {
  return type.kind !== 'json';
}

/**
 * The worst-case width of `type` in a PostgreSQL index entry, in bytes:
 * fixed-width types at their size, variable-width ones with their 4-byte
 * length header, a string at 4 bytes per character. `undefined` when the
 * type cannot be indexed on every dialect (`text`, `json`, unbounded
 * `binary`).
 */
export function indexKeyBytes(type: PortableType): number | undefined {
  switch (type.kind) {
    case 'id':
    case 'bigint':
    case 'float':
    case 'timestamp':
    case 'time':
      return 8;
    case 'integer':
    case 'date':
      return 4;
    case 'boolean':
      return 1;
    case 'uuid':
      return 16;
    case 'decimal':
      // PostgreSQL's numeric: a 4-byte length, a 4-byte header, and 2 bytes
      // per group of 4 digits, one group more when the point splits one.
      return (Math.ceil(type.precision / 4) + 1) * 2 + 8;
    case 'string':
      return type.length * 4 + 4;
    case 'binary':
      return type.length === undefined ? undefined : type.length + 4;
    case 'text':
    case 'json':
      return undefined;
  }
}

/**
 * The worst-case size of an index entry over columns of `types`, in bytes,
 * to compare with {@link MAX_INDEX_KEY_BYTES}: PostgreSQL's 8-byte tuple
 * header, then each column padded to 8-byte alignment. `undefined` when a
 * type cannot be indexed.
 */
export function indexEntryBytes(types: readonly PortableType[]): number | undefined {
  let size = 8;
  for (const type of types) {
    const bytes = indexKeyBytes(type);
    if (bytes === undefined) return undefined;
    size += Math.ceil(bytes / 8) * 8;
  }
  return size;
}

/**
 * The worst-case width of `type` in a MariaDB row, in bytes: inline columns
 * at their full width (a string at 4 bytes per character plus a 2-byte
 * length), `text`, `json` and unbounded `binary` at the 12 bytes their
 * off-page pointer takes.
 */
export function rowBytes(type: PortableType): number {
  switch (type.kind) {
    case 'string':
      return type.length * 4 + 2;
    case 'binary':
      return type.length === undefined ? 12 : type.length + 2;
    case 'text':
    case 'json':
      return 12;
    default:
      return indexKeyBytes(type) ?? 12;
  }
}

/**
 * The longest plaintext `type` can hold, in UTF-8 bytes of its textual form,
 * or `undefined` when it is unbounded. Used to size an encrypted column.
 */
export function plaintextBytes(type: PortableType): number | undefined {
  switch (type.kind) {
    case 'string':
      return type.length * 4;
    case 'integer':
      return 11;
    case 'bigint':
      return 20;
    case 'float':
      return 24;
    case 'decimal':
      return type.precision + 2;
    default:
      return undefined;
  }
}

/** Compare two decimal strings in canonical or plain form, numerically. */
function compareDecimals(a: string, b: string): number {
  const negA = a.startsWith('-');
  const negB = b.startsWith('-');
  const [intA = '', fracA = ''] = (negA ? a.slice(1) : a).split('.');
  const [intB = '', fracB = ''] = (negB ? b.slice(1) : b).split('.');
  const zeroA = /^0*$/.test(intA + fracA);
  const zeroB = /^0*$/.test(intB + fracB);
  const signA = zeroA ? 0 : negA ? -1 : 1;
  const signB = zeroB ? 0 : negB ? -1 : 1;
  if (signA !== signB) return signA < signB ? -1 : 1;
  if (signA === 0) return 0;
  const trimmedA = intA.replace(/^0+/, '');
  const trimmedB = intB.replace(/^0+/, '');
  let magnitude = trimmedA.length - trimmedB.length;
  if (magnitude === 0) {
    const width = Math.max(fracA.length, fracB.length);
    const digitsA = trimmedA + fracA.padEnd(width, '0');
    const digitsB = trimmedB + fracB.padEnd(width, '0');
    magnitude = digitsA < digitsB ? -1 : digitsA > digitsB ? 1 : 0;
  }
  return signA * Math.sign(magnitude);
}

/** Compare strings by Unicode code point, the order of every binary collation. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * The application order of two non-null values of `type`: negative, zero or
 * positive. Strings order by code point (JavaScript's `<` orders by UTF-16
 * unit, which differs only between U+E000..U+FFFF and the astral planes);
 * bytes order lexicographically, a prefix first. `json` has no order and
 * throws.
 */
export function compareValues(type: PortableType, a: unknown, b: unknown): number {
  switch (type.kind) {
    case 'id':
    case 'integer':
    case 'float':
      return Math.sign((a as number) - (b as number));
    case 'bigint':
      return (a as bigint) < (b as bigint) ? -1 : (a as bigint) > (b as bigint) ? 1 : 0;
    case 'decimal':
      return compareDecimals(a as string, b as string);
    case 'boolean':
      return Number(a) - Number(b);
    case 'timestamp':
      return Math.sign((a as Date).getTime() - (b as Date).getTime());
    case 'string':
    case 'text':
    case 'date':
    case 'time':
    case 'uuid':
      return compareCodePoints(a as string, b as string);
    case 'binary':
      return compareBytes(a as Uint8Array, b as Uint8Array);
    case 'json':
      throw new ModelSpecError('invalid_type', { field: 'json' });
  }
}
