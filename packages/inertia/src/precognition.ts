/**
 * Precognition: live form validation without running the handler.
 *
 * A request with `Precognition: true` asks only whether its body would pass
 * validation, optionally for just the fields in `Precognition-Validate-Only`
 * (comma-separated dotted paths; `*` matches one segment). The answer follows
 * the protocol status table and what the laravel-precognition client accepts
 * (`dist/client.js`: the response must carry `Precognition: true`; success is
 * `204` with `Precognition-Success: true`; `dist/http/fetchClient.js` parses
 * a body only when its content type contains `application/json`):
 *
 * - pass: `204`, `Precognition: true`, `Precognition-Success: true`;
 * - fail: `422` `application/json` `{ message, errors }` with every message
 *   per field as an array, the shape the client merges into its form errors.
 *
 * Issues outside the validate-only list do not count: a form validating one
 * touched field must not see the errors of fields the user has not reached.
 * An issue under a listed field (`tags.2` for `tags`) counts as that field's.
 * Every answer varies on `Precognition` and is never stored.
 */

import type { ValidationIssue } from 'jsails/api';

import type { InertiaErrors } from './error-bags.js';
import type { InertiaPrecognitionOutcome } from './outcome.js';
import { appendVary, headerList, INERTIA_VARY } from './response-headers.js';
import { toInertiaErrors } from './validation-errors.js';
import type { InertiaRequestFacts } from './visit.js';

const precognitionHeaders = {
  precognition: 'Precognition',
  validateOnly: 'Precognition-Validate-Only',
  success: 'Precognition-Success',
} as const;
/** The Precognition header names. */
export const PRECOGNITION_HEADERS: typeof precognitionHeaders = Object.freeze(precognitionHeaders);

/** Whether the request is a Precognition validation request. */
export function isPrecognitive(headers: Headers): boolean {
  return headers.get(PRECOGNITION_HEADERS.precognition)?.trim().toLowerCase() === 'true';
}

/** The `Precognition-Validate-Only` fields, or `null` to validate everything. */
export function precognitionValidateOnly(headers: Headers): readonly string[] | null {
  const value = headers.get(PRECOGNITION_HEADERS.validateOnly);
  if (value === null) return null;
  const fields = value
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');
  return fields.length === 0 ? null : Object.freeze(fields);
}

/**
 * Answer a Precognition request from the issues validating its body produced
 * (`null` or empty when it passed). Returns `null` for a request that is not
 * precognitive, so the caller runs the handler as usual.
 */
export function precognition(
  facts: InertiaRequestFacts,
  issues: readonly ValidationIssue[] | null,
): InertiaPrecognitionOutcome | null {
  if (!isPrecognitive(facts.headers)) return null;
  const only = precognitionValidateOnly(facts.headers);
  const counted = (issues ?? []).filter(
    (issue) => only === null || only.some((field) => matchesField(issue.path.map(String), field)),
  );
  const headers = new Headers({
    [PRECOGNITION_HEADERS.precognition]: 'true',
    'Cache-Control': 'private, no-store',
  });
  appendVary(headers, INERTIA_VARY);
  if (counted.length === 0) {
    headers.set(PRECOGNITION_HEADERS.success, 'true');
    return Object.freeze({
      kind: 'precognition',
      success: true,
      status: 204,
      headers: headerList(headers),
      body: null,
    });
  }
  const errors = toInertiaErrors(counted, { allMessages: true });
  headers.set('Content-Type', 'application/json');
  return Object.freeze({
    kind: 'precognition',
    success: false,
    status: 422,
    headers: headerList(headers),
    body: JSON.stringify({ message: summary(errors, counted.length), errors }),
  });
}

/**
 * Whether an issue path belongs to a validate-only field: the field's
 * segments match the path's leading segments, `*` matching any one.
 */
function matchesField(path: readonly string[], field: string): boolean {
  const pattern = field.split('.');
  if (path.length < pattern.length) return false;
  return pattern.every((segment, index) => segment === '*' || segment === path[index]);
}

/** The reference summary: the first message, then how many more failed. */
function summary(errors: InertiaErrors, count: number): string {
  const first = Object.values(errors)[0];
  const message = (typeof first === 'string' ? first : first?.[0]) ?? '';
  const more = count - 1;
  if (more === 0) return message;
  return `${message} (and ${more} more error${more === 1 ? '' : 's'})`;
}
