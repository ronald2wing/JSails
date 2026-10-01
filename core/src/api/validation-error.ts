/**
 * The validation failure every schema, body reader and resource throws:
 * structured issues (a `path` and a stable `code`), never raw input.
 *
 * Kept apart from the Zod-backed schemas (`validation.ts`) so the code that
 * only recognizes the failure, the HTTP failure mapper among it, loads no
 * schema library.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** A location inside a nested document: object keys then array indices. */
export type FieldPath = ReadonlyArray<string | number>;

/** A single validation failure, keyed by its structured location. */
export interface ValidationIssue {
  /** Where the failure occurred, e.g. `["user", "tags", 2]`. */
  readonly path: FieldPath;
  /** Stable machine code, e.g. `"type"`, `"min_length"`, `"unknown_field"`. */
  readonly code: string;
  /** Human-readable description. Never echoes input values. */
  readonly message: string;
}

/** Thrown when validation fails. Carries structured issues, never raw input. */
export class ValidationError extends JsailsError {
  readonly code = 'invalid_input';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map(formatIssue).join('; '));
    this.issues = issues;
  }

  /** Dotted locations for every issue, e.g. `["user.tags.2"]`. */
  get paths(): readonly string[] {
    return this.issues.map((issue) => formatPath(issue.path));
  }
}

function formatPath(path: FieldPath): string {
  return path.join('.');
}

function formatIssue(issue: ValidationIssue): string {
  const location = issue.path.length > 0 ? `${formatPath(issue.path)}: ` : '';
  return `${location}${issue.message}`;
}
