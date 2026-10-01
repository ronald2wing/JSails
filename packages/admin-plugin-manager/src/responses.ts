/**
 * The plugin manager's own value-free HTTP responses. Failures shared with the
 * rest of the admin (400/403/404/500) come from `@jsails/admin`; these two are
 * specific to installs. Raw error text is never emitted.
 */

import { adminErrorResponse } from '@jsails/admin';

/** A 409 for an install targeting a plugin id the application config manages. */
export function conflictResponse(): Response {
  return adminErrorResponse(
    409,
    'Conflict',
    'This plugin is managed by the application configuration.',
  );
}

/** A value-free 400 for a failed install; the cause is never emitted. */
export function installFailureResponse(): Response {
  return adminErrorResponse(400, 'Install Failed', 'The plugin could not be installed.');
}
