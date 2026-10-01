/**
 * `defineConfig`: a named group of config fields, the unit that is stored,
 * edited on one admin form, and exported as one sync file.
 *
 * A set's name doubles as its sync file name (`<name>.json`), so it is limited
 * to lowercase words joined by `.`, `_`, or `-`. Resolving a set's values is
 * forgiving about what is stored (an unknown or no-longer-valid stored key
 * falls back to the default, so a schema change never breaks a running app)
 * and strict about what is written (every written value passes its check).
 */

import type { JsonValue } from 'jsails/plugin-sdk';

import { ConfigError } from './config-error.js';
import type { ConfigField } from './fields.js';

/** The fields of a config set, keyed by name. */
export type ConfigFields = Readonly<Record<string, ConfigField>>;

/** The values a config set resolves to. */
export type ConfigValues<F extends ConfigFields> = {
  readonly [K in keyof F]: F[K] extends ConfigField<infer T> ? T : never;
};

/** A defined config set: frozen plain data. */
export interface ConfigSet<F extends ConfigFields = ConfigFields> {
  readonly name: string;
  /** The heading on the admin form; the name when absent. */
  readonly label?: string;
  readonly fields: F;
}

/** Options for {@link defineConfig}. */
export interface ConfigSetOptions<F extends ConfigFields> {
  readonly label?: string;
  readonly fields: F;
}

const SET_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_SET_NAME = 120;

/** Define a config set. Fails at startup on a malformed name or field. */
export function defineConfig<const F extends ConfigFields>(
  name: string,
  options: ConfigSetOptions<F>,
): ConfigSet<F> {
  if (typeof name !== 'string' || name.length > MAX_SET_NAME || !SET_NAME.test(name)) {
    throw new ConfigError(
      'invalid_set',
      'a config set name is lowercase words joined by ".", "_", or "-"',
    );
  }
  if (options === null || typeof options !== 'object' || options.fields === null) {
    throw new ConfigError('invalid_set', 'a config set needs fields', name);
  }
  const entries = Object.entries(options.fields);
  if (entries.length === 0) {
    throw new ConfigError('invalid_set', 'a config set needs at least one field', name);
  }
  for (const [key, field] of entries) {
    if (!FIELD_KEY.test(key)) {
      throw new ConfigError(
        'invalid_field',
        'a field key is a letter then letters, digits, or _',
        name,
      );
    }
    if (field === null || typeof field !== 'object' || typeof field.check !== 'function') {
      throw new ConfigError('invalid_field', 'a field must come from the field helpers', name, key);
    }
  }
  return Object.freeze({
    name,
    ...(options.label === undefined ? {} : { label: options.label }),
    fields: Object.freeze({ ...options.fields }),
  });
}

/** Every field at its default. */
export function defaultValues<F extends ConfigFields>(set: ConfigSet<F>): ConfigValues<F> {
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(set.fields)) values[key] = field.default;
  return values as ConfigValues<F>;
}

/**
 * Resolve stored values over the defaults. A stored key the set no longer
 * declares is ignored, and one that no longer passes its check falls back to
 * the default.
 */
export function resolveStored<F extends ConfigFields>(
  set: ConfigSet<F>,
  stored: Readonly<Record<string, JsonValue>> | undefined,
): ConfigValues<F> {
  const values: Record<string, unknown> = { ...defaultValues(set) };
  if (stored === undefined) return values as ConfigValues<F>;
  for (const [key, field] of Object.entries(set.fields)) {
    if (!Object.hasOwn(stored, key)) continue;
    try {
      values[key] = field.check(stored[key]);
    } catch {
      // Stale value from an older declaration: the default applies.
    }
  }
  return values as ConfigValues<F>;
}

/**
 * Check values written to a set: every key must be declared and every value
 * must pass its field's check. Returns the normalized values.
 */
export function checkValues(
  set: ConfigSet,
  values: Readonly<Record<string, unknown>>,
): Record<string, JsonValue> {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new ConfigError('invalid_value', 'config values must be an object', set.name);
  }
  const checked: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(set.fields, key) ? set.fields[key] : undefined;
    if (field === undefined) {
      throw new ConfigError(
        'unknown_key',
        'the config set does not declare this key',
        set.name,
        key,
      );
    }
    try {
      // A field's check admits only JSON-safe values.
      checked[key] = field.check(value) as JsonValue;
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new ConfigError('invalid_value', `the value ${error.message}`, set.name, key);
      }
      throw error;
    }
  }
  return checked;
}
