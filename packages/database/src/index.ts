/**
 * `@jsails/database`: the JSails data layer, written fresh beside the old
 * stack in core and replacing it at the data cutover (DAT-15). It holds the
 * supported-driver list, the data engine (the SQL-level `Engine` contract over
 * SQLite, MariaDB and PostgreSQL, with the `database()` plugin's options
 * schema, `DatabaseError` and the query ledger) and, under
 * `@jsails/database/testing`, the three-driver test matrix.
 */

export { DATABASE_DRIVERS, type DatabaseDriver } from './drivers.js';
export * from './engine/index.js';
