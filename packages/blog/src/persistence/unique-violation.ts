/**
 * Maps a database unique-constraint violation onto the contract's value-free
 * `slug_conflict`, so a concurrent writer that slips past the repository's
 * slug pre-check is reported like any other duplicate slug.
 */

import { isUniqueViolation } from 'jsails/database';

import { slugConflict } from '../cms/repository-guards.js';

/**
 * Run a write, mapping a unique violation onto `slug_conflict` and rethrowing
 * anything else unchanged. The error never echoes the duplicated value.
 */
export async function withSlugConflict<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw slugConflict();
    }
    throw error;
  }
}
