/**
 * Record identity and per-resource authorization shared by every surface that
 * reaches a resource's rows: the CRUD, action, and relation routes, the list
 * renderer, the global search page, and the attach/detach actions.
 */

import type { Session } from 'jsails';
import type { AdminResourceAction, Resource } from './resource-descriptor.js';

/** The row's record identifier (the `id` property), stringified when present. */
export function recordId(row: Record<string, unknown>): string | undefined {
  const id = row['id'];
  if (id === undefined || id === null) {
    return undefined;
  }
  return String(id);
}

/**
 * Run a resource's `authorize`: default-allow when the resource declares none,
 * otherwise allow only on an exact `true`. A throwing callback denies.
 */
export async function resourceAllowed(
  resource: Resource,
  session: Session,
  action: AdminResourceAction,
  recordId?: string,
): Promise<boolean> {
  if (resource.authorize === undefined) {
    return true;
  }
  try {
    return (await resource.authorize({ session, action, recordId })) === true;
  } catch {
    return false;
  }
}
