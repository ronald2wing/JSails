/**
 * The user-editable fields of a tenant: its name, plan and settings.
 *
 * The lifecycle runs every value through these parsers before it reaches the
 * store, so the store's `invalid_store_input` (a developer error) is never
 * what a user sees for bad input.
 *
 * - A name is NFC, trimmed, 1 to 200 code points, with no control characters,
 *   line separators or bidirectional overrides (a name is shown in mail and
 *   in other tenants' switchers, where those characters spoof or break text).
 * - A plan is an opaque identifier for the app's billing layer: up to 64
 *   ASCII letters, digits, `.`, `_`, `:` and `-`, starting with a letter or
 *   digit, or `null`.
 * - Settings go through the app's parser on every write and every read, so
 *   defaults added to a schema later apply to rows written before. The stored
 *   form is JSON of a plain object, at most 64 KiB of UTF-8.
 */

import { TenancyError } from './tenancy-error.js';
import { TENANCY_COLUMN_LIMITS } from './tenancy-records.js';
import { tenantSettingsJson } from './tenant-settings.js';

const NAME_FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const PLAN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A tenant name in stored form. Throws `invalid_name`. */
export function parseTenantName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TenancyError('invalid_name');
  }
  const name = value.normalize('NFC').trim();
  if (
    name.length === 0 ||
    NAME_FORBIDDEN.test(name) ||
    [...name].length > TENANCY_COLUMN_LIMITS.name
  ) {
    throw new TenancyError('invalid_name');
  }
  return name;
}

/** A plan identifier, or `null`. Throws `invalid_plan`. */
export function parseTenantPlan(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !PLAN_SHAPE.test(value)) {
    throw new TenancyError('invalid_plan');
  }
  return value;
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function settingsError(cause?: unknown): TenancyError {
  return new TenancyError('invalid_settings', cause === undefined ? undefined : { cause });
}

function parsed<S>(parse: (raw: unknown) => S, raw: unknown): S {
  try {
    return parse(raw);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'invalid_settings' || code === 'invalid_settings_schema') {
      throw error;
    }
    throw settingsError(error);
  }
}

/** The parsed settings and the JSON to store. */
export interface SerializedSettings<S> {
  readonly value: S;
  readonly json: string;
}

/**
 * Parse raw settings with the app's parser and serialise the result. Throws
 * `invalid_settings` when the parser refuses, the result is not a plain JSON
 * object, or its JSON is over the size limit (see `tenantSettingsJson`).
 */
export function serializeTenantSettings<S>(
  parse: (raw: unknown) => S,
  raw: unknown,
): SerializedSettings<S> {
  const value = parsed(parse, raw);
  const json = tenantSettingsJson(value);
  return Object.freeze({ value, json });
}

/** Parse stored settings JSON with the app's parser. Throws `invalid_settings`. */
export function readTenantSettings<S>(parse: (raw: unknown) => S, json: string): S {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw settingsError(error);
  }
  return parsed(parse, raw);
}
