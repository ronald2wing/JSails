/**
 * The plugin settings schema: a closed subset of JSON Schema a manifest uses
 * to describe the settings an operator may set for a plugin, read as data and
 * never executed.
 *
 * A schema is one object whose properties are string, number, integer,
 * boolean, string-enum, or string-list fields. Strings take the formats
 * `email`, `uri`, `textarea`, and `secret`; every field takes `title`,
 * `description`, and `default`; the object takes `required`; numbers take
 * `minimum`/`maximum`, strings `maxLength`, and lists `minItems`/`maxItems`.
 * Nothing else is accepted: no `pattern` (a regular expression from a manifest
 * is a denial-of-service vector), no `$ref`, no nesting, and an unknown keyword
 * is an issue rather than something silently ignored. A `secret` field takes no
 * default, because a default in a published manifest is a published value.
 *
 * {@link parseSettingsSchema} checks a raw schema and returns the normalized,
 * frozen {@link SettingsSchema} or value-free issues (a path and a code); the
 * values a schema accepts are checked by `validate.ts` and projected for a form
 * by `describe.ts`.
 */

import {
  checkFieldValue,
  MAX_SETTINGS_LIST_ITEMS,
  MAX_SETTINGS_STRING_LENGTH,
  type SettingsIssue,
} from './value-check.js';

/**
 * A string field's format: a single-line `email` or absolute http(s) `uri`, a
 * multi-line `textarea`, or a `secret` a form never echoes back.
 *
 * @public
 */
export type SettingsStringFormat = 'email' | 'uri' | 'textarea' | 'secret';

/**
 * A string field, either free text (with an optional format and `maxLength`)
 * or a choice among `enum` values.
 *
 * @public
 */
export interface StringSettingsField {
  readonly type: 'string';
  readonly title?: string;
  readonly description?: string;
  readonly format?: SettingsStringFormat;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly default?: string;
}

/**
 * A number field; `integer` accepts only safe integers.
 *
 * @public
 */
export interface NumberSettingsField {
  readonly type: 'number' | 'integer';
  readonly title?: string;
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}

/**
 * A boolean field.
 *
 * @public
 */
export interface BooleanSettingsField {
  readonly type: 'boolean';
  readonly title?: string;
  readonly description?: string;
  readonly default?: boolean;
}

/**
 * The items of a string-list field: single-line strings, optionally bounded
 * by `maxLength` or restricted to `enum` values.
 *
 * @public
 */
export interface StringListItems {
  readonly type: 'string';
  readonly maxLength?: number;
  readonly enum?: readonly string[];
}

/**
 * A list-of-strings field.
 *
 * @public
 */
export interface StringListSettingsField {
  readonly type: 'array';
  readonly title?: string;
  readonly description?: string;
  readonly items: StringListItems;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly default?: readonly string[];
}

/**
 * One settings field.
 *
 * @public
 */
export type SettingsField =
  StringSettingsField | NumberSettingsField | BooleanSettingsField | StringListSettingsField;

/**
 * A parsed settings schema: frozen, with `required` normalized to a list.
 *
 * @public
 */
export interface SettingsSchema {
  readonly type: 'object';
  readonly title?: string;
  readonly description?: string;
  readonly properties: Readonly<Record<string, SettingsField>>;
  readonly required: readonly string[];
}

/**
 * The result of {@link parseSettingsSchema}.
 *
 * @public
 */
export type SettingsSchemaParseResult =
  | { readonly ok: true; readonly schema: SettingsSchema }
  | { readonly ok: false; readonly issues: readonly SettingsIssue[] };

/** A settings key: a lowercase start, then letters, digits, or `_`. */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const MAX_FIELDS = 64;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;
const MAX_ENUM_VALUES = 100;
const MAX_ENUM_VALUE_LENGTH = 200;

const STRING_FORMATS: ReadonlySet<string> = new Set(['email', 'uri', 'textarea', 'secret']);
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
]);
const FIELD_KEYWORDS: Readonly<Record<SettingsField['type'], ReadonlySet<string>>> = {
  string: new Set(['type', 'title', 'description', 'format', 'maxLength', 'enum', 'default']),
  number: new Set(['type', 'title', 'description', 'minimum', 'maximum', 'default']),
  integer: new Set(['type', 'title', 'description', 'minimum', 'maximum', 'default']),
  boolean: new Set(['type', 'title', 'description', 'default']),
  array: new Set(['type', 'title', 'description', 'items', 'minItems', 'maxItems', 'default']),
};
const ITEM_KEYWORDS: ReadonlySet<string> = new Set(['type', 'maxLength', 'enum']);

type Path = readonly (string | number)[];

/** Collects issues while a schema is read. */
class IssueList {
  readonly issues: SettingsIssue[] = [];

  add(path: Path, code: string): void {
    this.issues.push(Object.freeze({ path: Object.freeze([...path]), code }));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * A schema is published data, so an unknown keyword that is a short plain
 * identifier (`pattern`, `$ref`) is named in its issue path to say which one
 * to remove; any other key is reported once at its object, so no control
 * character or payload a key carries reaches an issue.
 */
const REPORTABLE_KEYWORD_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

function checkKeywords(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: Path,
  issues: IssueList,
): void {
  let unnamed = false;
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    if (REPORTABLE_KEYWORD_PATTERN.test(key)) issues.add([...path, key], 'unknown_keyword');
    else unnamed = true;
  }
  if (unnamed) issues.add(path, 'unknown_keyword');
}

function readText(
  record: Record<string, unknown>,
  key: string,
  max: number,
  path: Path,
  issues: IssueList,
): string | undefined {
  const value = own(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    issues.add([...path, key], 'invalid_type');
    return undefined;
  }
  if (value.length > max) {
    issues.add([...path, key], 'too_long');
    return undefined;
  }
  return value;
}

function readCount(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  path: Path,
  issues: IssueList,
): number | undefined {
  const value = own(record, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    issues.add([...path, key], 'invalid_bound');
    return undefined;
  }
  return value;
}

function readBound(
  record: Record<string, unknown>,
  key: string,
  integer: boolean,
  path: Path,
  issues: IssueList,
): number | undefined {
  const value = own(record, key);
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value))
  ) {
    issues.add([...path, key], 'invalid_bound');
    return undefined;
  }
  return value;
}

function readEnum(
  record: Record<string, unknown>,
  path: Path,
  issues: IssueList,
): readonly string[] | undefined {
  const value = own(record, 'enum');
  if (value === undefined) return undefined;
  const at = [...path, 'enum'];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENUM_VALUES) {
    issues.add(at, 'invalid_enum');
    return undefined;
  }
  const seen = new Set<string>();
  for (const [index, option] of value.entries()) {
    if (
      typeof option !== 'string' ||
      option === '' ||
      option.length > MAX_ENUM_VALUE_LENGTH ||
      /[\r\n]/.test(option)
    ) {
      issues.add([...at, index], 'invalid_enum');
      return undefined;
    }
    if (seen.has(option)) {
      issues.add([...at, index], 'duplicate_enum');
      return undefined;
    }
    seen.add(option);
  }
  return Object.freeze([...seen]);
}

/** Copy `title`/`description` onto a field, when present. */
function readLabels(
  record: Record<string, unknown>,
  path: Path,
  issues: IssueList,
): { title?: string; description?: string } {
  const title = readText(record, 'title', MAX_TITLE, path, issues);
  const description = readText(record, 'description', MAX_DESCRIPTION, path, issues);
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  };
}

function readStringField(
  record: Record<string, unknown>,
  path: Path,
  issues: IssueList,
): StringSettingsField {
  const rawFormat = own(record, 'format');
  let format: SettingsStringFormat | undefined;
  if (rawFormat !== undefined) {
    if (typeof rawFormat === 'string' && STRING_FORMATS.has(rawFormat)) {
      format = rawFormat as SettingsStringFormat;
    } else {
      issues.add([...path, 'format'], 'invalid_format');
    }
  }
  const maxLength = readCount(record, 'maxLength', 1, MAX_SETTINGS_STRING_LENGTH, path, issues);
  const options = readEnum(record, path, issues);
  if (options !== undefined && (format !== undefined || maxLength !== undefined)) {
    issues.add(path, 'conflicting_keywords');
  }
  return {
    type: 'string',
    ...readLabels(record, path, issues),
    ...(format === undefined ? {} : { format }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(options === undefined ? {} : { enum: options }),
  };
}

function readNumberField(
  record: Record<string, unknown>,
  type: 'number' | 'integer',
  path: Path,
  issues: IssueList,
): NumberSettingsField {
  const integer = type === 'integer';
  const minimum = readBound(record, 'minimum', integer, path, issues);
  const maximum = readBound(record, 'maximum', integer, path, issues);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    issues.add(path, 'invalid_bounds');
  }
  return {
    type,
    ...readLabels(record, path, issues),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

function readListField(
  record: Record<string, unknown>,
  path: Path,
  issues: IssueList,
): StringListSettingsField {
  const rawItems = own(record, 'items');
  let items: StringListItems = { type: 'string' };
  const itemsPath = [...path, 'items'];
  if (!isPlainObject(rawItems) || own(rawItems, 'type') !== 'string') {
    issues.add(itemsPath, 'invalid_items');
  } else {
    checkKeywords(rawItems, ITEM_KEYWORDS, itemsPath, issues);
    const maxLength = readCount(
      rawItems,
      'maxLength',
      1,
      MAX_SETTINGS_STRING_LENGTH,
      itemsPath,
      issues,
    );
    const options = readEnum(rawItems, itemsPath, issues);
    if (options !== undefined && maxLength !== undefined) {
      issues.add(itemsPath, 'conflicting_keywords');
    }
    items = Object.freeze({
      type: 'string',
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(options === undefined ? {} : { enum: options }),
    });
  }
  const minItems = readCount(record, 'minItems', 0, MAX_SETTINGS_LIST_ITEMS, path, issues);
  const maxItems = readCount(record, 'maxItems', 1, MAX_SETTINGS_LIST_ITEMS, path, issues);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    issues.add(path, 'invalid_bounds');
  }
  return {
    type: 'array',
    ...readLabels(record, path, issues),
    items,
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

function readField(raw: unknown, path: Path, issues: IssueList): SettingsField | undefined {
  if (!isPlainObject(raw)) {
    issues.add(path, 'invalid_type');
    return undefined;
  }
  const type = own(raw, 'type');
  if (typeof type !== 'string' || !Object.hasOwn(FIELD_KEYWORDS, type)) {
    issues.add([...path, 'type'], 'invalid_field_type');
    return undefined;
  }
  const fieldType = type as SettingsField['type'];
  checkKeywords(raw, FIELD_KEYWORDS[fieldType], path, issues);
  const before = issues.issues.length;
  const field: SettingsField =
    fieldType === 'string'
      ? readStringField(raw, path, issues)
      : fieldType === 'number' || fieldType === 'integer'
        ? readNumberField(raw, fieldType, path, issues)
        : fieldType === 'boolean'
          ? { type: 'boolean', ...readLabels(raw, path, issues) }
          : readListField(raw, path, issues);
  if (!Object.hasOwn(raw, 'default')) return Object.freeze(field);
  if (field.type === 'string' && field.format === 'secret') {
    issues.add([...path, 'default'], 'secret_default');
    return undefined;
  }
  // A default is checked against the field it belongs to, so a field whose own
  // keywords are broken cannot vouch for one.
  if (issues.issues.length > before) return undefined;
  const checked = checkFieldValue(field, raw['default'], []);
  if (!checked.ok) {
    issues.add([...path, 'default'], 'invalid_default');
    return undefined;
  }
  return Object.freeze({ ...field, default: checked.value } as SettingsField);
}

/**
 * Check a raw settings schema. Returns the normalized, frozen schema, or every
 * issue found as a path and a code; no issue carries a value from the input.
 *
 * @public
 */
export function parseSettingsSchema(raw: unknown): SettingsSchemaParseResult {
  const issues = new IssueList();
  if (!isPlainObject(raw)) {
    issues.add([], 'invalid_type');
    return { ok: false, issues: Object.freeze(issues.issues) };
  }
  checkKeywords(raw, SCHEMA_KEYWORDS, [], issues);
  if (own(raw, 'type') !== 'object') issues.add(['type'], 'invalid_type');
  const labels = readLabels(raw, [], issues);

  const rawProperties = own(raw, 'properties');
  const properties: Record<string, SettingsField> = {};
  if (!isPlainObject(rawProperties)) {
    issues.add(['properties'], 'invalid_type');
  } else {
    const keys = Object.keys(rawProperties);
    if (keys.length > MAX_FIELDS) issues.add(['properties'], 'too_many_fields');
    for (const key of keys.slice(0, MAX_FIELDS)) {
      if (!KEY_PATTERN.test(key)) {
        // The key itself is input that failed its pattern, so it stays out of the path.
        issues.add(['properties'], 'invalid_key');
        continue;
      }
      const field = readField(rawProperties[key], ['properties', key], issues);
      if (field !== undefined) properties[key] = field;
    }
  }

  const rawRequired = own(raw, 'required');
  const required: string[] = [];
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired)) {
      issues.add(['required'], 'invalid_type');
    } else {
      for (const [index, key] of rawRequired.entries()) {
        if (
          typeof key !== 'string' ||
          !isPlainObject(rawProperties) ||
          !Object.hasOwn(rawProperties, key)
        ) {
          issues.add(['required', index], 'unknown_required');
        } else if (required.includes(key)) {
          issues.add(['required', index], 'duplicate_required');
        } else {
          required.push(key);
        }
      }
    }
  }

  if (issues.issues.length > 0) return { ok: false, issues: Object.freeze(issues.issues) };
  return {
    ok: true,
    schema: Object.freeze({
      type: 'object',
      ...labels,
      properties: Object.freeze(properties),
      required: Object.freeze(required),
    }),
  };
}
