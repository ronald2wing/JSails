import { SupportError } from './errors.js';
import { isBlank } from './strings.js';

import {
  compact as esCompact,
  flatten as esFlatten,
  flattenDeep as esFlattenDeep,
  keyBy as esKeyBy,
  omit as esOmit,
  pick as esPick,
  range as esRange,
  sortBy as esSortBy,
  uniq as esUniq,
  uniqBy as esUniqBy,
} from 'es-toolkit';
import { get as esGet, has as esHas, set as esSet } from 'es-toolkit/compat';
import { defaults } from '../internal/defaults.js';
import { deepEqual } from '../internal/deep-equal.js';
import { FORBIDDEN_KEYS, isPlainObject } from '../internal/json-safe.js';

// ---------------------------------------------------------------------------
// ArrError
// ---------------------------------------------------------------------------

export class ArrError extends SupportError {
  readonly code = 'invalid_argument';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// ---------------------------------------------------------------------------
// groupBy
// ---------------------------------------------------------------------------

export function groupBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  if (!Array.isArray(items)) throw new ArrError('groupBy expects an array argument');
  // Node 26 always provides Object.groupBy. The cast keeps the call working with
  // the compiler's ES2023-era lib declarations while preserving native behavior.
  const nativeGroupBy = (
    Object as unknown as {
      groupBy<T, K extends PropertyKey>(
        values: Iterable<T>,
        selector: (value: T, index: number) => K,
      ): Partial<Record<K, T[]>>;
    }
  ).groupBy;
  return nativeGroupBy(items, keyFn) as Record<K, T[]>;
}

// ---------------------------------------------------------------------------
// keyBy
// ---------------------------------------------------------------------------

export function keyBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<K, T> {
  if (!Array.isArray(items)) throw new ArrError('keyBy expects an array argument');
  return esKeyBy(items, keyFn);
}

// ---------------------------------------------------------------------------
// pluck — hand-rolled (not in es-toolkit)
// ---------------------------------------------------------------------------

export function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  if (!Array.isArray(items)) throw new ArrError('pluck expects an array argument');
  return items.map((item) => item[key]);
}

// ---------------------------------------------------------------------------
// unique / uniqueBy — aliases for es-toolkit uniq / uniqBy
// ---------------------------------------------------------------------------

export function unique<T>(items: readonly T[]): T[] {
  if (!Array.isArray(items)) throw new ArrError('unique expects an array argument');
  return esUniq(items);
}

export function uniqueBy<T, K>(items: readonly T[], predicate: (item: T) => K): T[] {
  if (!Array.isArray(items)) throw new ArrError('uniqueBy expects an array argument');
  return esUniqBy(items, predicate);
}

// ---------------------------------------------------------------------------
// flatten / flattenDeep / compact
// ---------------------------------------------------------------------------

export function flatten<T>(array: readonly (T | readonly T[])[]): T[] {
  if (!Array.isArray(array)) throw new ArrError('flatten expects an array argument');
  return esFlatten(array as T[]) as T[];
}

export function flattenDeep<T>(array: readonly unknown[]): T[] {
  if (!Array.isArray(array)) throw new ArrError('flattenDeep expects an array argument');
  return esFlattenDeep(array) as T[];
}

export function compact<T>(items: readonly (T | null | undefined | false | 0 | '')[]): T[] {
  if (!Array.isArray(items)) throw new ArrError('compact expects an array argument');
  return esCompact(items);
}

// ---------------------------------------------------------------------------
// pick / omit
// ---------------------------------------------------------------------------

export function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  if (obj === null || typeof obj !== 'object')
    throw new ArrError('pick expects an object argument');
  return esPick(obj, keys);
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  if (obj === null || typeof obj !== 'object')
    throw new ArrError('omit expects an object argument');
  return esOmit(obj, keys);
}

// ---------------------------------------------------------------------------
// get / set / has (from es-toolkit/compat)
// ---------------------------------------------------------------------------

export function get<T = unknown>(obj: unknown, path: string, fallback?: T): T {
  return esGet(obj, path, fallback) as unknown as T;
}

export function set<T extends object>(obj: T, path: string, value: unknown): T {
  return esSet(obj, path, value);
}

export function has(obj: unknown, path: string): boolean {
  return esHas(obj, path);
}

// ---------------------------------------------------------------------------
// sortBy
// ---------------------------------------------------------------------------

export function sortBy<T>(
  items: readonly T[],
  ...criteria: (((item: T) => unknown) | string)[]
): T[] {
  if (!Array.isArray(items)) throw new ArrError('sortBy expects an array argument');
  return esSortBy(items, criteria) as T[];
}

// ---------------------------------------------------------------------------
// compareStrings
// ---------------------------------------------------------------------------

/**
 * Deterministic code-unit comparator for `Array.prototype.sort`.
 *
 * `localeCompare` is locale-dependent, so the same input can order differently
 * on two machines; generated artifacts must be byte-stable across environments.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// range
// ---------------------------------------------------------------------------

export function range(start: number, end?: number, step?: number): number[] {
  if (end === undefined) return esRange(start);
  if (step === undefined) return esRange(start, end);
  return esRange(start, end, step);
}

// ---------------------------------------------------------------------------
// chunk — hand-rolled
// ---------------------------------------------------------------------------

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Array.isArray(items)) throw new ArrError('chunk expects an array argument');
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1)
    throw new ArrError('chunk expects a positive integer size');
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// ---------------------------------------------------------------------------
// merge — defaults
// ---------------------------------------------------------------------------

export function merge<T extends object>(...sources: readonly (Partial<T> | undefined)[]): T {
  return defaults<T>({}, ...sources);
}

// ---------------------------------------------------------------------------
// clone / cloneDeep — native structuredClone
// ---------------------------------------------------------------------------

export function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'DataCloneError') {
      throw new ArrError('clone: value cannot be cloned');
    }
    throw e;
  }
}

export const cloneDeep = clone;

// ---------------------------------------------------------------------------
// equals — deepEqual
// ---------------------------------------------------------------------------

export function equals(a: unknown, b: unknown): boolean {
  return deepEqual(a, b);
}

// ---------------------------------------------------------------------------
// toSentence — native Intl.ListFormat
// ---------------------------------------------------------------------------

export function toSentence(
  items: readonly string[],
  options?: Intl.ListFormatOptions,
  locale?: string,
): string {
  if (!Array.isArray(items)) throw new ArrError('toSentence expects an array argument');
  return new Intl.ListFormat(locale, options).format(items);
}

// ---------------------------------------------------------------------------
// Own: array and record helpers
// ---------------------------------------------------------------------------

type PlainObject = Record<string, unknown>;

/**
 * Recursive partial used by {@link deepMerge} for nested overlay objects.
 *
 * Arrays are replaced wholesale, and nested objects may carry new keys — the
 * same shape `deepMerge` produces at runtime.
 */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> } & Record<string, unknown>
    : T;

function defineOwn(target: PlainObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Normalize a value to an array: `null`/`undefined` become `[]`, a scalar becomes `[value]`. */
export function wrap<T>(value: T | readonly T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [...(value as readonly T[])];
  return [value as T];
}

/**
 * Deep-merge plain objects. An `overlay` value wins over `base`, plain objects
 * merge recursively, and arrays (like every other non-plain value) are
 * replaced rather than concatenated.
 */
export function deepMerge<T extends object>(
  base: T,
  ...overlays: readonly (DeepPartial<T> | undefined)[]
): T {
  const result: PlainObject = { ...base } as PlainObject;

  for (const overlay of overlays) {
    if (overlay === undefined) continue;
    for (const [key, value] of Object.entries(overlay)) {
      if (FORBIDDEN_KEYS.has(key) || value === undefined) continue;
      const existing = result[key];
      defineOwn(
        result,
        key,
        isPlainObject(existing) && isPlainObject(value) ? mergeObjects(existing, value) : value,
      );
    }
  }

  return result as T;
}

function mergeObjects(base: PlainObject, overlay: PlainObject): PlainObject {
  const result: PlainObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (FORBIDDEN_KEYS.has(key) || value === undefined) continue;
    const existing = result[key];
    defineOwn(
      result,
      key,
      isPlainObject(existing) && isPlainObject(value) ? mergeObjects(existing, value) : value,
    );
  }
  return result;
}

/** True for `null`, `undefined`, empty strings/arrays/maps/sets, and plain objects with no keys. */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** First element, or `undefined` when the array is empty. */
export function first<T>(items: readonly T[]): T | undefined {
  return items[0];
}

/** Last element, or `undefined` when the array is empty. */
export function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

/** Drop `null`, `undefined`, and whitespace-only strings; keep `0` and `false`. */
export function compactBlank<T>(items: readonly T[]): T[] {
  return items.filter((item) => !isBlank(item));
}

/** Map the keys of a record, keeping its values. A later duplicate key wins. */
export function transformKeys<V>(
  record: Record<string, V>,
  transform: (key: string, value: V) => string,
): Record<string, V> {
  const result: PlainObject = {};
  for (const [key, value] of Object.entries(record)) {
    const nextKey = transform(key, value);
    if (FORBIDDEN_KEYS.has(nextKey)) continue;
    defineOwn(result, nextKey, value);
  }
  return result as Record<string, V>;
}

/** Map the values of a record, keeping its keys. */
export function transformValues<V, U>(
  record: Record<string, V>,
  transform: (value: V, key: string) => U,
): Record<string, U> {
  const result: PlainObject = {};
  for (const [key, value] of Object.entries(record)) {
    defineOwn(result, key, transform(value, key));
  }
  return result as Record<string, U>;
}

/** Shallow-merge `overlay` underneath `base`, so existing `base` keys win. */
export function reverseMerge<T extends object, O extends object>(
  base: T,
  overlay: O | undefined,
): T & O {
  return Object.assign({}, overlay, base);
}

/**
 * Split an array into at most `groups` contiguous groups of near-equal size.
 *
 * When there are fewer items than groups, the remaining groups are empty.
 */
export function inGroups<T>(items: readonly T[], groups: number): T[][] {
  if (!Array.isArray(items)) throw new ArrError('inGroups expects an array argument');
  if (typeof groups !== 'number' || !Number.isInteger(groups) || groups < 1) {
    throw new ArrError('inGroups expects a positive integer group count');
  }

  const size = Math.ceil(items.length / groups);
  const result: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  while (result.length < groups) result.push([]);

  return result;
}

/** Split an array into `[matching, non-matching]` by a predicate. */
export function partition<T>(
  items: readonly T[],
  predicate: (item: T, index: number) => boolean,
): [T[], T[]] {
  if (!Array.isArray(items)) throw new ArrError('partition expects an array argument');
  if (typeof predicate !== 'function') throw new ArrError('partition expects a predicate function');

  const matching: T[] = [];
  const rest: T[] = [];

  items.forEach((item, index) => {
    (predicate(item, index) ? matching : rest).push(item);
  });

  return [matching, rest];
}

// ---------------------------------------------------------------------------
// Arr frozen namespace
// ---------------------------------------------------------------------------

export const Arr = Object.freeze({
  chunk,
  clone,
  cloneDeep,
  compact,
  compactBlank,
  compareStrings,
  deepMerge,
  equals,
  first,
  flatten,
  flattenDeep,
  get,
  groupBy,
  has,
  inGroups,
  isEmpty,
  keyBy,
  last,
  merge,
  omit,
  partition,
  pick,
  pluck,
  range,
  reverseMerge,
  set,
  sortBy,
  toSentence,
  transformKeys,
  transformValues,
  unique,
  uniqueBy,
  wrap,
});
