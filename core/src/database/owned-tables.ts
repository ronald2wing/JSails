/**
 * Framework-owned tables that must already exist.
 *
 * A plugin that persists into its own tables (sessions, feature flags, media
 * metadata, blog content) never creates them: the app includes the plugin's
 * entities in its `JsailsDataSource` and `db:push` reconciles the schema. The
 * plugin's store opens the data source once, probes that every required table
 * exists, and fails value-free with the `db:push` hint otherwise.
 *
 * The probe is one parameterized catalog query that names only the owned
 * tables, in the connected database (MariaDB/MySQL: `DATABASE()`), schema
 * (PostgreSQL: the driver's `schema`), or main SQLite database. TypeORM's
 * PostgreSQL driver sets its `schema` on connect to the configured `schema`
 * option, else the connection's `current_schema()`, so an initialized source
 * always names one; the probe asks `current_schema()` itself only for a driver
 * that leaves `schema` unset. It does not use TypeORM's `getTables()`: called without
 * names, that introspects every table of every visible schema, and on MariaDB
 * it crashes for a user without global privileges (who sees
 * `performance_schema` in `INFORMATION_SCHEMA.TABLES` but not in `SCHEMATA`)
 * or when another database is dropped mid-probe; called with names, it still
 * loads every owned table's columns, indexes, and foreign keys only for the
 * names to be read back. Views do not count as tables. Any other driver falls
 * back to `QueryRunner.hasTable`, one table at a time.
 *
 * The probe is memoized on success and retried after a failure, so a request
 * costs one query rather than a schema probe plus a query, and a database that
 * is migrated later recovers without a restart.
 */

import type { DataSource, QueryRunner } from 'typeorm';

/** The failure a {@link createOwnedTables} probe reports; the caller maps it to its own error class. */
export type OwnedTablesFailure = 'not_initialized' | 'missing_table';

/** Options for {@link createOwnedTables}. */
export interface OwnedTablesOptions {
  /** The data source, or a lazy getter for it. */
  readonly dataSource: DataSource | (() => DataSource);
  /** The table names that must exist, unqualified, where the data source's entities live. */
  readonly tables: readonly string[];
  /**
   * Whether an uninitialized source is initialized on first use. Defaults to
   * false: a store that is handed an initialized source reports
   * `not_initialized` instead of connecting on the caller's behalf.
   */
  readonly initialize?: boolean;
  /** Build the error thrown for `failure`; `table` names the missing table. */
  readonly makeError: (failure: OwnedTablesFailure, table: string | undefined) => Error;
}

/** The opened handle: a data source whose owned tables are known to exist. */
export interface OwnedTables {
  /** Resolve, initialize if configured, and verify the tables; memoized on success. */
  open(): Promise<DataSource>;
}

/** Create a memoized opener for a set of framework-owned tables. */
export function createOwnedTables(options: OwnedTablesOptions): OwnedTables {
  const { tables, makeError } = options;
  const initialize = options.initialize === true;
  let opened: Promise<DataSource> | undefined;

  async function probe(): Promise<DataSource> {
    const source =
      typeof options.dataSource === 'function' ? options.dataSource() : options.dataSource;
    if (!source.isInitialized) {
      if (!initialize) {
        throw makeError('not_initialized', undefined);
      }
      await source.initialize();
    }
    if (tables.length === 0) return source;
    const queryRunner = source.createQueryRunner();
    let live: ReadonlySet<string>;
    try {
      await queryRunner.connect();
      live = await liveTables(source, queryRunner, tables);
    } finally {
      await queryRunner.release();
    }
    for (const table of tables) {
      if (!live.has(table)) {
        throw makeError('missing_table', table);
      }
    }
    return source;
  }

  return {
    open(): Promise<DataSource> {
      opened ??= probe().catch((error: unknown) => {
        opened = undefined;
        throw error;
      });
      return opened;
    },
  };
}

const MYSQL_FAMILY: ReadonlySet<string> = new Set(['mysql', 'mariadb']);
const SQLITE_FAMILY: ReadonlySet<string> = new Set(['sqljs', 'sqlite', 'better-sqlite3']);

/** Which of `names` exist as tables where the data source's entities live. */
async function liveTables(
  source: DataSource,
  queryRunner: QueryRunner,
  names: readonly string[],
): Promise<ReadonlySet<string>> {
  const type = source.options.type;
  if (MYSQL_FAMILY.has(type)) {
    // MariaDB lists a system-versioned table as 'SYSTEM VERSIONED', not 'BASE TABLE'.
    return selectNames(
      queryRunner,
      'SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES ' +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') " +
        `AND TABLE_NAME IN (${names.map(() => '?').join(', ')})`,
      names,
    );
  }
  if (type === 'postgres') {
    const schema = source.driver.schema;
    const parameters = schema === undefined ? [...names] : [schema, ...names];
    const first = schema === undefined ? 1 : 2;
    return selectNames(
      queryRunner,
      'SELECT table_name AS name FROM information_schema.tables ' +
        `WHERE table_schema = ${schema === undefined ? 'current_schema()' : '$1'} ` +
        "AND table_type = 'BASE TABLE' " +
        `AND table_name IN (${names.map((_, index) => `$${String(index + first)}`).join(', ')})`,
      parameters,
    );
  }
  if (SQLITE_FAMILY.has(type)) {
    return selectNames(
      queryRunner,
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        `AND name IN (${names.map(() => '?').join(', ')})`,
      names,
    );
  }
  const live = new Set<string>();
  for (const name of names) {
    if (await queryRunner.hasTable(name)) live.add(name);
  }
  return live;
}

/** Run a catalog query whose rows carry a `name` column and collect the names. */
async function selectNames(
  queryRunner: QueryRunner,
  sql: string,
  parameters: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows: unknown = await queryRunner.query(sql, [...parameters]);
  const live = new Set<string>();
  if (!Array.isArray(rows)) return live;
  for (const row of rows as readonly unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const name: unknown = (row as { readonly name?: unknown }).name;
    if (typeof name === 'string') live.add(name);
  }
  return live;
}
