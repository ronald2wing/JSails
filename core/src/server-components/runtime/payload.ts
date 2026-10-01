/**
 * Request payload parsing and validation for the server-component runtime.
 *
 * `parseUpdatePayload` validates the shape of a client update envelope (a
 * snapshot token, a bounded plain-object edit map, and at most one allowlisted
 * action), `parseActionArgs` validates an action's arguments against its input
 * schema, and `buildValues` stringifies submitted edits for a 422 re-render.
 * Every failure is a value-free `{ ok: false }` result — never a throw — so a
 * hostile payload is rejected without echoing raw submitted values.
 */

import type { ServerComponentAction } from '../component.js';
import type { JsonObject } from '../../contracts/http.js';
import { isForbiddenKey, isPlainObject } from '../../json/shape.js';
import {
  MAX_NESTED_SLOT_LENGTH,
  MAX_NESTED_SNAPSHOT_LENGTH,
  MAX_NESTED_SNAPSHOTS,
  MAX_NESTED_SNAPSHOTS_TOTAL_LENGTH,
  type ComponentNestedSnapshot,
} from '../protocol.js';
import { zodIssuesToFieldErrors } from './value-errors.js';

/** Upper bound on the number of keys a client update object may carry. */
const MAX_UPDATE_KEYS = 1000;

/** A parsed and shape-validated update request. */
interface ParsedUpdate {
  readonly snapshot: string;
  readonly updates: JsonObject;
  readonly action: { readonly name: string; readonly args?: JsonObject } | undefined;
  readonly sequence: number;
  /** Nested child snapshots offered for restore; absent from an older client. */
  readonly children: readonly ComponentNestedSnapshot[] | undefined;
}

type ParseUpdateResult =
  | { readonly ok: true; readonly value: ParsedUpdate }
  | { readonly ok: false; readonly sequence: number };

type ParseActionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

export function parseUpdatePayload(payload: unknown): ParseUpdateResult {
  if (!isPlainObject(payload)) {
    return { ok: false, sequence: 0 };
  }
  const sequence = payload.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    return { ok: false, sequence: 0 };
  }

  const snapshot = payload.snapshot;
  if (typeof snapshot !== 'string' || snapshot.length === 0) {
    return { ok: false, sequence };
  }

  const updates = payload.updates;
  if (!isPlainObject(updates) || Object.keys(updates).length > MAX_UPDATE_KEYS) {
    return { ok: false, sequence };
  }
  for (const key of Object.keys(updates)) {
    if (isForbiddenKey(key)) {
      return { ok: false, sequence };
    }
  }

  let action: { readonly name: string; readonly args?: JsonObject } | undefined;
  const rawAction = payload.action;
  if (rawAction !== undefined) {
    if (!isPlainObject(rawAction)) {
      return { ok: false, sequence };
    }
    const name = rawAction.name;
    if (typeof name !== 'string' || name.trim() === '' || name in Object.prototype) {
      return { ok: false, sequence };
    }
    const args = rawAction.args;
    if (args !== undefined && !isPlainObject(args)) {
      return { ok: false, sequence };
    }
    action = args === undefined ? { name } : { name, args: args as JsonObject };
  }

  let children: readonly ComponentNestedSnapshot[] | undefined;
  if (payload.children !== undefined) {
    const budget = {
      remaining: MAX_NESTED_SNAPSHOTS,
      chars: MAX_NESTED_SNAPSHOTS_TOTAL_LENGTH,
    };
    const parsedChildren = parseNestedSnapshots(payload.children, budget);
    if (parsedChildren === null) {
      return { ok: false, sequence };
    }
    children = parsedChildren;
  }

  return {
    ok: true,
    value: { snapshot, updates: updates as JsonObject, action, sequence, children },
  };
}

/**
 * Parse an offered list of nested child snapshots, spending one unit of the
 * shared `budget` per entry at every depth and the entry's slot and token
 * length from its character allowance. Returns `null` for any malformed entry
 * or once either allowance is exhausted, so an oversized tree is refused whole
 * rather than truncated in an order the client cannot predict.
 */
function parseNestedSnapshots(
  value: unknown,
  budget: { remaining: number; chars: number },
): readonly ComponentNestedSnapshot[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: ComponentNestedSnapshot[] = [];
  for (const raw of value as unknown[]) {
    budget.remaining -= 1;
    if (budget.remaining < 0 || !isPlainObject(raw)) {
      return null;
    }
    const { slot, snapshot, children } = raw;
    if (
      typeof slot !== 'string' ||
      slot.length === 0 ||
      slot.length > MAX_NESTED_SLOT_LENGTH ||
      typeof snapshot !== 'string' ||
      snapshot.length === 0 ||
      snapshot.length > MAX_NESTED_SNAPSHOT_LENGTH
    ) {
      return null;
    }
    budget.chars -= slot.length + snapshot.length;
    if (budget.chars < 0) {
      return null;
    }
    if (children === undefined) {
      entries.push({ slot, snapshot });
      continue;
    }
    const nested = parseNestedSnapshots(children, budget);
    if (nested === null) {
      return null;
    }
    entries.push({ slot, snapshot, children: nested });
  }
  return entries;
}

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
