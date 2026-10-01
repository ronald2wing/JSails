/**
 * The admin slug: the single URL-segment identifier shared by pages, resources,
 * actions, and relation managers, all of which mount under the panel path.
 */

import { AdminDefinitionError, type AdminDefinitionErrorCode } from './errors.js';

/** A URL path segment identifier: no slashes, whitespace, dots, or control characters. */
export const ADMIN_SLUG_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/** Options for {@link assertAdminSlug}. */
export interface AssertAdminSlugOptions {
  /** The error code raised for a malformed slug. */
  readonly code: AdminDefinitionErrorCode;
  /** The human name of the slug field, used in the value-free message. */
  readonly label: string;
}

/** Require `value` to be an admin slug; the rejected value is never echoed. */
export function assertAdminSlug(value: unknown, options: AssertAdminSlugOptions): string {
  if (typeof value !== 'string' || !ADMIN_SLUG_PATTERN.test(value)) {
    throw new AdminDefinitionError(
      options.code,
      `${options.label} must be an identifier with no slashes`,
    );
  }
  return value;
}
