/**
 * `introspect(conn, dialect, tableNames?)`: the live schema in the shape the
 * planner compares with `physicalTable`, read straight from each dialect's
 * catalog (no ORM). Pushing a declared table and introspecting it gives back
 * the same columns, keys, indexes and foreign keys for every portable type.
 */

import type { Conn, Dialect } from '../engine/contract.js';
import { introspectMariadb } from './introspect-mariadb.js';
import { introspectPostgres } from './introspect-postgres.js';
import { introspectSqlite } from './introspect-sqlite.js';
import type { LiveTable, SchemaState } from './schema-state.js';

/**
 * Read the live schema through `conn`: every table of the current schema
 * (PostgreSQL), database (MariaDB) or main file (SQLite), or only those named
 * in `tableNames`. Tables come back sorted by name.
 */
export async function introspect(
  conn: Conn,
  dialect: Dialect,
  tableNames?: readonly string[],
): Promise<SchemaState> {
  const wanted = tableNames === undefined ? undefined : new Set(tableNames);
  let tables: LiveTable[];
  switch (dialect) {
    case 'postgres':
      tables = await introspectPostgres(conn, wanted);
      break;
    case 'mariadb':
      tables = await introspectMariadb(conn, wanted);
      break;
    case 'sqlite':
      tables = await introspectSqlite(conn, wanted);
      break;
  }
  tables.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze({ dialect, tables: Object.freeze(tables) });
}
