/**
 * Action-argument parsing and submitted-value echo for the server-component
 * runtime. The update envelope itself is parsed by the wire protocol's shared
 * parser (`wire/protocol.ts`); this module handles what depends on a
 * component definition.
 *
 * `parseActionArgs` validates an action's arguments against its input schema,
 * and `buildValues` stringifies submitted edits for a 422 re-render. Every
 * failure is a value-free `{ ok: false }` result — never a throw — so a
 * hostile payload is rejected without echoing raw submitted values.
 */

import type { ServerComponentAction } from '../component.js';
import type { JsonObject } from '../../contracts/http.js';
import { isPlainObject } from '../../json/shape.js';
import { zodIssuesToFieldErrors } from './value-errors.js';

type ParseActionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

export function parseActionArgs(
  definition: ServerComponentAction<any, any>,
  rawArgs: JsonObject | undefined,
): ParseActionResult {
  if (definition.input === undefined) {
    if (rawArgs !== undefined && isPlainObject(rawArgs) && Object.keys(rawArgs).length > 0) {
      return { ok: false, errors: { args: 'This action accepts no arguments' } };
    }
    return { ok: true, value: undefined };
  }
  const parsed = definition.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, errors: zodIssuesToFieldErrors(parsed.error.issues, rawArgs ?? {}) };
  }
  return { ok: true, value: parsed.data };
}

/** Stringify submitted client edits for repopulation (`values` render tool). */
export function buildValues(updates: JsonObject): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      values[key] = '';
    } else if (typeof value === 'string') {
      values[key] = value;
    } else {
      values[key] = JSON.stringify(value);
    }
  }
  return values;
}
