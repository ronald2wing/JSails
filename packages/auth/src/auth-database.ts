/**
 * Database selection for the `auth` plugin's Better Auth instance.
 *
 * {@link resolveAuthDatabase} turns the app's database configuration into one
 * of three dialects without opening anything: an explicit
 * {@link AuthDatabaseConfig}, the options of a `JsailsDataSource` (anything
 * carrying `options`), or, when neither is given, the `DATABASE_*` environment
 * variables exactly as before (`DATABASE_TYPE` `mariadb`/`mysql`, now also
 * `postgres`). {@link openAuthDatabase} then builds the value Better Auth's
 * `database` option takes plus a `destroy` that releases it:
 *
 * - `mysql` — a Kysely `MysqlDialect` over a bounded `mysql2` pool (the
 *   historical MariaDB path, unchanged);
 * - `postgres` — a Kysely `PostgresDialect` over a `pg` pool. `pg` is an
 *   optional peer: JSails' own postgres support already installs it, and a
 *   missing copy fails with a value-free `missing_driver` error naming it;
 * - `sqlite` — a `node:sqlite` `DatabaseSync` on its own file, which Better
 *   Auth wraps in its built-in dialect.
 *
 * A `sqljs` data source is refused rather than shared: TypeORM's sqljs driver
 * holds the whole database in memory and rewrites the file on every commit, so
 * a second writer to the same file would lose one side's writes.
 *
 * Only the connection fields are taken from a data source: postgres `schema`,
 * `extra`, `replication`, and pool settings do not carry over, so the auth
 * tables use the connection's default schema and the auth pool its own sizing.
 *
 * Pools connect lazily (mysql2 and pg open no socket until the first query);
 * only the SQLite path opens its file at construction.
 */

import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import { Kysely, MysqlDialect, PostgresDialect, type PostgresPool } from 'kysely';
import { createPool, type PoolOptions } from 'mysql2';

import type { BetterAuthOptions } from 'better-auth';

import { AuthInstanceError } from './instance-error.js';

/** The server databases the auth instance can reach over a connection pool. */
export type AuthServerDatabaseType = 'mariadb' | 'mysql' | 'postgres';

/**
 * Connection settings for a server database, named as `JsailsDataSource`
 * (TypeORM) names them, so a data source's options can be passed as they are.
 */
export interface AuthServerDatabaseConfig {
  readonly type: AuthServerDatabaseType;
  /**
   * A connection URL. It is exclusive with `host`, `port`, `username`,
   * `password`, and `database`: mysql2 lets those fields override the URL and
   * pg lets the URL override them, so a mix is refused rather than resolved
   * differently per driver.
   */
  readonly url?: string;
  readonly host?: string;
  /** Defaults to 3306 for mariadb/mysql and 5432 for postgres. */
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
  readonly database?: string;
  /**
   * TLS: `true` for the driver's verified defaults, or driver TLS options. On
   * mariadb/mysql a string names a mysql2 TLS profile (e.g. `'Amazon RDS'`).
   */
  readonly ssl?: boolean | string | Readonly<Record<string, unknown>>;
}

/** A SQLite file the auth tables live in, opened through `node:sqlite`. */
export interface AuthSqliteDatabaseConfig {
  readonly type: 'sqlite';
  /** The database file path (`:memory:` for an in-memory database). */
  readonly location: string;
}

/** An explicit auth database configuration. */
export type AuthDatabaseConfig = AuthServerDatabaseConfig | AuthSqliteDatabaseConfig;

/** A `JsailsDataSource`, or anything else carrying its connection options. */
export interface AuthDataSourceLike {
  readonly options: object;
}

/** Where the auth instance takes its connection from (see {@link resolveAuthDatabase}). */
export type AuthDatabaseSource = AuthDatabaseConfig | AuthDataSourceLike;

/** Server connection settings after validation and defaults. */
export interface AuthServerConnection {
  readonly url?: string;
  readonly host?: string;
  /** Unset with a `url`, so the port in the URL (or the driver default) applies. */
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
  /** A string (a mysql2 TLS profile name) only on the mysql dialect. */
  readonly ssl?: boolean | string | Readonly<Record<string, unknown>>;
}

/** The dialect and settings {@link openAuthDatabase} builds from. */
export type ResolvedAuthDatabase =
  | { readonly dialect: 'mysql'; readonly connection: AuthServerConnection }
  | { readonly dialect: 'postgres'; readonly connection: AuthServerConnection }
  | { readonly dialect: 'sqlite'; readonly location: string };

/** Pool sizing for the server dialects (see `authPoolSizing`). */
export interface AuthPoolSizing {
  readonly connectionLimit: number;
  readonly queueLimit: number;
}

/** What {@link openAuthDatabase} returns: Better Auth's `database` value and its release. */
export interface OpenedAuthDatabase {
  readonly database: NonNullable<BetterAuthOptions['database']>;
  readonly destroy: () => Promise<void>;
}

const DEFAULT_PORTS: Readonly<Record<'mysql' | 'postgres', number>> = {
  mysql: 3306,
  postgres: 5432,
};

const ENV_DIALECTS: Readonly<Record<string, 'mysql' | 'postgres'>> = {
  mariadb: 'mysql',
  mysql: 'mysql',
  postgres: 'postgres',
};

type Environment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidField(field: string): AuthInstanceError {
  return new AuthInstanceError('invalid_database', `auth database config has an invalid ${field}`);
}

function optionalString(
  config: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = config[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw invalidField(field);
  }
  return value;
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Normalize an explicit server config; values are checked by type only and never echoed. */
function serverConnection(
  config: Readonly<Record<string, unknown>>,
  dialect: 'mysql' | 'postgres',
): AuthServerConnection {
  const url = optionalString(config, 'url');
  // Both drivers parse the URL themselves, and Node's URL error carries the
  // whole DSN as `input`; checking here keeps the credential out of any error.
  if (url !== undefined && !URL.canParse(url)) {
    throw invalidField('url');
  }
  const host = optionalString(config, 'host');
  const user = optionalString(config, 'username');
  const database = optionalString(config, 'database');
  const passwordValue = config.password;
  if (passwordValue !== undefined && passwordValue !== null && typeof passwordValue !== 'string') {
    throw invalidField('password');
  }
  if (url !== undefined) {
    for (const field of ['host', 'port', 'username', 'password', 'database']) {
      const value = config[field];
      if (value !== undefined && value !== null) {
        throw new AuthInstanceError(
          'invalid_database',
          `auth database config sets both url and ${field}; use one or the other`,
        );
      }
    }
  } else {
    for (const [field, value] of [
      ['host', host],
      ['username', user],
      ['database', database],
    ] as const) {
      if (value === undefined) {
        throw new AuthInstanceError(
          'invalid_database',
          `auth database config requires ${field} (or url)`,
        );
      }
    }
  }
  const portValue = config.port;
  // With a URL no port is filled in: mysql2 ignores the URL's port whenever a
  // `port` option is set, so a default here would override `h:3307`.
  let port: number | undefined = url === undefined ? DEFAULT_PORTS[dialect] : undefined;
  if (portValue !== undefined && portValue !== null) {
    if (typeof portValue !== 'number' || !validPort(portValue)) {
      throw invalidField('port');
    }
    port = portValue;
  }
  const ssl = config.ssl;
  const sslProfile = dialect === 'mysql' && typeof ssl === 'string' && ssl !== '';
  if (
    ssl !== undefined &&
    ssl !== null &&
    typeof ssl !== 'boolean' &&
    !isRecord(ssl) &&
    !sslProfile
  ) {
    throw invalidField('ssl');
  }
  return {
    ...(port !== undefined ? { port } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(typeof passwordValue === 'string' ? { password: passwordValue } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(typeof ssl === 'boolean' || typeof ssl === 'string' || isRecord(ssl) ? { ssl } : {}),
  };
}

/** Normalize an explicit config or data source options by its `type`. */
function resolveConfig(config: Readonly<Record<string, unknown>>): ResolvedAuthDatabase {
  const type = config.type;
  if (type === 'sqljs') {
    throw new AuthInstanceError(
      'unsupported_database',
      "@jsails/auth cannot share a sqljs data source file; pass database: { type: 'sqlite', location } with a file of its own",
    );
  }
  if (type === 'sqlite') {
    const location = optionalString(config, 'location');
    if (location === undefined) {
      throw new AuthInstanceError('invalid_database', 'auth database config requires location');
    }
    return { dialect: 'sqlite', location };
  }
  const dialect = typeof type === 'string' ? ENV_DIALECTS[type] : undefined;
  if (dialect === undefined) {
    throw new AuthInstanceError(
      'unsupported_database',
      '@jsails/auth supports database type mariadb, mysql, postgres, or sqlite only',
    );
  }
  return { dialect, connection: serverConnection(config, dialect) };
}

/** Read a required connection variable; a missing one is named, never its value. */
function requireEnv(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new AuthInstanceError('missing_env', `missing required environment variable ${name}`);
  }
  return value;
}

/** Read `DATABASE_PORT`, defaulting per dialect; a bad value is refused without echoing it. */
function envPort(env: Environment, dialect: 'mysql' | 'postgres'): number {
  const raw = env.DATABASE_PORT;
  if (raw === undefined || raw === '') {
    return DEFAULT_PORTS[dialect];
  }
  const port = Number(raw);
  if (!validPort(port)) {
    throw new AuthInstanceError(
      'invalid_env',
      'DATABASE_PORT must be an integer between 1 and 65535',
    );
  }
  return port;
}

/** The environment path: the `DATABASE_*` variables `readDatabaseEnvironment` also reads. */
function resolveEnvironment(env: Environment): ResolvedAuthDatabase {
  const type = env.DATABASE_TYPE;
  const dialect = type === undefined || type === '' ? 'mysql' : ENV_DIALECTS[type];
  if (dialect === undefined) {
    throw new AuthInstanceError(
      'unsupported_database',
      '@jsails/auth supports DATABASE_TYPE mariadb, mysql, or postgres only',
    );
  }
  return {
    dialect,
    connection: {
      host: requireEnv(env, 'DATABASE_HOST'),
      user: requireEnv(env, 'DATABASE_USER'),
      password: requireEnv(env, 'DATABASE_PASSWORD'),
      database: requireEnv(env, 'DATABASE_NAME'),
      port: envPort(env, dialect),
    },
  };
}

/**
 * Pick the auth dialect and connection settings. An explicit config or a data
 * source's options win; with neither, the `DATABASE_*` variables are read from
 * `env`. Nothing is opened. Every failure is a value-free
 * {@link AuthInstanceError}.
 */
export function resolveAuthDatabase(
  source: AuthDatabaseSource | undefined,
  env: Environment = process.env,
): ResolvedAuthDatabase {
  if (source === undefined) {
    return resolveEnvironment(env);
  }
  if (!isRecord(source)) {
    throw new AuthInstanceError('invalid_database', 'auth database config must be an object');
  }
  if ('type' in source) {
    return resolveConfig(source);
  }
  if (isRecord(source.options)) {
    return resolveConfig(source.options);
  }
  throw new AuthInstanceError(
    'invalid_database',
    'auth database must be a config with a type or a data source with options',
  );
}

/** The slice of the `pg` module a pool needs. */
interface PgModule {
  readonly Pool: new (config: Readonly<Record<string, unknown>>) => PostgresPool;
}

/** Loads the `pg` module synchronously; replaceable so tests can simulate its absence. */
export type PostgresDriverLoader = () => unknown;

const require = createRequire(import.meta.url);

const requirePg: PostgresDriverLoader = () => require('pg');

/**
 * Load the `pg` driver synchronously (construction is synchronous). A missing
 * or unusable copy is reported by package name only.
 */
export function loadPostgresDriver(load: PostgresDriverLoader = requirePg): PgModule {
  let loaded: unknown;
  try {
    loaded = load();
  } catch {
    loaded = undefined;
  }
  if (!isRecord(loaded) || typeof loaded.Pool !== 'function') {
    throw new AuthInstanceError(
      'missing_driver',
      '@jsails/auth needs the pg package for a postgres database; install pg',
    );
  }
  return loaded as unknown as PgModule;
}

/** The mysql2 pool options for a resolved connection (exported for its tests). */
export function mysqlPoolOptions(
  connection: AuthServerConnection,
  sizing: AuthPoolSizing,
): PoolOptions {
  const { ssl } = connection;
  return {
    ...sizing,
    ...(connection.url !== undefined ? { uri: connection.url } : {}),
    host: connection.host,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    ...(connection.port !== undefined ? { port: connection.port } : {}),
    // mysql2 takes TLS options or a profile name, not a boolean: `{}` enables
    // TLS with certificate verification on.
    ...(ssl === true ? { ssl: {} } : typeof ssl === 'string' || isRecord(ssl) ? { ssl } : {}),
  };
}

function postgresPool(
  connection: AuthServerConnection,
  sizing: AuthPoolSizing,
): Readonly<Record<string, unknown>> {
  // pg has no wait-queue bound; `connectionLimit` maps to its `max`.
  return {
    max: sizing.connectionLimit,
    ...(connection.url !== undefined ? { connectionString: connection.url } : {}),
    ...(connection.host !== undefined ? { host: connection.host } : {}),
    ...(connection.user !== undefined ? { user: connection.user } : {}),
    ...(connection.password !== undefined ? { password: connection.password } : {}),
    ...(connection.database !== undefined ? { database: connection.database } : {}),
    ...(connection.port !== undefined ? { port: connection.port } : {}),
    ...(connection.ssl !== undefined ? { ssl: connection.ssl } : {}),
  };
}

/**
 * Construct a driver pool. A driver that rejects its options can throw an
 * error carrying them (Node's URL error holds the DSN as `input`), so it is
 * replaced by a value-free one with no `cause`.
 */
function configurePool<T>(construct: () => T): T {
  try {
    return construct();
  } catch {
    throw new AuthInstanceError('invalid_database', 'failed to configure the auth database pool');
  }
}

/** Open (or, for SQLite, create) the auth database for Better Auth. */
export function openAuthDatabase(
  resolved: ResolvedAuthDatabase,
  sizing: AuthPoolSizing,
  load: PostgresDriverLoader = requirePg,
): OpenedAuthDatabase {
  switch (resolved.dialect) {
    case 'mysql': {
      const pool = configurePool(() => createPool(mysqlPoolOptions(resolved.connection, sizing)));
      const db = new Kysely({ dialect: new MysqlDialect({ pool }) });
      // Better Auth rejects a bare Kysely instance; it must carry its type.
      return { database: { db, type: 'mysql' }, destroy: () => db.destroy() };
    }
    case 'postgres': {
      const { Pool } = loadPostgresDriver(load);
      const pool = configurePool(() => new Pool(postgresPool(resolved.connection, sizing)));
      const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
      return { database: { db, type: 'postgres' }, destroy: () => db.destroy() };
    }
    case 'sqlite': {
      let sqlite: DatabaseSync;
      try {
        sqlite = new DatabaseSync(resolved.location);
      } catch {
        // The driver's message carries the path; report the failure without it.
        throw new AuthInstanceError('invalid_database', 'failed to open the auth SQLite database');
      }
      return {
        database: sqlite,
        destroy: () => {
          if (sqlite.isOpen) {
            sqlite.close();
          }
          return Promise.resolve();
        },
      };
    }
  }
}
