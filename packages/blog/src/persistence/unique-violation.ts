/**
 * Detection of a database unique-constraint violation across the supported
 * drivers, so a concurrent writer that slips past the repository's slug
 * pre-check still surfaces as the contract's value-free `slug_conflict`.
 */

import { QueryFailedError } from 'typeorm';

import { slugConflict } from '../cms/repository-guards.js';

/** The driver error fields that identify a unique violation. */
interface DriverError {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly errno?: unknown;
}

/**
 * True when a thrown error is the database reporting a unique violation. SQLite
 * (sql.js) reports `UNIQUE constraint failed: <table>.<column>` with no error
 * code; MariaDB reports `ER_DUP_ENTRY`/`ER_DUP_KEY` (errno 1062) and SQLite's
 * extended code is 2067; Postgres reports SQLSTATE `23505`.
 */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driver = error.driverError as DriverError | null | undefined;
  if (driver === undefined || driver === null) {
    return false;
  }
  return (
    (typeof driver.message === 'string' && driver.message.includes('UNIQUE constraint failed')) ||
    driver.code === 'ER_DUP_ENTRY' ||
    driver.code === 'ER_DUP_KEY' ||
    driver.code === '23505' ||
    driver.errno === 1062 ||
    driver.errno === 2067
  );
}

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
