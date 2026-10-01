/**
 * Record identity and per-resource authorization shared by every surface that
 * reaches a resource's rows: the CRUD, action, and relation routes, the list
 * renderer, the global search page, and the attach/detach actions.
 */

import type { Session } from 'jsails';

import { reportAdminError, type AdminErrorSink } from '../error-report.js';
import type { AdminResourceAction, Resource } from './resource-descriptor.js';

/** Extra inputs to {@link resourceAllowed}. */
export interface ResourceGateOptions {
  /** The action name, for the `action` gate. */
  readonly actionName?: string;
  /** Where a throwing `authorize` is reported (the panel). */
  readonly report?: AdminErrorSink;
}

/** The row's record identifier (the `id` property), stringified when present. */
export function recordId(row: Record<string, unknown>): string | undefined {
  const id = row['id'];
  if (id === undefined || id === null) {
    return undefined;
  }
  return String(id);
}

/**
 * Run a resource's `authorize`: deny when the resource declares none (the
 * panel gate admits a session to the panel, not to every resource in it),
 * otherwise allow only on an exact `true`. A throwing callback denies (and is
 * reported when `options.report` is given).
 */
export async function resourceAllowed(
  resource: Resource,
  session: Session,
  action: AdminResourceAction,
  recordId?: string,
  options: ResourceGateOptions = {},
): Promise<boolean> {
  if (resource.authorize === undefined) {
    return false;
  }
  try {
    return (
      (await resource.authorize({
        session,
        action,
        ...(recordId === undefined ? {} : { recordId }),
        ...(options.actionName === undefined ? {} : { actionName: options.actionName }),
      })) === true
    );
  } catch (error) {
    reportAdminError(options.report, error, {
      surface: 'resource',
      slug: resource.slug,
      operation: 'authorize',
    });
    return false;
  }
}
