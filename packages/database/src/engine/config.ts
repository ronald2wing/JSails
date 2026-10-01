/**
 * The options schema of the `database()` plugin and its resolution into the
 * {@link DatabaseConfig} an engine opens. It is not an app-config key: the
 * plugin (DAT-07) takes these options and hands the resolved config to
 * {@link createEngine}.
 *
 * Secrets come from the environment only, from three fixed variables the
 * plugin declares: `DATABASE_URL` (the connection URL), `DATABASE_PASSWORD`
 * (the password of a URL or fields without one) and `DATABASE_MIGRATION_URL`
 * (a direct connection for schema changes). Their names are not options: a
 * plugin's environment is a static declaration the kernel parses and tooling
 * reads. Options are code, committed with the app, and may carry a URL
 * without a password; a URL in the options that embeds one is refused. A URL
 * in the environment wins over the options, so an app can default to a SQLite
 * file in code and select MariaDB or PostgreSQL per deployment. The caller
 * passes the environment: nothing here reads `process.env`.
 *
 * URLs: `postgres://` or `postgresql://`; `mariadb://` (or `mysql://`, which
 * is the same wire protocol: the engine refuses a server that is not MariaDB
 * when it opens); `sqlite:<path>` or `sqlite::memory:`. The one query
 * parameter accepted is `sslmode` (`disable`, `require`, `verify-full`).
 * Every error is value-free: it names the option or variable, never its value.
 */

import { isAbsolute, resolve } from 'node:path';

import type { Dialect } from './contract.js';
import { DatabaseError } from './database-error.js';

/** TLS for a server connection: encrypted only, or encrypted and verified. */
export type SslMode = 'require' | 'verify';

/** TLS settings for a server connection. */
export interface SslOptions {
  readonly mode: SslMode;
  /** A PEM certificate authority to verify against, instead of the system store. */
  readonly ca?: string;
}

/** The options of the `database()` plugin. */
export interface DatabaseOptions {
  /** A connection URL without a password, used when `DATABASE_URL` is unset. */
  readonly url?: string;
  /** With `host`, `port`, `user` and `database`: a server named field by field. */
  readonly dialect?: Dialect;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly database?: string;
  /** A SQLite database file (relative to the app root), or `:memory:`. */
  readonly file?: string;
  /** TLS for a server: `false`, a mode, or a mode with a certificate authority. */
  readonly ssl?: false | SslMode | SslOptions;
  readonly pool?: {
    /** Connections per server engine. Default 10. */
    readonly max?: number;
  };
  /** How long `lease()`/`begin()` wait for a connection. Default 10000; 0 waits forever. */
  readonly acquireTimeoutMs?: number;
  /**
   * The server cancels a statement running longer. Default 30000; 0 disables.
   * SQLite statements run synchronously and cannot be cancelled; it has none.
   */
  readonly statementTimeoutMs?: number;
  /** How long opening a server connection may take. Default 10000. */
  readonly connectTimeoutMs?: number;
  /** How long SQLite retries a write while another process holds the file. Default 5000. */
  readonly busyTimeoutMs?: number;
}

/** The variables {@link resolveDatabaseConfig} reads, as the `database()` plugin declares them. */
export const DATABASE_ENV: {
  /** The connection URL; wins over the options. */
  readonly url: 'DATABASE_URL';
  /** The password of a URL or server fields that carry none. */
  readonly password: 'DATABASE_PASSWORD';
  /** The URL schema changes run on (past any transaction pooler); the main connection when unset. */
  readonly migrationUrl: 'DATABASE_MIGRATION_URL';
} = Object.freeze({
  url: 'DATABASE_URL',
  password: 'DATABASE_PASSWORD',
  migrationUrl: 'DATABASE_MIGRATION_URL',
});

/** A resolved server connection. Its password is not enumerable, so it never prints. */
export interface ServerConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password: string | undefined;
  readonly ssl: SslOptions | false;
}

/** The resolved, frozen configuration an engine opens. */
export interface DatabaseConfig {
  readonly dialect: Dialect;
  /** The SQLite file, absolute, or `:memory:`; only for `sqlite`. */
  readonly file?: string;
  /** The server connection; only for `postgres` and `mariadb`. */
  readonly connection?: ServerConnection;
  /** The schema-change connection, when one is configured. */
  readonly migration?: ServerConnection;
  readonly pool: { readonly max: number };
  readonly acquireTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly busyTimeoutMs: number;
}

/** Where {@link resolveDatabaseConfig} reads the environment and resolves paths. */
export interface ResolveDatabaseConfigContext {
  /** The environment: the plugin's validated variables, or a test's own. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The app root a relative SQLite path resolves against. Default: the working directory. */
  readonly root?: string;
}

/** The in-memory SQLite database. */
export const MEMORY_DATABASE = ':memory:';

const DEFAULTS = Object.freeze({
  poolMax: 10,
  acquireTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
  busyTimeoutMs: 5_000,
});

const DEFAULT_PORTS: Readonly<Record<'postgres' | 'mariadb', number>> = {
  postgres: 5432,
  mariadb: 3306,
};

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'url',
  'dialect',
  'host',
  'port',
  'user',
  'database',
  'file',
  'ssl',
  'pool',
  'acquireTimeoutMs',
  'statementTimeoutMs',
  'connectTimeoutMs',
  'busyTimeoutMs',
]);

const SERVER_FIELDS = ['host', 'port', 'user', 'database'] as const;

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function invalid(field: string, suggestion?: string): DatabaseError {
  return new DatabaseError(
    'invalid_config',
    suggestion === undefined ? { field } : { field, suggestion },
  );
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(field);
  return value;
}

function integer(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(field);
  }
  return value;
}

function sslOption(value: unknown): SslOptions | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (value === 'require' || value === 'verify') return Object.freeze({ mode: value });
  if (typeof value === 'object' && value !== null) {
    const { mode, ca, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || (mode !== 'require' && mode !== 'verify')) {
      throw invalid('ssl');
    }
    const caText = optionalString(ca, 'ssl.ca');
    return Object.freeze(caText === undefined ? { mode } : { mode, ca: caText });
  }
  throw invalid('ssl');
}

function serverConnection(
  fields: Omit<ServerConnection, 'password'>,
  password: string | undefined,
): ServerConnection {
  const connection = { ...fields };
  Object.defineProperty(connection, 'password', { value: password, enumerable: false });
  return Object.freeze(connection) as ServerConnection;
}

/** A parsed connection URL. */
type ParsedUrl =
  | { readonly dialect: 'sqlite'; readonly file: string }
  | {
      readonly dialect: 'postgres' | 'mariadb';
      readonly host: string;
      readonly port: number;
      readonly user: string;
      readonly database: string;
      readonly password: string | undefined;
      readonly ssl: SslOptions | false | undefined;
    };

function parseUrl(text: string, field: string): ParsedUrl {
  if (text.startsWith('sqlite:')) {
    let file = text.slice('sqlite:'.length);
    if (file.startsWith('//')) {
      // `sqlite:///abs/path` (or `sqlite:///C:/path`); `sqlite://name` would
      // read a host, which a file has none of.
      if (!file.startsWith('///')) throw invalid(field);
      file = file.slice(2);
      if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1);
    }
    if (file === '' || file === '/') throw invalid(field);
    return { dialect: 'sqlite', file };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // The URL may hold a password, so the parser's message is not passed on.
    throw invalid(field);
  }
  let dialect: 'postgres' | 'mariadb';
  if (url.protocol === 'postgres:' || url.protocol === 'postgresql:') dialect = 'postgres';
  else if (url.protocol === 'mariadb:' || url.protocol === 'mysql:') dialect = 'mariadb';
  else throw invalid(field, 'use a postgres://, mariadb:// or sqlite: URL');
  let ssl: SslOptions | false | undefined;
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode') throw invalid(`${field}.query`);
    if (value === 'disable') ssl = false;
    else if (value === 'require') ssl = Object.freeze({ mode: 'require' });
    else if (value === 'verify-full') ssl = Object.freeze({ mode: 'verify' });
    else throw invalid(`${field}.sslmode`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (url.hostname === '' || database === '' || user === '') throw invalid(field);
  const port = url.port === '' ? DEFAULT_PORTS[dialect] : Number(url.port);
  return {
    dialect,
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    user,
    database,
    password: url.password === '' ? undefined : decodeURIComponent(url.password),
    ssl,
  };
}

/**
 * Resolve `options` against `context.env` into a frozen {@link DatabaseConfig}.
 * A relative SQLite file resolves against `context.root`, the working
 * directory when unset.
 *
 * @throws {DatabaseError} `invalid_config`, naming the option or variable.
 */
export function resolveDatabaseConfig(
  options: DatabaseOptions,
  context: ResolveDatabaseConfigContext,
): DatabaseConfig {
  if (typeof options !== 'object' || options === null) throw invalid('options');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) throw invalid(key);
  }
  if (
    context === null ||
    typeof context !== 'object' ||
    context.env === null ||
    typeof context.env !== 'object'
  ) {
    throw invalid('env');
  }
  const { env } = context;
  const root = context.root ?? process.cwd();
  const urlEnv = DATABASE_ENV.url;
  const passwordEnv = DATABASE_ENV.password;
  const migrationUrlEnv = DATABASE_ENV.migrationUrl;

  const envUrl = env[urlEnv] ?? '';
  const optionUrl = optionalString(options.url, 'url');
  let parsed: ParsedUrl | undefined;
  if (envUrl !== '') {
    parsed = parseUrl(envUrl, urlEnv);
  } else if (optionUrl !== undefined) {
    parsed = parseUrl(optionUrl, 'url');
    if (parsed.dialect !== 'sqlite' && parsed.password !== undefined) {
      throw invalid('url', `move the password to the ${passwordEnv} environment variable`);
    }
  }

  const ssl = sslOption(options.ssl);
  const file = optionalString(options.file, 'file');
  const dialectOption = options.dialect;
  if (
    dialectOption !== undefined &&
    dialectOption !== 'postgres' &&
    dialectOption !== 'mariadb' &&
    dialectOption !== 'sqlite'
  ) {
    throw invalid('dialect');
  }
  // One way to name the database in code: a URL, a file, or server fields.
  const serverField = SERVER_FIELDS.find((key) => options[key] !== undefined);
  if (optionUrl !== undefined && (file !== undefined || serverField !== undefined)) {
    throw invalid(file !== undefined ? 'file' : (serverField as string));
  }
  if (optionUrl !== undefined && dialectOption !== undefined) throw invalid('dialect');
  if (
    file !== undefined &&
    (serverField !== undefined || (dialectOption ?? 'sqlite') !== 'sqlite')
  ) {
    throw invalid(serverField ?? 'dialect');
  }
  if (serverField !== undefined && dialectOption !== 'postgres' && dialectOption !== 'mariadb') {
    throw invalid('dialect', 'name the server dialect: postgres or mariadb');
  }

  const common = {
    pool: Object.freeze({
      max: integer(options.pool?.max, 'pool.max', 1, 1000, DEFAULTS.poolMax),
    }),
    acquireTimeoutMs: integer(
      options.acquireTimeoutMs,
      'acquireTimeoutMs',
      0,
      MAX_TIMEOUT_MS,
      DEFAULTS.acquireTimeoutMs,
    ),
    statementTimeoutMs: integer(
      options.statementTimeoutMs,
      'statementTimeoutMs',
      0,
      MAX_TIMEOUT_MS,
      DEFAULTS.statementTimeoutMs,
    ),
    connectTimeoutMs: integer(
      options.connectTimeoutMs,
      'connectTimeoutMs',
      1,
      MAX_TIMEOUT_MS,
      DEFAULTS.connectTimeoutMs,
    ),
    busyTimeoutMs: integer(
      options.busyTimeoutMs,
      'busyTimeoutMs',
      0,
      MAX_TIMEOUT_MS,
      DEFAULTS.busyTimeoutMs,
    ),
  };
  if (options.pool !== undefined) {
    if (typeof options.pool !== 'object' || options.pool === null) throw invalid('pool');
    for (const key of Object.keys(options.pool)) if (key !== 'max') throw invalid(`pool.${key}`);
  }

  if (parsed === undefined) {
    if (file !== undefined && (dialectOption === undefined || dialectOption === 'sqlite')) {
      parsed = { dialect: 'sqlite', file };
    } else if (dialectOption === 'postgres' || dialectOption === 'mariadb') {
      const host = optionalString(options.host, 'host');
      const user = optionalString(options.user, 'user');
      const database = optionalString(options.database, 'database');
      if (host === undefined) throw invalid('host');
      if (user === undefined) throw invalid('user');
      if (database === undefined) throw invalid('database');
      parsed = {
        dialect: dialectOption,
        host,
        port: integer(options.port, 'port', 1, 65535, DEFAULT_PORTS[dialectOption]),
        user,
        database,
        password: undefined,
        ssl: undefined,
      };
    } else {
      throw invalid(urlEnv, `set ${urlEnv}, or give the database() plugin a url or a file`);
    }
  }

  if (parsed.dialect === 'sqlite') {
    if ((env[migrationUrlEnv] ?? '') !== '') throw invalid(migrationUrlEnv);
    const target =
      parsed.file === MEMORY_DATABASE || isAbsolute(parsed.file)
        ? parsed.file
        : resolve(root, parsed.file);
    return Object.freeze({ dialect: 'sqlite', file: target, ...common });
  }

  const envPassword = env[passwordEnv];
  const password =
    parsed.password ?? (envPassword === undefined || envPassword === '' ? undefined : envPassword);
  const connection = serverConnection(
    {
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      database: parsed.database,
      ssl: parsed.ssl ?? ssl ?? false,
    },
    password,
  );
  const migrationText = env[migrationUrlEnv] ?? '';
  let migration: ServerConnection | undefined;
  if (migrationText !== '') {
    const migrationUrl = parseUrl(migrationText, migrationUrlEnv);
    if (migrationUrl.dialect !== parsed.dialect) throw invalid(migrationUrlEnv);
    migration = serverConnection(
      {
        host: migrationUrl.host,
        port: migrationUrl.port,
        user: migrationUrl.user,
        database: migrationUrl.database,
        ssl: migrationUrl.ssl ?? connection.ssl,
      },
      migrationUrl.password ?? password,
    );
  }
  return Object.freeze({
    dialect: parsed.dialect,
    connection,
    ...(migration === undefined ? {} : { migration }),
    ...common,
  });
}
