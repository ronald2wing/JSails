/**
 * Validation issues as the Inertia `errors` prop.
 *
 * The client keys form errors by dotted field path (`user.tags.2`), the same
 * path a core `ValidationIssue` carries as segments. By default each field
 * gets its first message, as the client's `form.errors.field` expects a
 * string; `allMessages` keeps every message as an array (what Precognition
 * sends). An issue with an empty path, or whose path joins to a prototype key
 * (`__proto__` from untrusted JSON), is filed under the form-level key `''`,
 * so the failure is never lost and the prop stays serializable.
 */

import type { ValidationIssue } from 'jsails/api';
import { ValidationError } from 'jsails/api';

import type { InertiaErrors } from './error-bags.js';
import { FORBIDDEN_KEYS } from './plain-data.js';

/** Options for {@link toInertiaErrors}. */
export interface ToInertiaErrorsOptions {
  /** Keep every message per field as an array instead of the first one. */
  readonly allMessages?: boolean;
}

/** The key form-level issues (no field path) are filed under. */
export const FORM_ERROR_KEY = '';

/** Map validation issues to field errors keyed by dotted path. */
export function toInertiaErrors(
  issues: readonly ValidationIssue[],
  options: ToInertiaErrorsOptions = {},
): InertiaErrors {
  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    const joined = issue.path.map(String).join('.');
    const key = FORBIDDEN_KEYS.has(joined) ? FORM_ERROR_KEY : joined;
    const messages = grouped.get(key);
    if (messages === undefined) grouped.set(key, [issue.message]);
    else messages.push(issue.message);
  }
  const errors: Record<string, string | readonly string[]> = {};
  for (const [key, messages] of grouped) {
    errors[key] = options.allMessages === true ? Object.freeze(messages) : (messages[0] ?? '');
  }
  return Object.freeze(errors);
}

/** The issues of a core `ValidationError`, or `null` for any other failure. */
export function validationIssuesOf(error: unknown): readonly ValidationIssue[] | null {
  return error instanceof ValidationError ? error.issues : null;
}
