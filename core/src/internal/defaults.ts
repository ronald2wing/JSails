/**
 * Defaults merge: earlier sources win, later sources fill gaps.
 *
 * Earlier sources win; later sources only fill missing keys. Plain objects merge
 * recursively, arrays and every other value are assigned as-is. Prototype-
 * polluting keys are ignored.
 */

import { FORBIDDEN_KEYS, isPlainObject } from './json-safe.js';

type PlainObject = Record<string, unknown>;

function copyPlain(value: PlainObject): PlainObject {
  const copy: PlainObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    copy[key] = isPlainObject(entry) ? copyPlain(entry) : entry;
  }
  return copy;
}

function assignDefault(target: PlainObject, source: PlainObject): void {
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;

    const existing = target[key];
    if (existing === undefined) {
      Object.defineProperty(target, key, {
        value: isPlainObject(value) ? copyPlain(value) : value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      continue;
    }

    if (isPlainObject(existing) && isPlainObject(value)) {
      assignDefault(existing, value);
    }
  }
}

/** Merge sources so earlier values win and later values fill gaps. */
export function defaults<T extends object>(...sources: readonly (Partial<T> | undefined)[]): T {
  const result: PlainObject = {};

  for (const source of sources) {
    if (source !== undefined) assignDefault(result, source);
  }

  return result as T;
}
