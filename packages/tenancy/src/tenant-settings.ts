/**
 * Typed tenant settings: an app's zod schema applied to raw settings.
 *
 * {@link parseTenantSettings} parses with the schema, so its defaults fill in
 * missing keys. It runs on every write and on every read, which means a
 * default added to the schema later also applies to rows stored before it.
 * The result must be storable. It has to be a plain JSON object (plain
 * objects, arrays, strings, finite numbers, booleans and `null`), and its
 * UTF-8 JSON can be at most {@link MAX_TENANT_SETTINGS_BYTES}. The function
 * also checks that the stored form reads back as the same value: it parses
 * the JSON a second time and compares. A schema that produces a value which
 * does not survive storage is refused as a developer error,
 * `invalid_settings_schema`. Examples are a `Date`, or a transform that
 * changes its own output on every pass.
 *
 * Refused input throws `invalid_settings`, and `TenancyError.issues` says
 * where the problem is. Each issue has only a path and a code. The value and
 * zod's message are never copied, because a custom message can quote the
 * input. A path segment that is not a short printable key (a key from a
 * record, for instance, can be anything) is shown as `*`, so log lines and
 * error responses cannot be spoofed through a key. At most
 * {@link MAX_SETTINGS_ISSUES} issues are reported.
 *
 * {@link tenantSettingsParser} binds a schema once and gives the
 * `parseSettings` function the lifecycle takes.
 */

import { z } from 'zod';

import { TenancyError, type TenancyErrorIssue } from './tenancy-error.js';
import { TENANCY_COLUMN_LIMITS } from './tenancy-records.js';

/** The largest stored settings, in bytes of UTF-8 JSON. */
export const MAX_TENANT_SETTINGS_BYTES: typeof TENANCY_COLUMN_LIMITS.settingsBytes =
  TENANCY_COLUMN_LIMITS.settingsBytes;

/** The most issues one `invalid_settings` error reports. */
export const MAX_SETTINGS_ISSUES = 32;

const MAX_PATH_DEPTH = 16;
const MAX_KEY_LENGTH = 64;
const MAX_JSON_DEPTH = 64;
const HIDDEN_SEGMENT = '*';
const KEY_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A zod schema (classic or mini) whose output is the settings type. */
export type TenantSettingsSchema<S> = z.core.$ZodType<S>;

type IssuePath = (string | number)[];

function issue(path: IssuePath, code: string): TenancyErrorIssue {
  return Object.freeze({ path: Object.freeze(path), code });
}

function refused(issues: readonly TenancyErrorIssue[]): TenancyError {
  return new TenancyError('invalid_settings', { issues: issues.slice(0, MAX_SETTINGS_ISSUES) });
}

function schemaError(cause?: unknown): TenancyError {
  return new TenancyError('invalid_settings_schema', cause === undefined ? undefined : { cause });
}

function shownSegment(segment: PropertyKey): string | number {
  if (typeof segment === 'number') {
    return segment;
  }
  if (typeof segment === 'string' && segment.length <= MAX_KEY_LENGTH) {
    return KEY_FORBIDDEN.test(segment) ? HIDDEN_SEGMENT : segment;
  }
  return HIDDEN_SEGMENT;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The path to the first part of `value` that JSON cannot store faithfully,
 * or `null` when all of it can. `undefined` as an object property is fine
 * (JSON drops the key); anywhere else it is not.
 */
function nonJsonPath(value: unknown, path: IssuePath): IssuePath | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : path;
  }
  if (typeof value !== 'object' || path.length >= MAX_JSON_DEPTH) {
    return path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = nonJsonPath(value[index], [...path, index]);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isPlainObject(value)) {
    return path;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      const found = nonJsonPath(entry, [...path, key]);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The stored JSON of a settings value. Throws `invalid_settings` when the
 * value is not a plain JSON object or its JSON is over the size limit.
 */
export function tenantSettingsJson(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refused([issue([], 'invalid_type')]);
  }
  const found = nonJsonPath(value, []);
  if (found !== null) {
    throw refused([issue(found.slice(0, MAX_PATH_DEPTH).map(shownSegment), 'not_json')]);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_TENANT_SETTINGS_BYTES) {
    throw refused([issue([], 'too_big')]);
  }
  return json;
}

function isSchema(value: unknown): boolean {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

type Parsed<S> =
  { readonly ok: true; readonly value: S } | { readonly ok: false; readonly error: TenancyError };

/** Run the schema; a schema that throws (an async refinement, a throwing transform) is the app's bug. */
function run<S>(schema: TenantSettingsSchema<S>, raw: unknown): Parsed<S> {
  let result: z.ZodSafeParseResult<S>;
  try {
    result = z.safeParse(schema, raw);
  } catch (error) {
    throw schemaError(error);
  }
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: refused(
      result.error.issues.map((entry) =>
        issue(entry.path.slice(0, MAX_PATH_DEPTH).map(shownSegment), entry.code),
      ),
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Parse raw settings with the schema, applying its defaults, and return them
 * deeply frozen. Throws `invalid_settings` (with path-and-code issues) when
 * the input is refused or the result is too large to store, and
 * `invalid_settings_schema` when the schema is not a zod schema, throws while
 * parsing, or produces a value that does not read back unchanged from JSON.
 */
export function parseTenantSettings<S extends object>(
  schema: TenantSettingsSchema<S>,
  raw: unknown,
): S {
  if (!isSchema(schema)) {
    throw schemaError();
  }
  const first = run(schema, raw);
  if (!first.ok) {
    throw first.error;
  }
  let json: string;
  try {
    json = tenantSettingsJson(first.value);
  } catch (error) {
    // Output that JSON cannot hold, from input that it can, was made by the schema.
    if (nonJsonPath(raw, []) === null && nonJsonPath(first.value, []) !== null) {
      throw schemaError(error);
    }
    throw error;
  }
  const second = run(schema, JSON.parse(json));
  if (!second.ok) {
    throw schemaError(second.error);
  }
  let reread: unknown;
  try {
    reread = JSON.stringify(second.value);
  } catch (error) {
    throw schemaError(error);
  }
  if (reread !== json) {
    throw schemaError();
  }
  return deepFreeze(second.value);
}

/**
 * A settings parser bound to one schema, for the lifecycle's `parseSettings`
 * option. Throws `invalid_settings_schema` at once when `schema` is not a zod
 * schema.
 */
export function tenantSettingsParser<S extends object>(
  schema: TenantSettingsSchema<S>,
): (raw: unknown) => S {
  if (!isSchema(schema)) {
    throw schemaError();
  }
  return (raw) => parseTenantSettings(schema, raw);
}
