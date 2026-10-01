/**
 * `createTestDataSource(models, options?)`: a `JsailsDataSource` on a test
 * database of its own, with the models' tables in place and empty.
 *
 * - `'file'` (the default): a SQLite file in a new temporary directory, so
 *   the engine's real writer/reader split runs, as in production.
 * - `'memory'`: SQLite `:memory:`, one connection; the tables are created
 *   through the data source's own engine.
 * - a server (`{ config, name?, workerId?, drop? }`): the database
 *   {@link testDatabaseName} names, on the server `config` connects to.
 *
 * A file or server database passes the test-database guard before any table
 * is created: the harness marks a database only when it created it, then
 * pushes with environment `test`, which checks the server-reported name and
 * the marker under the schema lock. A server database that already exists
 * is therefore reused only when an earlier run of the harness created it; a
 * database it did not create is refused (`schema.unmarked_test_database`),
 * whatever its name. Inside that push, after the guard and before the plan,
 * the tables it manages are emptied, so neither a killed run nor a
 * committing test leaks rows into the next, and no leftover row blocks a
 * change the plan makes (a required column, a unique index, a foreign key).
 *
 * Creating, marking, emptying, pushing and dropping all run on the
 * migration connection (`migrationUrl ?? url`), the one a schema push uses;
 * the data source's own connection is the app's, opened when a test first
 * queries.
 *
 * `close()` closes the engine first and then removes the temporary directory
 * (retrying, as Windows may hold a just-closed file for a moment) or drops a
 * server database opened with `drop: true`. Per-worker databases are kept by
 * default, so the next run only pushes what changed.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SealProvider } from '../codec/seal-provider.js';
import {
  MEMORY_DATABASE,
  resolveDatabaseConfig,
  type DatabaseConfig,
  type ServerConnection,
} from '../engine/config.js';
import type { Conn, Dialect } from '../engine/contract.js';
import { createEngine } from '../engine/create-engine.js';
import type { ConnectionErrorListener } from '../engine/server/server-engine.js';
import type { ModelTarget } from '../model/model-spec.js';
import type { AttachmentOptions } from '../record/attachments.js';
import {
  internalsOf,
  JsailsDataSource,
  type JsailsDataSourceOptions,
} from '../record/data-source.js';
import { declaredTables } from '../schema/declared-tables.js';
import { createTableStatements, quoteName } from '../schema/emit.js';
import { pushTestSchema } from '../schema/push-schema.js';
import { markTestDatabase } from '../schema/test-guard.js';
import { transaction } from '../transaction/run-transaction.js';
import { emptyManagedTables, TESTING_ORIGIN } from './empty-tables.js';
import { matrixDriver, matrixServer, matrixServerUrl } from './driver-matrix.js';
import { TestingErrors } from './testing-errors.js';

/** A test database on a MariaDB or PostgreSQL server. */
export interface TestServerDatabase {
  /**
   * The resolved configuration of a server connection
   * (`resolveDatabaseConfig`). Its database is the administrative connection
   * the test database is created from, so it must exist; its credentials
   * (the migration connection's, when set) need the right to create
   * databases.
   */
  readonly config: DatabaseConfig;
  /** The base of the test database's name. Default: the database of `config`. */
  readonly name?: string;
  /**
   * The test worker this process is, for one database per worker. Default:
   * `NODE_TEST_WORKER_ID`, which `node --test` sets in each worker process;
   * `null` for none.
   */
  readonly workerId?: string | number | null;
  /** Drop the database when the data source closes. Default `false`: it is kept and reused. */
  readonly drop?: boolean;
}

/** Where a test data source's database lives. */
export type TestDatabase = 'file' | 'memory' | TestServerDatabase;

/** Options of {@link createTestDataSource}. */
export interface CreateTestDataSourceOptions {
  /** Default `'file'`: SQLite in a new temporary directory. */
  readonly database?: TestDatabase;
  /** Builds the seal layer of encrypted columns. */
  readonly seal?: SealProvider;
  /** Attachment blobs' disk and cleanup reporter; needs `attachmentTable` in the models. */
  readonly attachments?: AttachmentOptions;
  /** Receives failures of pooled connections no caller holds. */
  readonly onConnectionError?: ConnectionErrorListener;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'database',
  'seal',
  'attachments',
  'onConnectionError',
]);
const SERVER_KEYS: ReadonlySet<string> = new Set(['config', 'name', 'workerId', 'drop']);
const SQLITE_FILE = 'app_test.sqlite';
/** PostgreSQL's identifier limit; MariaDB allows 64. */
const MAX_NAME_LENGTH = 63;
const BASE_NAME = /^[A-Za-z0-9_]+$/;
const WORKER_ID = /^[A-Za-z0-9]{1,16}$/;
const TEST_SUFFIX = /_test(s|ing)?$/i;

/**
 * The name of the test database for `base` and a test worker:
 * `<stem>_test`, or `<stem>_w<workerId>_test`, where `<stem>` is `base`
 * without a trailing `_test`, `_tests` or `_testing`. Every name ends in a
 * test segment, so it passes the guard's identity check, and each worker of
 * a parallel run gets a database of its own.
 *
 * ```ts
 * testDatabaseName('app', '3'); // 'app_w3_test'
 * testDatabaseName('app_test', null); // 'app_test'
 * ```
 *
 * @param workerId Default `NODE_TEST_WORKER_ID`; `null` for none.
 * @throws `testing.invalid_database_name`.
 */
export function testDatabaseName(
  base: string,
  workerId: string | number | null | undefined = process.env.NODE_TEST_WORKER_ID,
): string {
  if (typeof base !== 'string' || !BASE_NAME.test(base)) {
    throw new TestingErrors.Error('invalid_database_name', { part: 'base name' });
  }
  const stem = base.replace(TEST_SUFFIX, '');
  if (stem === '') throw new TestingErrors.Error('invalid_database_name', { part: 'base name' });
  let name = `${stem}_test`;
  if (workerId !== null && workerId !== undefined) {
    const id = typeof workerId === 'number' ? String(workerId) : workerId;
    if (typeof id !== 'string' || !WORKER_ID.test(id)) {
      throw new TestingErrors.Error('invalid_database_name', { part: 'worker id' });
    }
    name = `${stem}_w${id}_test`;
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new TestingErrors.Error('invalid_database_name', { part: 'name' });
  }
  return name;
}

/**
 * The test database of this run of the three-driver matrix: `'file'` on
 * SQLite, and on a database-suite run a database `jsails_m_<random>_test` on
 * the run's server (the matrix's naming, inside CI's MariaDB grant), dropped
 * when the data source closes.
 *
 * @param env The environment the matrix reads; default the driver matrix's.
 */
export function matrixTestDatabase(
  env?: Readonly<Record<string, string | undefined>>,
): TestDatabase {
  if (matrixDriver(env) === 'sqlite') return 'file';
  const server = matrixServer(env);
  const config = resolveDatabaseConfig(
    {},
    { env: { DATABASE_URL: matrixServerUrl(server, server.database) } },
  );
  return Object.freeze({
    config,
    name: `jsails_m_${randomBytes(6).toString('hex')}`,
    workerId: null,
    drop: true,
  });
}

/** A data source on a test database, which `close()` also removes when it is temporary. */
export class TestDataSource extends JsailsDataSource {
  /** The database: the SQLite file's path, `:memory:`, or the server database's name. */
  readonly database: string;
  readonly #remove: () => Promise<void>;
  #closing: Promise<void> | undefined;

  constructor(options: JsailsDataSourceOptions, database: string, remove: () => Promise<void>) {
    super(options);
    this.database = database;
    this.#remove = remove;
  }

  /** Close the engine, then remove the temporary directory or drop a `drop: true` database. */
  override close(): Promise<void> {
    this.#closing ??= this.#closeThenRemove();
    return this.#closing;
  }

  async #closeThenRemove(): Promise<void> {
    try {
      await super.close();
    } finally {
      await this.#remove();
    }
  }
}

/** A test database ready for a data source. */
interface PreparedDatabase {
  readonly config: DatabaseConfig;
  readonly label: string;
  /** Whether its tables still have to be created through the data source. */
  readonly createTables: boolean;
  remove(): Promise<void>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Run `body` on the migration connection of `config`, the one a schema push uses. */
async function withMigrationConn<R>(
  config: DatabaseConfig,
  body: (conn: Conn) => Promise<R>,
): Promise<R> {
  const engine = await createEngine(config, { purpose: 'migration' });
  try {
    const conn = await engine.lease();
    try {
      return await body(conn);
    } finally {
      await conn.release();
    }
  } finally {
    await engine.close();
  }
}

/** Mark a database the harness just created as a test database. */
function markCreated(config: DatabaseConfig): Promise<void> {
  return withMigrationConn(config, (conn) => markTestDatabase(conn));
}

/**
 * Push `models` with every operation approved, emptying the tables the push
 * manages after the guard and before the plan.
 */
async function pushEmpty(config: DatabaseConfig, models: readonly ModelTarget[]): Promise<void> {
  await pushTestSchema({ config, models }, { approve: 'all' }, emptyManagedTables);
}

async function prepareFile(models: readonly ModelTarget[]): Promise<PreparedDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'jsails-test-'));
  const remove = (): Promise<void> =>
    rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  try {
    const file = join(directory, SQLITE_FILE);
    const config = resolveDatabaseConfig({ file }, { env: {} });
    await markCreated(config);
    await pushEmpty(config, models);
    return { config, label: file, createTables: false, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

function prepareMemory(): PreparedDatabase {
  return {
    config: resolveDatabaseConfig({ file: MEMORY_DATABASE }, { env: {} }),
    label: MEMORY_DATABASE,
    createTables: true,
    remove: () => Promise.resolve(),
  };
}

const EXISTS_QUERIES: Readonly<Record<Exclude<Dialect, 'sqlite'>, string>> = {
  postgres: 'SELECT 1 AS found FROM pg_database WHERE datname = $1',
  mariadb: 'SELECT 1 AS found FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
};

async function databaseExists(conn: Conn, dialect: 'mariadb' | 'postgres', name: string) {
  const { rows } = await conn.query(EXISTS_QUERIES[dialect], [name], { origin: TESTING_ORIGIN });
  return rows.length > 0;
}

/** Create `name` unless it exists; whether this call created it. */
function ensureDatabase(
  admin: DatabaseConfig,
  dialect: 'mariadb' | 'postgres',
  name: string,
): Promise<boolean> {
  return withMigrationConn(admin, async (conn) => {
    if (await databaseExists(conn, dialect, name)) return false;
    try {
      await conn.query(`CREATE DATABASE ${quoteName(dialect, name)}`, [], {
        origin: TESTING_ORIGIN,
      });
      return true;
    } catch (error) {
      // Another process created it first; it is then an existing database.
      if (await databaseExists(conn, dialect, name)) return false;
      throw error;
    }
  });
}

function dropDatabase(
  admin: DatabaseConfig,
  dialect: 'mariadb' | 'postgres',
  name: string,
): Promise<void> {
  const quoted = quoteName(dialect, name);
  return withMigrationConn(admin, async (conn) => {
    await conn.query(
      dialect === 'postgres'
        ? `DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`
        : `DROP DATABASE IF EXISTS ${quoted}`,
      [],
      { origin: TESTING_ORIGIN },
    );
  });
}

/**
 * `connection` on database `name`. A resolved connection's password is not
 * enumerable (so it never prints), so a spread would drop it; it is carried
 * over the same way.
 */
function connectionTo(connection: ServerConnection, name: string): ServerConnection {
  const moved = { ...connection, database: name };
  Object.defineProperty(moved, 'password', { value: connection.password, enumerable: false });
  return Object.freeze(moved);
}

/** `config` with every connection pointed at database `name`. */
function onDatabase(config: DatabaseConfig, name: string): DatabaseConfig {
  const { connection, migration } = config;
  return Object.freeze({
    ...config,
    ...(connection === undefined ? {} : { connection: connectionTo(connection, name) }),
    ...(migration === undefined ? {} : { migration: connectionTo(migration, name) }),
  });
}

function checkServer(value: Readonly<Record<string, unknown>>): {
  readonly config: DatabaseConfig;
  readonly dialect: 'mariadb' | 'postgres';
  readonly name: string;
  readonly drop: boolean;
} {
  if (Object.keys(value).some((key) => !SERVER_KEYS.has(key))) {
    throw new TestingErrors.Error('invalid_options', { field: 'database' });
  }
  const config = value.config as DatabaseConfig | undefined;
  if (
    !isRecord(config) ||
    (config.dialect !== 'mariadb' && config.dialect !== 'postgres') ||
    config.connection === undefined
  ) {
    throw new TestingErrors.Error('invalid_options', { field: 'database.config' });
  }
  if (value.drop !== undefined && typeof value.drop !== 'boolean') {
    throw new TestingErrors.Error('invalid_options', { field: 'database.drop' });
  }
  const base = value.name === undefined ? config.connection.database : value.name;
  const workerId = value.workerId as string | number | null | undefined;
  return {
    config,
    dialect: config.dialect,
    // An unset worker id takes the default, `NODE_TEST_WORKER_ID`.
    name: testDatabaseName(base as string, workerId),
    drop: value.drop === true,
  };
}

async function prepareServer(
  models: readonly ModelTarget[],
  database: Readonly<Record<string, unknown>>,
): Promise<PreparedDatabase> {
  const { config: admin, dialect, name, drop } = checkServer(database);
  const created = await ensureDatabase(admin, dialect, name);
  const config = onDatabase(admin, name);
  const remove = (): Promise<void> =>
    drop ? dropDatabase(admin, dialect, name) : Promise.resolve();
  try {
    if (created) await markCreated(config);
    await pushEmpty(config, models);
  } catch (error) {
    // A database this call created is dropped whatever `drop` says: left
    // behind, possibly unmarked, it would be refused on every later run.
    if (created) {
      await dropDatabase(admin, dialect, name).catch(() => {
        // The preparation's failure is the one to report; a database that
        // could not be dropped either is refused, by name, on the next run.
      });
    }
    throw error;
  }
  return { config, label: name, createTables: false, remove };
}

/** Create the declared tables through the data source's own engine (a `:memory:` database). */
async function createTables(dataSource: JsailsDataSource): Promise<void> {
  const engine = await internalsOf(dataSource).engine();
  await transaction(dataSource, async () => {
    const conn = await engine.lease();
    try {
      for (const table of declaredTables(dataSource.models, dataSource.dialect)) {
        for (const statement of createTableStatements(table, dataSource.dialect)) {
          await conn.query(statement, [], { origin: 'schema' });
        }
      }
    } finally {
      await conn.release();
    }
  });
}

/**
 * A data source for `models` on a test database of its own, with their
 * tables created and empty. Close it when the tests are done (`after(() =>
 * ds.close())`): that also removes a temporary database.
 *
 * ```ts
 * const ds = await createTestDataSource([Post, Comment]);
 * after(() => ds.close());
 * ```
 *
 * @throws `testing.invalid_options`, `testing.invalid_database_name`,
 *   `schema.non_test_database` and `schema.unmarked_test_database` from the
 *   guard, every failure of creating the database or pushing the schema, and
 *   the data source's own (`data_source.already_bound` for a model bound to
 *   another open data source).
 */
export async function createTestDataSource(
  models: readonly ModelTarget[],
  options: CreateTestDataSourceOptions = {},
): Promise<TestDataSource> {
  if (!Array.isArray(models)) throw new TestingErrors.Error('invalid_options', { field: 'models' });
  if (
    options === null ||
    typeof options !== 'object' ||
    Object.keys(options).some((key) => !OPTION_KEYS.has(key))
  ) {
    throw new TestingErrors.Error('invalid_options', { field: 'options' });
  }
  const database = options.database ?? 'file';
  let prepared: PreparedDatabase;
  if (database === 'file') prepared = await prepareFile(models);
  else if (database === 'memory') prepared = prepareMemory();
  else if (isRecord(database)) prepared = await prepareServer(models, database);
  else throw new TestingErrors.Error('invalid_options', { field: 'database' });
  let dataSource: TestDataSource;
  try {
    dataSource = new TestDataSource(
      {
        config: prepared.config,
        models,
        ...(options.seal === undefined ? {} : { seal: options.seal }),
        ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
        ...(options.onConnectionError === undefined
          ? {}
          : { onConnectionError: options.onConnectionError }),
      },
      prepared.label,
      () => prepared.remove(),
    );
  } catch (error) {
    await prepared.remove();
    throw error;
  }
  try {
    if (prepared.createTables) await createTables(dataSource);
  } catch (error) {
    await dataSource.close();
    throw error;
  }
  return dataSource;
}
