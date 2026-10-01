/**
 * Reading an optional adapter capability. A feature that needs one (batches
 * need `flows`, overlap needs `leases`, reconciling needs `schedules`) asks
 * for it here and gets a value-free `jobs.capability_missing` naming the
 * capability when the adapter has none, rather than failing later on an
 * undefined method.
 */

import { JobsErrors } from '../errors/jobs-errors.js';
import type { JobsAdapter, JobsAdapterCapabilities } from './adapter.js';

/** The name of one optional adapter capability. */
export type JobsCapabilityName = 'flows' | 'failedJobs' | 'schedules' | 'leases';

/**
 * The adapter's capability `name`.
 *
 * @throws `jobs.capability_missing` naming the capability when the adapter has none.
 */
export function requireCapability<K extends JobsCapabilityName>(
  adapter: Pick<JobsAdapter, 'capabilities'>,
  name: K,
): NonNullable<JobsAdapterCapabilities[K]> {
  const capability = adapter.capabilities[name];
  if (capability === undefined) {
    throw new JobsErrors.Error('capability_missing', { capability: name });
  }
  return capability;
}
