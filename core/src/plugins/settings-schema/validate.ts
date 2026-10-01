/**
 * `validateSettings`: check a settings value (what an operator saved, or what
 * a form submitted) against a parsed {@link SettingsSchema}.
 *
 * The value must be a plain object with no key the schema does not define.
 * A missing field takes its `default`; a missing required field with no
 * default is a `required` issue. The accepted value is a new frozen object
 * holding only schema keys, so nothing the input carried beyond the schema
 * survives. Issues are value-free: a path of schema keys and list indexes, and
 * a code. A key the schema does not define is reported once at the root, not
 * by name, because the name is input too.
 */

import type { SettingsSchema } from './schema.js';
import { checkFieldValue, type SettingsIssue } from './value-check.js';

/**
 * The result of {@link validateSettings}.
 *
 * @public
 */
export type SettingsValidationResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly issues: readonly SettingsIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Validate `value` against `schema`, filling defaults. Returns the accepted
 * frozen value, or every issue as a path and a code.
 *
 * @public
 */
export function validateSettings(schema: SettingsSchema, value: unknown): SettingsValidationResult {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      issues: [Object.freeze({ path: Object.freeze([]), code: 'invalid_type' })],
    };
  }
  const issues: SettingsIssue[] = [];
  if (Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) {
    issues.push(Object.freeze({ path: Object.freeze([]), code: 'unknown_key' }));
  }
  const required = new Set(schema.required);
  const accepted: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties)) {
    const present = Object.hasOwn(value, key) && value[key] !== undefined;
    if (!present) {
      if (field.default !== undefined) {
        accepted[key] = field.default;
      } else if (required.has(key)) {
        issues.push(Object.freeze({ path: Object.freeze([key]), code: 'required' }));
      }
      continue;
    }
    const checked = checkFieldValue(field, value[key], [key]);
    if (checked.ok) accepted[key] = checked.value;
    else issues.push(...checked.issues);
  }
  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return { ok: true, value: Object.freeze(accepted) };
}
