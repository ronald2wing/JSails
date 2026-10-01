/**
 * Canonical Zod-issue mapper: a single, value-free {@link mapZodIssues} shared
 * by every module that translates Zod validation failures into structured
 * field errors.
 *
 * Never exported from the root `jsails` entry or from `jsails/extensions`;
 * plugins reach it through `jsails/plugin-sdk`.
 */

import type { z } from 'zod';

/** A single value-free field error mapped from a Zod issue. */
export interface ZodIssueEntry {
  /** Structured path to the failing field, e.g. `["user", "name"]` or `["tags", 0]`. Empty for a root failure. */
  readonly path: readonly (string | number)[];
  /** Stable issue code: a Zod code such as `"invalid_type"` or `"too_small"`, or `"unknown_field"` for an unrecognized key. */
  readonly code: string;
  /** Short, value-free description derived only from the schema, never from input values. */
  readonly message: string;
}

/**
 * Translate Zod validation failures into a flat array of value-free
 * `ZodIssueEntry` objects. Accepts either a `ZodError` or its `issues` array.
 *
 * Every message is derived from the schema (expected type, bounds, format)
 * and never echoes input values. Zod's `unrecognized_keys` issue is expanded
 * into one `unknown_field` entry per key, with the key name appended to the
 * path so the message itself stays value-free. Render a path for display with
 * {@link formatIssuePath}.
 */
export function mapZodIssues(input: z.ZodError | readonly z.ZodIssue[]): ZodIssueEntry[] {
  // Normalize: a ZodError carries its issues under `.issues`; an array is
  // already the issue list. We check structurally so only a type import is
  // needed — no runtime Zod dependency.
  const issues = Array.isArray(input) ? input : (input as z.ZodError).issues;
  return issues.flatMap(mapIssue);
}

/**
 * Join a structured issue path into a dotted string for display, e.g.
 * `["user", "tags", 2]` becomes `"user.tags.2"`; an empty (root) path renders
 * as `rootLabel`.
 */
export function formatIssuePath(path: readonly (string | number)[], rootLabel = '_root'): string {
  return path.length === 0 ? rootLabel : path.join('.');
}

function mapIssue(issue: z.ZodIssue): ZodIssueEntry[] {
  const path = issuePath(issue.path);
  // The key is input-provided, so it appears only in the path, never in the
  // message.
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({
      path: [...path, key],
      code: 'unknown_field',
      message: 'unknown field',
    }));
  }
  return [{ path, code: issue.code, message: describeIssue(issue) }];
}

/**
 * Zod types issue paths as `PropertyKey[]`, but a parsed object or array only
 * ever yields string and number segments; a symbol key cannot come from JSON
 * or a config literal, so it is dropped rather than widened into the public
 * entry type.
 */
function issuePath(path: readonly PropertyKey[]): readonly (string | number)[] {
  return path.filter((segment): segment is string | number => typeof segment !== 'symbol');
}

/**
 * Produce a value-free message for a Zod issue. Only schema-derived facts
 * (bounds, expected types) are emitted; the raw input and the `received` field
 * Zod attaches to issues are never echoed.
 */
function describeIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${typeName(issue.expected)}`;
    case 'too_small':
      return `must be at least ${issue.minimum}`;
    case 'too_big':
      return `must be at most ${issue.maximum}`;
    case 'invalid_format':
      return 'invalid format';
    case 'invalid_value':
      return 'invalid value';
    // Zod emits 'custom' for .refine() / .superRefine() failures. Map it to
    // the same stable message so callers don't need their own custom-code switch.
    case 'custom':
      return 'invalid value';
    default:
      // For any other Zod issue code, use the code itself as a stable,
      // value-free message rather than echoing Zod's `issue.message` (which
      // may contain user-supplied text from `.describe()` or custom errors).
      return issue.code;
  }
}

function typeName(expected: string): string {
  switch (expected) {
    case 'string':
      return 'a string';
    case 'number':
    case 'int':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
    case 'record':
      return 'an object';
    case 'array':
    case 'tuple':
      return 'an array';
    default:
      return 'a valid value';
  }
}
