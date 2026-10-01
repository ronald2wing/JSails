/**
 * The database a regression test runs against, chosen by the run, not by the
 * test: the default suite uses an on-disk SQLite (sql.js) file; the database
 * suite (`scripts/run-tests.mjs --suite=database`, which sets
 * `JSAILS_TEST_SUITE=database`) uses the server `DATABASE_TYPE` names
 * (`mariadb` or `postgres`) at `DATABASE_HOST`/`PORT`/`USER`/`PASSWORD`, with
 * `DATABASE_NAME` as the administrative database.
 *
 * Every data source gets a database of its own: a fresh file in a temporary
 * directory on SQLite, and on a server a new database named
 * `jsails_m_<random>_test`, created through the administrative database and
 * dropped when the test ends. Database-suite files run concurrently against one
 * server, and these tests create fixed table names, so sharing a database
 * would make them collide. On MariaDB the user therefore needs privileges on
 * `jsails\_m\_%` databases (the CI leg grants them).
 *
 * This is the old stack's counterpart of `@jsails/database`'s driver matrix
 * (packages/database/src/testing/driver-matrix.ts): core cannot import a
 * package, so its regression tests carry this small opener until the data
 * cutover (DAT-15) folds them into that package's conformance suite. It keeps
 * that helper's behaviour (environment parsing, value-free errors, cleanup
 * registered before anything that can throw), and matrix-database.test.ts
 * holds it to it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { EntitySubscriberInterface, Logger, ObjectLiteral } from 'typeorm';

import {
  JsailsDataSource,
  type JsailsDataSourceOptions,
} from '../../../src/database/data-source.js';
import { diffSchemaStates } from '../../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../../src/migrations/schema-executor.js';

/** The three databases the framework supports. */
export type MatrixDriver = 'sqlite' | 'mariadb' | 'postgres';

/** Server connection settings for the database suite. */
export interface MatrixServer {
  readonly type: 'mariadb' | 'postgres';
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** The administrative database new databases are created from. */
  readonly database: string;
}

/** Machine-readable reason for a {@link MatrixEnvironmentError}. */
export type MatrixEnvironmentErrorCode = 'invalid_environment';

/**
 * The run's environment does not describe a usable database. The message names
 * the variables involved and never their values, which may be credentials.
 */
export class MatrixEnvironmentError extends Error {
  override readonly name = 'MatrixEnvironmentError';

  constructor(
    readonly code: MatrixEnvironmentErrorCode,
    message: string,
  ) {
    super(message);
  }
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

/** Registers cleanup for the current test or suite (`t`, or `{ after }` from node:test). */
export interface MatrixLifecycle {
  after(callback: () => unknown): void;
}

/**
 * A lifecycle whose callbacks run last-registered first, in one `after` of
 * `lifecycle` (node:test runs `after` callbacks in registration order). A test
 * that creates a database and then connects to it registers the connection's
 * close after the database's removal; this runs them the right way round.
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

/** The database this run targets. */
export function matrixDriver(env: Environment = process.env): MatrixDriver {
  if (env.JSAILS_TEST_SUITE !== 'database') return 'sqlite';
  const type = env.DATABASE_TYPE;
  if (type === 'mariadb' || type === 'postgres') return type;
  throw new MatrixEnvironmentError(
    'invalid_environment',
    'the database suite needs DATABASE_TYPE set to mariadb or postgres',
  );
}

/** The server settings of a database-suite run; throws naming any missing variable. */
export function matrixServer(env: Environment = process.env): MatrixServer {
  const type = matrixDriver(env);
  if (type === 'sqlite') {
    throw new MatrixEnvironmentError('invalid_environment', 'this run uses SQLite, not a server');
  }
  const missing = SERVER_VARIABLES.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) {
    throw new MatrixEnvironmentError(
      'invalid_environment',
      `the ${type} database suite needs ${missing.join(', ')}`,
    );
  }
  const rawPort = env.DATABASE_PORT ?? '';
  const port = rawPort === '' ? DEFAULT_PORTS[type] : Number(rawPort);
  if ((rawPort !== '' && !/^\d+$/.test(rawPort)) || port < 1 || port > 65535) {
    throw new MatrixEnvironmentError('invalid_environment', 'DATABASE_PORT must be a port number');
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

/** A `mysql://` or `postgres://` URL for `database` on the run's server. */
export function serverUrl(server: MatrixServer, database: string): string {
  const scheme = server.type === 'postgres' ? 'postgres' : 'mysql';
  const user = encodeURIComponent(server.username);
  const password = encodeURIComponent(server.password);
  return `${scheme}://${user}:${password}@${server.host}:${server.port}/${encodeURIComponent(database)}`;
}

function quoteIdentifier(server: MatrixServer, name: string): string {
  return server.type === 'postgres' ? `"${name}"` : `\`${name}\``;
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

/** A database of its own for one data source, and how to remove it. */
interface IsolatedDatabase {
  readonly options: JsailsDataSourceOptions;
  dispose(): Promise<void>;
}

async function createNamedServerDatabase(
  server: MatrixServer,
  suffix: string,
): Promise<{ name: string; dispose(): Promise<void> }> {
  if (!/^[a-z0-9]{1,20}$/.test(suffix)) {
    throw new MatrixEnvironmentError(
      'invalid_environment',
      'a database suffix is 1-20 of [a-z0-9]',
    );
  }
  const name = `jsails_m_${randomBytes(6).toString('hex')}_${suffix}`;
  const quoted = quoteIdentifier(server, name);
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
 * Create an empty database on the run's server, named
 * `jsails_m_<random>_<suffix>`, and register its removal with `lifecycle`.
 * Close every connection to it in an earlier `after` callback, or before.
 */
export async function createServerDatabase(
  lifecycle: MatrixLifecycle,
  suffix = 'test',
  env: Environment = process.env,
): Promise<string> {
  const created = await createNamedServerDatabase(matrixServer(env), suffix);
  lifecycle.after(() => created.dispose());
  return created.name;
}

async function isolatedDatabase(
  database: string | undefined,
  env: Environment,
): Promise<IsolatedDatabase> {
  if (matrixDriver(env) === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'jsails-regression-'));
    return {
      options: { type: 'sqljs', location: join(directory, 'regression_test.sqlite') },
      dispose: async () => rmSync(directory, { recursive: true, force: true }),
    };
  }
  const server = matrixServer(env);
  const created =
    database === undefined
      ? await createNamedServerDatabase(server, 'test')
      : { name: database, dispose: async () => undefined };
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

/** Options for {@link openMatrixDataSource}. */
export interface MatrixDataSourceOptions {
  readonly entities: readonly Function[];
  readonly subscribers?: readonly (new () => EntitySubscriberInterface<ObjectLiteral>)[];
  /** Create the entities' tables with the framework's reconciler. Default `true`. */
  readonly migrate?: boolean;
  /** Connect to this existing server database instead of creating one (it is not removed). */
  readonly database?: string;
  /** TypeORM's statement logger (see statement-log.ts). */
  readonly logger?: Logger;
  /** The environment to read; defaults to `process.env`. */
  readonly env?: Environment;
}

/**
 * An initialized data source on a database of its own for this run, with the
 * entities' tables created. When the lifecycle ends it is destroyed and then
 * its database removed (one callback, so the order does not depend on how
 * node:test orders `after` callbacks).
 */
export async function openMatrixDataSource(
  lifecycle: MatrixLifecycle,
  options: MatrixDataSourceOptions,
): Promise<JsailsDataSource> {
  const isolated = await isolatedDatabase(options.database, options.env ?? process.env);
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
    const schema = await dataSource.getModelSchema();
    await executeSchemaPlan(dataSource, diffSchemaStates({ tables: [] }, schema));
  }
  return dataSource;
}
