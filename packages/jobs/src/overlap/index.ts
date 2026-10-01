/**
 * Overlap control: the `overlap` option of a definition or a schedule, the
 * lease key and TTL a dispatch stores from it, and the renewed lease an
 * attempt holds while it runs (`skipped` when another run holds the key).
 *
 * Exported here for the package's own producer, runtime and schedules; the
 * package barrel exports none of it.
 */

export { acquireOverlapLease, MAX_RELEASE_WAIT_MS, type OverlapLease } from './overlap-lease.js';
export {
  OVERLAP_LEASE_PREFIX,
  overlapFor,
  resolveOverlapOption,
  type OverlapOption,
} from './overlap-option.js';
