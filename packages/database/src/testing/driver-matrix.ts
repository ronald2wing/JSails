/**
 * The three-driver test matrix: which database a test run targets, and a data
 * source of its own on that database.
 *
 * The run chooses the driver, never the test. The default suite runs on an
 * on-disk SQLite (sql.js) file. The database suite (`scripts/run-tests.mjs
 * --suite=database`, which runs only `*.database.test.ts(x)` files and sets
 * `JSAILS_TEST_SUITE=database`) runs on the server named by `DATABASE_TYPE`
 * (`mariadb` or `postgres`) at `DATABASE_HOST`/`DATABASE_PORT` as
 * `DATABASE_USER`/`DATABASE_PASSWORD`, with `DATABASE_NAME` as the
 * administrative database. CI runs the database suite once per server, so one
 * test file covers all three drivers across the legs; an expected failure on
 * one driver is scoped with `databases` in its ledger entry.
 *
 * Every data source {@link openMatrixDataSource} opens gets a database of its
 * own: a fresh file in a temporary directory on SQLite, and on a server a new
 * database `jsails_m_<random>_test`, created through the administrative
 * database and dropped when the test ends. Database-suite files run
 * concurrently against one server and create fixed table names, so a shared
 * database would make them collide. On MariaDB the user therefore needs
 * privileges on `jsails\_m\_%` databases; PostgreSQL needs `CREATEDB`.
 *
 * A database-suite run with a variable missing fails instead of skipping: a
 * leg whose variables did not arrive must not pass by testing nothing.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';

import { executeSchemaPlan, reconcileDataSource } from 'jsails';
import { JsailsDataSource, type JsailsDataSourceOptions } from 'jsails/database';

import { DATABASE_DRIVERS, type DatabaseDriver } from '../drivers.js';

/** A driver of the matrix: one of the supported databases. */
export type MatrixDriver = DatabaseDriver;

/** Machine-readable reason for a {@link DriverMatrixError}. */
export type DriverMatrixErrorCode = 'invalid_environment';

/**
 * The run's environment does not describe a usable database. The message names
 * the variables involved and never their values, which may be credentials.
 */
export class DriverMatrixError extends Error {
  override readonly name = 'DriverMatrixError';

  constructor(
    readonly code: DriverMatrixErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Server connection settings of a database-suite run. */
export interface MatrixServer {
  readonly type: 'mariadb' | 'postgres';
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** The administrative database the matrix creates databases from. */
  readonly database: string;
}

/** Registers cleanup: a node:test `TestContext`, or `{ after }` from node:test. */
export interface MatrixLifecycle {
  after(callback: () => unknown): void;
}

type Environment = Readonly<Record<string, string | undefined>>;

const SERVER_VARIABLES = [
  'DATABASE_HOST',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_NAME',
] as const;

const DEFAULT_PORTS: Readonly<Record<MatrixServer['type'], number>> = {
  mariadb: 3306,
  postgres: 5432,
};

/** The database this run targets: SQLite unless this is a database-suite run. */
export function matrixDriver(env: Environment = process.env): MatrixDriver {
  if (env.JSAILS_TEST_SUITE !== 'database') return 'sqlite';
  const type = env.DATABASE_TYPE;
  if (type === 'mariadb' || type === 'postgres') return type;
  throw new DriverMatrixError(
    'invalid_environment',
    'the database suite needs DATABASE_TYPE set to mariadb or postgres',
  );
}

/** The server settings of a database-suite run. */
export function matrixServer(env: Environment = process.env): MatrixServer {
  const type = matrixDriver(env);
  if (type === 'sqlite') {
    throw new DriverMatrixError('invalid_environment', 'this run uses SQLite, not a server');
  }
  const missing = SERVER_VARIABLES.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    throw new DriverMatrixError(
      'invalid_environment',
      `the ${type} database suite needs ${missing.join(', ')}`,
    );
  }
  const rawPort = env.DATABASE_PORT ?? '';
  const port = rawPort === '' ? DEFAULT_PORTS[type] : Number(rawPort);
  if ((rawPort !== '' && !/^\d+$/.test(rawPort)) || port < 1 || port > 65535) {
    throw new DriverMatrixError('invalid_environment', 'DATABASE_PORT must be a port number');
  }
  return {
    type,
    host: env.DATABASE_HOST as string,
    port,
    username: env.DATABASE_USER as string,
    password: env.DATABASE_PASSWORD as string,
    database: env.DATABASE_NAME as string,
  };
}

/** A `mysql://` or `postgres://` URL for `database` on `server`. */
export function matrixServerUrl(server: MatrixServer, database: string): string {
  const scheme = server.type === 'postgres' ? 'postgres' : 'mysql';
  const credentials = `${encodeURIComponent(server.username)}:${encodeURIComponent(server.password)}`;
  return `${scheme}://${credentials}@${server.host}:${server.port}/${encodeURIComponent(database)}`;
}

/**
 * Why a suite limited to `drivers` does not run on `driver`, or `false` when
 * it does. `forEachDriver` passes this as the suite's `skip`.
 */
export function driverSkipReason(
  driver: MatrixDriver,
  drivers: readonly MatrixDriver[] = DATABASE_DRIVERS,
): string | false {
  return drivers.includes(driver)
    ? false
    : `runs on ${drivers.join(', ')}; this run uses ${driver}`;
}

/**
 * A lifecycle whose callbacks run last-registered first, inside one `after` of
 * `lifecycle` (node:test runs `after` callbacks in registration order). A test
 * that creates a database and then connects to it registers the close after
 * the removal; this runs them the right way round.
 */
export function lastInFirstOut(lifecycle: MatrixLifecycle): MatrixLifecycle {
  const callbacks: (() => unknown)[] = [];
  lifecycle.after(async () => {
    for (const callback of callbacks.reverse()) await callback();
  });
  return {
    after: (callback) => {
      callbacks.push(callback);
    },
  };
}

function quoteIdentifier(type: MatrixServer['type'], name: string): string {
  return type === 'postgres' ? `"${name}"` : `\`${name}\``;
}

async function administer(server: MatrixServer, statement: string): Promise<void> {
  const admin = new JsailsDataSource({
    type: server.type,
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password,
    database: server.database,
    entities: [],
  });
  await admin.initialize();
  try {
    await admin.query(statement);
  } finally {
    await admin.destroy();
  }
}

/** A database created for one caller, and its removal. */
interface CreatedDatabase {
  readonly name: string;
  dispose(): Promise<void>;
}

async function createDatabase(server: MatrixServer, suffix: string): Promise<CreatedDatabase> {
  if (!/^[a-z0-9]{1,20}$/.test(suffix)) {
    throw new DriverMatrixError('invalid_environment', 'a database suffix is 1-20 of [a-z0-9]');
  }
  const name = `jsails_m_${randomBytes(6).toString('hex')}_${suffix}`;
  const quoted = quoteIdentifier(server.type, name);
  await administer(server, `CREATE DATABASE ${quoted}`);
  return {
    name,
    dispose: () =>
      administer(
        server,
        server.type === 'postgres'
          ? `DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`
          : `DROP DATABASE IF EXISTS ${quoted}`,
      ),
  };
}

/**
 * Create an empty database `jsails_m_<random>_<suffix>` on the run's server and
 * register its removal on `lifecycle`. Close connections to it in a callback
 * that runs earlier (see {@link lastInFirstOut}).
 */
export async function createMatrixDatabase(
  lifecycle: MatrixLifecycle,
  suffix = 'test',
  env: Environment = process.env,
): Promise<string> {
  const created = await createDatabase(matrixServer(env), suffix);
  lifecycle.after(() => created.dispose());
  return created.name;
}

/**
 * The old stack's statement logger. Typed through `jsails/database`, so the
 * only module of this package that imports TypeORM stays `src/engine/`.
 */
export type MatrixLogger = Exclude<JsailsDataSourceOptions['logger'], string | undefined>;

/** Options for {@link openMatrixDataSource}. */
export interface OpenMatrixDataSourceOptions {
  readonly entities: readonly Function[];
  /** Entity subscriber classes of the old stack. */
  readonly subscribers?: readonly Function[];
  /** Create the entities' tables with the framework's reconciler. Default `true`. */
  readonly migrate?: boolean;
  /** The old stack's statement logger. */
  readonly logger?: MatrixLogger;
  /** The environment to read; defaults to `process.env`. */
  readonly env?: Environment;
}

async function isolatedConnection(
  env: Environment,
): Promise<{ options: JsailsDataSourceOptions; dispose(): Promise<void> }> {
  if (matrixDriver(env) === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'jsails-matrix-'));
    return {
      options: { type: 'sqljs', location: join(directory, 'matrix_test.sqlite') },
      dispose: async () => rmSync(directory, { recursive: true, force: true }),
    };
  }
  const server = matrixServer(env);
  const created = await createDatabase(server, 'test');
  return {
    options: {
      type: server.type,
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      database: created.name,
    },
    dispose: created.dispose,
  };
}

/**
 * An initialized data source on a database of its own for this run, with the
 * entities' tables created by the framework's reconciler. When the lifecycle
 * ends it is destroyed and then its database removed, in one callback.
 */
export async function openMatrixDataSource(
  lifecycle: MatrixLifecycle,
  options: OpenMatrixDataSourceOptions,
): Promise<JsailsDataSource> {
  const isolated = await isolatedConnection(options.env ?? process.env);
  let dataSource: JsailsDataSource | undefined;
  lifecycle.after(async () => {
    try {
      if (dataSource?.isInitialized === true) await dataSource.destroy();
    } finally {
      await isolated.dispose();
    }
  });
  dataSource = new JsailsDataSource({
    ...isolated.options,
    entities: [...options.entities],
    subscribers: [...(options.subscribers ?? [])],
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  await dataSource.initialize();
  if (options.migrate ?? true) {
    const plan = await reconcileDataSource(dataSource);
    await executeSchemaPlan(dataSource, plan.operations);
  }
  return dataSource;
}

/** What a {@link forEachDriver} suite receives. */
export interface DriverMatrixContext {
  /** The driver this run targets. */
  readonly driver: MatrixDriver;
  /** {@link openMatrixDataSource} on this run's driver. */
  open(lifecycle: MatrixLifecycle, options: OpenMatrixDataSourceOptions): Promise<JsailsDataSource>;
}

/** Options for {@link forEachDriver}. */
export interface ForEachDriverOptions {
  /** The drivers the suite applies to; on any other it is skipped with the reason. */
  readonly drivers?: readonly MatrixDriver[];
  /** The environment to read; defaults to `process.env`. */
  readonly env?: Environment;
}

/**
 * Declare a suite that runs on the driver of this run. Name the file
 * `*.database.test.ts` so the database suite runs it on each server; the
 * default suite runs it on SQLite. The suite name does not carry the driver,
 * so a test keeps one ledger identity across the legs. Returns node:test's
 * promise for the suite, as `describe` does.
 */
export function forEachDriver(
  name: string,
  fn: (context: DriverMatrixContext) => void,
  options: ForEachDriverOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const driver = matrixDriver(env);
  const context: DriverMatrixContext = {
    driver,
    open: (lifecycle, openOptions) => openMatrixDataSource(lifecycle, { env, ...openOptions }),
  };
  return describe(name, { skip: driverSkipReason(driver, options.drivers) }, () => fn(context));
}
