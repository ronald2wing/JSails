/**
 * The one JSON value scanner shared by both ends of the component wire: the
 * snapshot signer and verifier, the update protocol parser, the browser
 * controller, and the browser's unverified snapshot decoder all judge a value
 * with {@link scanJson}, so a value one side accepts the other side accepts too.
 *
 * Browser-safe: it imports only the dependency-free JSON shape guards.
 */

import { isForbiddenKey, isPlainObject } from '../json/shape.js';

/** Maximum JSON nesting depth accepted anywhere on the component wire. */
export const MAX_JSON_DEPTH = 64;

/** The first reason a value is not portable, safe JSON. */
export type JsonViolation =
  'depth' | 'non-finite' | 'non-plain' | 'forbidden-key' | 'non-json' | 'circular';

type ScanFrame =
  | { readonly kind: 'enter'; readonly value: unknown; readonly depth: number }
  | { readonly kind: 'exit'; readonly value: object };

/**
 * Scan an arbitrary value for the first portability/safety violation: excessive
 * nesting, non-finite numbers, non-plain objects, dangerous own keys, cycles, or
 * values that are not JSON at all. Iterative (explicit stack) so a deeply nested
 * value cannot overflow the call stack; cycle detection uses an ancestor set so
 * shared-but-acyclic references are still accepted. Returns `null` when the
 * value is safe.
 */
export function scanJson(root: unknown): JsonViolation | null {
  const stack: ScanFrame[] = [{ kind: 'enter', value: root, depth: 0 }];
  const ancestors = new Set<object>();

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }

    const { value, depth } = frame;
    if (depth > MAX_JSON_DEPTH) {
      return 'depth';
    }
    if (value === null) {
      continue;
    }

    const type = typeof value;
    if (type === 'string' || type === 'boolean') {
      continue;
    }
    if (type === 'number') {
      if (!Number.isFinite(value)) {
        return 'non-finite';
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        return 'circular';
      }
      ancestors.add(value);
      stack.push({ kind: 'exit', value });
      for (const item of value) {
        stack.push({ kind: 'enter', value: item, depth: depth + 1 });
      }
      continue;
    }
    if (type === 'object') {
      if (!isPlainObject(value)) {
        return 'non-plain';
      }
      if (ancestors.has(value)) {
        return 'circular';
      }
      ancestors.add(value);
      stack.push({ kind: 'exit', value });
      const record = value;
      for (const key of Object.keys(record)) {
        if (isForbiddenKey(key)) {
          return 'forbidden-key';
        }
        stack.push({ kind: 'enter', value: record[key], depth: depth + 1 });
      }
      continue;
    }
    return 'non-json';
  }

  return null;
}

/** A value-free description of a violation, naming the rule and never the value. */
export function jsonViolationMessage(violation: JsonViolation): string {
  switch (violation) {
    case 'depth':
      return 'value exceeds the maximum nesting depth';
    case 'non-finite':
      return 'value contains a non-finite number';
    case 'non-plain':
      return 'value must contain only plain JSON objects';
    case 'forbidden-key':
      return 'value contains a forbidden key';
    case 'circular':
      return 'value must not contain circular references';
    case 'non-json':
      return 'value must contain only JSON values';
  }
}

/**
 * Serialize a scanned JSON value with every object's keys sorted, so two
 * structurally equal values serialize to the same string whatever order their
 * keys were inserted in. The input must already pass {@link scanJson}.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
