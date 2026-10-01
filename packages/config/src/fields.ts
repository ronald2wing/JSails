/**
 * The field vocabulary a config set is declared with. Each field carries what
 * every surface needs from one declaration: its default, a check that both
 * validates and normalizes a stored, imported, or overridden value, and a
 * parser for the admin form. The kinds are the ones a settings form can render
 * faithfully; anything richer is a `json` field with a `schema`.
 *
 * Checks are value-free: a failure says which rule broke, never the value.
 */

import { ValidationError, type Schema } from 'jsails/api';
import { isForbiddenKey, type JsonValue } from 'jsails/plugin-sdk';

import { ConfigError } from './config-error.js';

/** The kinds of field a config set can declare. */
export type ConfigFieldKind = 'text' | 'integer' | 'boolean' | 'choice' | 'json';

/** One declared config field. */
export interface ConfigField<T = unknown> {
  readonly kind: ConfigFieldKind;
  /** The form label; the key when absent. */
  readonly label?: string;
  /** The value when nothing is stored, imported, or overridden. */
  readonly default: T;
  /** `text`: whether an empty string is refused. */
  readonly required?: boolean;
  /** `text`: whether the form uses a textarea. */
  readonly multiline?: boolean;
  /** `text`: maximum length; `integer`: maximum value. */
  readonly max?: number;
  /** `integer`: minimum value. */
  readonly min?: number;
  /** `choice`: the allowed values, in display order. */
  readonly options?: readonly string[];
  /** Validate and normalize a value; throws `invalid_value` without echoing it. */
  check(value: unknown): T;
  /** Parse a submitted form value; throws `invalid_value` without echoing it. */
  fromForm(raw: string | undefined): T;
  /** The value as a form control shows it. */
  toForm(value: T): string;
}

const DEFAULT_TEXT_MAX = 1000;

function invalid(rule: string): ConfigError {
  return new ConfigError('invalid_value', rule);
}

function declarationError(rule: string): ConfigError {
  return new ConfigError('invalid_field', rule);
}

function freezeField<T>(field: ConfigField<T>): ConfigField<T> {
  field.check(field.default);
  return Object.freeze(field);
}

/** Options for {@link text}. */
export interface TextFieldOptions {
  readonly label?: string;
  readonly default?: string;
  readonly required?: boolean;
  readonly multiline?: boolean;
  /** Maximum length; defaults to 1000. */
  readonly max?: number;
}

/** A string field. An empty string is allowed unless `required`. */
export function text(options: TextFieldOptions = {}): ConfigField<string> {
  const max = options.max ?? DEFAULT_TEXT_MAX;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw declarationError('a text field max must be a positive integer');
  }
  const required = options.required === true;
  const check = (value: unknown): string => {
    if (typeof value !== 'string') throw invalid('must be a string');
    if (required && value.trim() === '') throw invalid('must not be empty');
    if (value.length > max) throw invalid('is longer than the field allows');
    return value;
  };
  return freezeField({
    kind: 'text',
    ...(options.label === undefined ? {} : { label: options.label }),
    default: options.default ?? '',
    required,
    multiline: options.multiline === true,
    max,
    check,
    fromForm: (raw) => check((raw ?? '').trim()),
    toForm: (value) => value,
  });
}

/** Options for {@link integer}. */
export interface IntegerFieldOptions {
  readonly label?: string;
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
}

/** A whole-number field, optionally bounded. */
export function integer(options: IntegerFieldOptions): ConfigField<number> {
  const { min, max } = options;
  if (
    (min !== undefined && !Number.isSafeInteger(min)) ||
    (max !== undefined && !Number.isSafeInteger(max)) ||
    (min !== undefined && max !== undefined && min > max)
  ) {
    throw declarationError('integer field bounds must be safe integers with min <= max');
  }
  const check = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw invalid('must be a whole number');
    }
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      throw invalid('is outside the allowed range');
    }
    return value;
  };
  return freezeField({
    kind: 'integer',
    ...(options.label === undefined ? {} : { label: options.label }),
    default: options.default,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    check,
    fromForm: (raw) => {
      const trimmed = (raw ?? '').trim();
      return check(/^-?[0-9]{1,16}$/.test(trimmed) ? Number(trimmed) : Number.NaN);
    },
    toForm: (value) => String(value),
  });
}

/** Options for {@link boolean}. */
export interface BooleanFieldOptions {
  readonly label?: string;
  readonly default?: boolean;
}

/** An on/off field. A form submits it as a checkbox: absent means off. */
export function boolean(options: BooleanFieldOptions = {}): ConfigField<boolean> {
  const check = (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw invalid('must be true or false');
    return value;
  };
  return freezeField({
    kind: 'boolean',
    ...(options.label === undefined ? {} : { label: options.label }),
    default: options.default ?? false,
    check,
    fromForm: (raw) => raw === 'on' || raw === 'true',
    toForm: (value) => (value ? 'true' : 'false'),
  });
}

/** Options for {@link choice}. */
export interface ChoiceFieldOptions<O extends string> {
  readonly label?: string;
  readonly options: readonly O[];
  readonly default: NoInfer<O>;
}

/** One value from a fixed list. */
export function choice<const O extends string>(options: ChoiceFieldOptions<O>): ConfigField<O> {
  const allowed = options.options;
  if (
    !Array.isArray(allowed) ||
    allowed.length === 0 ||
    !allowed.every((option) => typeof option === 'string') ||
    new Set(allowed).size !== allowed.length
  ) {
    throw declarationError('a choice field needs a non-empty list of distinct strings');
  }
  const check = (value: unknown): O => {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      throw invalid('is not one of the allowed options');
    }
    return value as O;
  };
  return freezeField({
    kind: 'choice',
    ...(options.label === undefined ? {} : { label: options.label }),
    default: options.default,
    options: Object.freeze([...allowed]),
    check,
    fromForm: (raw) => check(raw),
    toForm: (value) => value,
  });
}

/** Options for {@link json}. */
export interface JsonFieldOptions<T> {
  readonly label?: string;
  readonly default: T;
  /**
   * Validates the parsed value. Without it or `validate`, any JSON value is
   * accepted, so give one whenever the shape matters.
   */
  readonly schema?: Schema<T>;
  /** A predicate for shapes a schema cannot state, such as a map of strings. */
  readonly validate?: (value: JsonValue) => boolean;
}

/** Any JSON value, edited as JSON text and validated by an optional schema. */
export function json<T = JsonValue>(options: JsonFieldOptions<T>): ConfigField<T> {
  const { schema, validate } = options;
  if (validate !== undefined && typeof validate !== 'function') {
    throw declarationError('a json field validate option must be a function');
  }
  const check = (value: unknown): T => {
    if (!isJsonValue(value)) throw invalid('must be a JSON value');
    if (validate !== undefined && !validate(value)) throw invalid('does not have the field shape');
    if (schema === undefined) return value as T;
    try {
      return schema.validate(value);
    } catch (error) {
      if (error instanceof ValidationError) throw invalid('does not match the field schema');
      throw error;
    }
  };
  return freezeField({
    kind: 'json',
    ...(options.label === undefined ? {} : { label: options.label }),
    default: options.default,
    check,
    fromForm: (raw) => {
      const trimmed = (raw ?? '').trim();
      if (trimmed === '') return check(options.default);
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw invalid('must be valid JSON');
      }
      return check(parsed);
    },
    toForm: (value) => JSON.stringify(value, null, 2),
  });
}

/**
 * True for a plain JSON value: no functions, no non-finite numbers, no class
 * instances, and no prototype keys such as `__proto__`.
 */
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(
    ([key, item]) => !isForbiddenKey(key) && isJsonValue(item, depth + 1),
  );
}
