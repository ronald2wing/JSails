/**
 * Detection of a database unique-constraint violation across the supported
 * drivers, so a write that slips past an application-level uniqueness check
 * (a concurrent writer) can still be answered as a conflict rather than a
 * server error.
 */

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
 * extended code is 2067; Postgres reports SQLSTATE `23505`. It reads only those
 * fields and never the duplicated value.
 *
 * TypeORM's `QueryFailedError` is recognised by its name (TypeORM errors name
 * themselves after their class) rather than `instanceof`, so this module, and
 * every barrel that re-exports it (`jsails/plugin-sdk`), loads no TypeORM.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'QueryFailedError' || !('driverError' in error)) {
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
