/**
 * The check of one settings value against one settings field, shared by the
 * schema reader (a field's `default` must satisfy the field) and by
 * `validateSettings` (a submitted value must).
 *
 * An issue is a path and a code; it never carries the value, a fragment of
 * it, or a key the input supplied, because a settings value may be a secret.
 */

import type { SettingsField } from './schema.js';

/**
 * A value-free settings issue: where (`path`) and what (`code`).
 *
 * @public
 */
export interface SettingsIssue {
  /** The location of the failure, e.g. `["webhookUrl"]` or `["tags", 2]`. */
  readonly path: readonly (string | number)[];
  /** A stable code such as `required`, `invalid_type`, or `too_long`. */
  readonly code: string;
}

/** A field value after its check: the accepted value, or the issues. */
export type FieldCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly SettingsIssue[] };

/** The longest string any field accepts, and the ceiling of `maxLength`. */
export const MAX_SETTINGS_STRING_LENGTH = 65_536;
/** The longest list any field accepts, and the ceiling of `maxItems`. */
export const MAX_SETTINGS_LIST_ITEMS = 1000;
/**
 * A deliberately plain address check (one `@`, no spaces, a dotted domain):
 * deliverability is the mail server's question, and a stricter pattern only
 * rejects valid addresses.
 */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;
const LINE_BREAK = /[\r\n]/;

function fail(path: readonly (string | number)[], code: string): FieldCheck {
  return { ok: false, issues: [Object.freeze({ path: Object.freeze([...path]), code })] };
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
}

/** Check a single-line or multi-line string against length, format, and enum rules. */
function checkString(
  value: unknown,
  rules: {
    readonly maxLength?: number;
    readonly enum?: readonly string[];
    readonly format?: string;
  },
  path: readonly (string | number)[],
): FieldCheck {
  if (typeof value !== 'string') return fail(path, 'invalid_type');
  if (value.length > (rules.maxLength ?? MAX_SETTINGS_STRING_LENGTH)) return fail(path, 'too_long');
  if (rules.enum !== undefined) {
    return rules.enum.includes(value) ? { ok: true, value } : fail(path, 'invalid_enum');
  }
  if (rules.format !== 'textarea' && LINE_BREAK.test(value)) return fail(path, 'invalid_format');
  if (rules.format === 'email' && !EMAIL_PATTERN.test(value)) return fail(path, 'invalid_format');
  if (rules.format === 'uri' && !isHttpUrl(value)) return fail(path, 'invalid_format');
  return { ok: true, value };
}

/** Check `value` against `field`; arrays come back frozen. */
export function checkFieldValue(
  field: SettingsField,
  value: unknown,
  path: readonly (string | number)[],
): FieldCheck {
  switch (field.type) {
    case 'string':
      return checkString(value, field, path);
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : fail(path, 'invalid_type');
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path, 'invalid_type');
      if (field.type === 'integer' && !Number.isSafeInteger(value)) {
        return fail(path, 'not_integer');
      }
      if (field.minimum !== undefined && value < field.minimum) return fail(path, 'too_small');
      if (field.maximum !== undefined && value > field.maximum) return fail(path, 'too_big');
      return { ok: true, value };
    }
    case 'array': {
      if (!Array.isArray(value)) return fail(path, 'invalid_type');
      if (value.length > (field.maxItems ?? MAX_SETTINGS_LIST_ITEMS)) return fail(path, 'too_many');
      if (field.minItems !== undefined && value.length < field.minItems) {
        return fail(path, 'too_few');
      }
      const issues: SettingsIssue[] = [];
      const items: string[] = [];
      for (const [index, item] of value.entries()) {
        const checked = checkString(item, field.items, [...path, index]);
        if (checked.ok) items.push(checked.value as string);
        else issues.push(...checked.issues);
      }
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: Object.freeze(items) };
    }
  }
}
