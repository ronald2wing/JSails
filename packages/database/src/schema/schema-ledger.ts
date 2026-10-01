/**
 * The schema ledger: three tables the push creates idempotently before it
 * plans, declared as models so they lower through `physicalTable` and the
 * emitter like every other table.
 *
 * - `jsails_schema_objects(table_name, owner, created_at)`: which tables the
 *   reconciler created or adopted, and for whom. It alters and drops only
 *   these; any other table is unmanaged and left alone.
 * - `jsails_data_migrations(name, applied_at, duration_ms)`: forward-only data
 *   migrations that ran, for the release step that runs them (DAT-11).
 * - `jsails_schema_meta(key, value)`: the applied schema digest per owner
 *   (`digest:<owner>`), the test-database marker (`test:marker`) and the
 *   unmanaged tables already reported (`unmanaged:<table>`).
 *
 * Every accessor takes the connection it runs on, so a push reads and writes
 * the ledger inside its own lock (and, on SQLite, its own transaction).
 */

import type { Conn, Dialect, SqlValue } from '../engine/contract.js';
import { compileStatement } from '../engine/render.js';
import type { Statement } from '../engine/statement.js';
import {
  column,
  defineTable,
  physicalTable,
  portableCodec,
  type TableDefinition,
} from '../model/index.js';
import { createTableStatements } from './emit.js';

const ORIGIN = 'schema';

/** The ownership table. */
export const SCHEMA_OBJECTS_TABLE = 'jsails_schema_objects';
/** The data-migration table. */
export const DATA_MIGRATIONS_TABLE = 'jsails_data_migrations';
/** The key-value meta table. */
export const SCHEMA_META_TABLE = 'jsails_schema_meta';

/** One row per managed table: its owner (`app` or `plugin:<name>`). */
export const SchemaObjects: TableDefinition = defineTable({
  table: SCHEMA_OBJECTS_TABLE,
  primaryKey: 'tableName',
  columns: {
    tableName: column.string(64),
    owner: column.string(128),
    createdAt: column.timestamp(),
  },
});

/** One row per data migration that ran. */
export const DataMigrations: TableDefinition = defineTable({
  table: DATA_MIGRATIONS_TABLE,
  primaryKey: 'name',
  columns: {
    name: column.string(191),
    appliedAt: column.timestamp(),
    durationMs: column.integer(),
  },
});

/** Key-value facts: applied digests, reported unmanaged tables, the test marker. */
export const SchemaMeta: TableDefinition = defineTable({
  table: SCHEMA_META_TABLE,
  primaryKey: 'key',
  columns: { key: column.string(191), value: column.text() },
});

const LEDGER: readonly TableDefinition[] = Object.freeze([
  SchemaObjects,
  DataMigrations,
  SchemaMeta,
]);

/** The ledger's table names, which no model may use. */
export const LEDGER_TABLE_NAMES: ReadonlySet<string> = new Set([
  SCHEMA_OBJECTS_TABLE,
  DATA_MIGRATIONS_TABLE,
  SCHEMA_META_TABLE,
]);

/** The meta key of an owner's applied schema digest. */
export function digestKey(owner: string): string {
  return `digest:${owner}`;
}

/** The meta key the test harness marks a test database with. */
export const TEST_MARKER_KEY = 'test:marker';

/** The meta key recording that an unmanaged table was reported. */
export function unmanagedKey(table: string): string {
  return `unmanaged:${table}`;
}

async function run(
  conn: Conn,
  dialect: Dialect,
  statement: Statement,
): Promise<readonly Record<string, SqlValue>[]> {
  const { sql, params } = compileStatement(statement, dialect);
  return (await conn.query(sql, params, { origin: ORIGIN })).rows;
}

function now(dialect: Dialect): SqlValue {
  return portableCodec({ kind: 'timestamp' }, dialect).encode(new Date());
}

/** Create the ledger tables that do not exist yet. Safe to run on every push. */
export async function bootstrapLedger(conn: Conn, dialect: Dialect): Promise<void> {
  for (const table of LEDGER) {
    for (const sql of createTableStatements(physicalTable(table, dialect), dialect, {
      ifNotExists: true,
    })) {
      await conn.query(sql, [], { origin: ORIGIN });
    }
  }
}

/** Every owned table and its owner. */
export async function readOwnership(conn: Conn, dialect: Dialect): Promise<Map<string, string>> {
  const rows = await run(conn, dialect, {
    kind: 'select',
    from: { table: SCHEMA_OBJECTS_TABLE },
    columns: [{ column: 'table_name' }, { column: 'owner' }],
  });
  return new Map(rows.map((row) => [String(row.table_name), String(row.owner)]));
}

/**
 * Record `table` as owned by `owner`, replacing a record left behind (a
 * table dropped by hand and created again by this push).
 */
export async function recordOwnership(
  conn: Conn,
  dialect: Dialect,
  table: string,
  owner: string,
): Promise<void> {
  await run(conn, dialect, {
    kind: 'insert',
    table: SCHEMA_OBJECTS_TABLE,
    columns: ['table_name', 'owner', 'created_at'],
    rows: [[table, owner, now(dialect)]],
    onConflict: { target: ['table_name'], action: 'update', update: ['owner', 'created_at'] },
  });
}

/** Remove the ownership record of `table`. */
export async function removeOwnership(conn: Conn, dialect: Dialect, table: string): Promise<void> {
  await run(conn, dialect, {
    kind: 'delete',
    table: SCHEMA_OBJECTS_TABLE,
    where: { op: 'compare', column: 'table_name', comparison: '=', value: table },
  });
}

/** The meta value under `key`, or `undefined`. */
export async function readMeta(
  conn: Conn,
  dialect: Dialect,
  key: string,
): Promise<string | undefined> {
  const rows = await run(conn, dialect, {
    kind: 'select',
    from: { table: SCHEMA_META_TABLE },
    columns: [{ column: 'value' }],
    where: { op: 'compare', column: 'key', comparison: '=', value: key },
  });
  const value = rows[0]?.value;
  return value === undefined || value === null ? undefined : String(value);
}

/** Every meta key starting with `prefix`. */
export async function readMetaKeys(
  conn: Conn,
  dialect: Dialect,
  prefix: string,
): Promise<Set<string>> {
  const pattern = `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = await run(conn, dialect, {
    kind: 'select',
    from: { table: SCHEMA_META_TABLE },
    columns: [{ column: 'key' }],
    where: { op: 'like', column: 'key', pattern },
  });
  return new Set(rows.map((row) => String(row.key)));
}

/** Set the meta value under `key`. */
export async function writeMeta(
  conn: Conn,
  dialect: Dialect,
  key: string,
  value: string,
): Promise<void> {
  await run(conn, dialect, {
    kind: 'insert',
    table: SCHEMA_META_TABLE,
    columns: ['key', 'value'],
    rows: [[key, value]],
    onConflict: { target: ['key'], action: 'update', update: ['value'] },
  });
}

/** A data migration that ran. */
export interface AppliedDataMigration {
  readonly name: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

/** The data migrations that ran, oldest first. */
export async function appliedDataMigrations(
  conn: Conn,
  dialect: Dialect,
): Promise<AppliedDataMigration[]> {
  const codec = portableCodec({ kind: 'timestamp' }, dialect);
  const rows = await run(conn, dialect, {
    kind: 'select',
    from: { table: DATA_MIGRATIONS_TABLE },
    columns: [{ column: 'name' }, { column: 'applied_at' }, { column: 'duration_ms' }],
    orderBy: [{ column: 'applied_at' }, { column: 'name' }],
  });
  return rows.map((row) =>
    Object.freeze({
      name: String(row.name),
      appliedAt: codec.decode(row.applied_at ?? null),
      durationMs: Number(row.duration_ms),
    }),
  );
}

/** Record that the data migration `name` ran, taking `durationMs`. */
export async function recordDataMigration(
  conn: Conn,
  dialect: Dialect,
  name: string,
  durationMs: number,
): Promise<void> {
  await run(conn, dialect, {
    kind: 'insert',
    table: DATA_MIGRATIONS_TABLE,
    columns: ['name', 'applied_at', 'duration_ms'],
    rows: [[name, now(dialect), Math.round(durationMs)]],
  });
}
