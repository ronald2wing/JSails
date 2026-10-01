/**
 * The test-database guard: before anything destructive runs on behalf of a
 * test, the database must prove it is a test database in two independent
 * ways.
 *
 * 1. Identity, as the server reports it. `current_database()` on
 *    PostgreSQL, `DATABASE()` on MariaDB, the main file of `PRAGMA
 *    database_list` on SQLite. A `url` in the environment overrides a
 *    configured `database` name, so the configuration proves nothing; only
 *    the connection's own answer does. The name's stem must be `test`,
 *    `tests` or `testing`, alone or after `_`, `-` or `.` (`app_test`,
 *    `storage/app_test.sqlite`); a leading `test` segment is not enough.
 * 2. A marker row (`test:marker` in `jsails_schema_meta`) that only the test
 *    harness writes, through {@link markTestDatabase}, which itself checks
 *    the identity first.
 *
 * `jsails test` (KRN-20) marks the database it creates and then pushes with
 * environment `test`, which runs {@link assertTestDatabase} under the schema
 * lock before the push changes anything.
 */

import { basename } from 'node:path';

import type { Conn, Dialect } from '../engine/contract.js';
import { introspect } from './introspect.js';
import { SchemaErrors } from './schema-errors.js';
import {
  bootstrapLedger,
  readMeta,
  SCHEMA_META_TABLE,
  TEST_MARKER_KEY,
  writeMeta,
} from './schema-ledger.js';

const ORIGIN = 'schema';
const SQLITE_EXTENSION = /\.(sqlite3?|db3?)$/i;

const DATABASE_QUERIES: Readonly<Record<Dialect, string>> = {
  postgres: 'SELECT current_database() AS name',
  mariadb: 'SELECT DATABASE() AS name',
  sqlite: "SELECT file AS name FROM pragma_database_list WHERE name = 'main'",
};

/**
 * The database `conn` is connected to, as the server reports it: a database
 * name, or the path of SQLite's main file. Throws `schema.unknown_database`
 * when the server reports none (MariaDB without a default database, a
 * SQLite `:memory:` or temporary database).
 */
export async function connectedDatabase(conn: Conn): Promise<string> {
  const { rows } = await conn.query(DATABASE_QUERIES[conn.dialect], [], { origin: ORIGIN });
  const name = rows[0]?.name;
  if (typeof name !== 'string' || name === '') throw new SchemaErrors.Error('unknown_database');
  return name;
}

/** Whether a database name or SQLite path names a dedicated test database. */
export function isTestDatabaseName(name: string): boolean {
  // Only a SQLite extension is stripped: a server database `tests.app` has none.
  const stem = basename(name).replace(SQLITE_EXTENSION, '');
  return /^test(s|ing)?$/i.test(stem) || /[_.-]test(s|ing)?$/i.test(stem);
}

async function assertTestIdentity(conn: Conn): Promise<void> {
  if (!isTestDatabaseName(await connectedDatabase(conn))) {
    throw new SchemaErrors.Error('non_test_database');
  }
}

/**
 * Mark the database `conn` uses as a test database, creating the ledger
 * tables if needed. Refuses (`schema.non_test_database`) a database whose
 * server-reported name is not a test name.
 */
export async function markTestDatabase(conn: Conn): Promise<void> {
  await assertTestIdentity(conn);
  await bootstrapLedger(conn, conn.dialect);
  await writeMeta(conn, conn.dialect, TEST_MARKER_KEY, '1');
}

/**
 * Throw unless the database `conn` uses has a test name as the server
 * reports it (`schema.non_test_database`) and carries the harness's marker
 * (`schema.unmarked_test_database`).
 */
export async function assertTestDatabase(conn: Conn): Promise<void> {
  await assertTestIdentity(conn);
  const live = await introspect(conn, conn.dialect, [SCHEMA_META_TABLE]);
  const marked =
    live.tables.length === 1 && (await readMeta(conn, conn.dialect, TEST_MARKER_KEY)) === '1';
  if (!marked) throw new SchemaErrors.Error('unmarked_test_database');
}
