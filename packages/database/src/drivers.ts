/**
 * The databases JSails supports (owner decision 7): SQLite, including in
 * production for single-node sites, MariaDB, and PostgreSQL. MySQL other than
 * MariaDB is not supported.
 */

/** A supported database. */
export type DatabaseDriver = 'sqlite' | 'mariadb' | 'postgres';

/** Every {@link DatabaseDriver}, in matrix order. */
export const DATABASE_DRIVERS: readonly DatabaseDriver[] = Object.freeze([
  'sqlite',
  'mariadb',
  'postgres',
]);
