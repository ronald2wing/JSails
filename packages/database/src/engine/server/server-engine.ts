/**
 * The PostgreSQL and MariaDB engine. TypeORM, with zero entities, zero
 * subscribers and no cache, supplies what it is good at: constructing the
 * driver's pool from the options, and checking connections out and in through
 * query runners. Statements run on the checked-out driver connection itself,
 * because TypeORM's `QueryRunner.query` drops PostgreSQL's command tag (so a
 * read cannot be told from a write) and wraps every failure in an error that
 * carries the parameter values.
 *
 * The engine owns the rest:
 *
 * - The connection budget: a FIFO semaphore the size of the pool, so the
 *   acquire timeout is the engine's and identical on both drivers.
 * - Session settings: UTC on both; the statement timeout as PostgreSQL's
 *   `statement_timeout` connection parameter and as MariaDB's
 *   `max_statement_time`, set once per physical connection.
 * - MariaDB parameters, written into the text by the engine rather than by
 *   mysql2's quoting (see `mariadb-placeholders.ts`).
 * - Value normalisation (see the contract): 64-bit integers as `number` or
 *   `bigint`, temporal and JSON values as text.
 * - Version floors, checked on open.
 * - A pool error listener, always: an idle connection's failure is reported
 *   value-free to `onConnectionError` and never crashes the process.
 */

import type { DataSource, DataSourceOptions, Logger, QueryRunner } from 'typeorm';

import type {
  Conn,
  Dialect,
  Engine,
  IsolationLevel,
  Row,
  SqlValue,
  TransactionConn,
  TransactionOptions,
} from '../contract.js';
import type { DatabaseConfig, ServerConnection, SslOptions } from '../config.js';
import { DatabaseError, isDatabaseError, type DatabaseErrorCode } from '../database-error.js';
import { loadMysql2, loadPg, type PgModule } from '../driver-modules.js';
import { classifyDriverError } from '../error-codes.js';
import { FifoLock } from '../fifo-lock.js';
import { LeasedConn, LeasedTransaction, type LeaseHandle, type RawResult } from '../leased-conn.js';
import { BIND_LIMITS, compileStatement } from '../render.js';
import { isWriteKeyword, leadingKeyword } from '../sql-keyword.js';
import type { CompiledStatement, Statement } from '../statement.js';
import { assertVersionFloor } from '../version-floor.js';
import { bindMariadbParameters } from './mariadb-placeholders.js';

/** Receives failures of connections no caller holds (an idle pooled connection dropping). */
export type ConnectionErrorListener = (error: DatabaseError) => void;

/** Options for {@link openServerEngine} beyond the config. */
export interface ServerEngineOptions {
  /** The connection to open instead of `config.connection` (the migration connection). */
  readonly connection?: ServerConnection;
  readonly onConnectionError?: ConnectionErrorListener;
}

type ServerDialect = Exclude<Dialect, 'sqlite'>;

/** PostgreSQL type OIDs returned as the server's text instead of parsed. */
const PG_TEXT_OIDS: ReadonlySet<number> = new Set([
  114, // json
  3802, // jsonb
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1266, // timetz
  1186, // interval
]);
const PG_INT8_OID = 20;

/** A decimal integer string as `number` when safe, else `bigint`. */
function integerFromText(text: string): number | bigint {
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : BigInt(text);
}

function pgTypes(pg: PgModule): PgModule['types'] {
  return {
    getTypeParser(oid: number, format?: string) {
      if (format !== 'binary') {
        if (oid === PG_INT8_OID) return integerFromText;
        if (PG_TEXT_OIDS.has(oid)) return (text: string) => text;
      }
      return pg.types.getTypeParser(oid, format);
    },
  };
}

/** mysql2's field descriptor, as its `typeCast` hook sees it. */
interface Mysql2Field {
  readonly type: string;
  string(): string | null;
}

function mysqlTypeCast(field: Mysql2Field, next: () => unknown): unknown {
  if (field.type === 'LONGLONG') {
    const text = field.string();
    return text === null ? null : integerFromText(text);
  }
  return next();
}

function tlsOptions(ssl: SslOptions | false): false | { rejectUnauthorized: boolean; ca?: string } {
  if (ssl === false) return false;
  const rejectUnauthorized = ssl.mode === 'verify';
  return ssl.ca === undefined ? { rejectUnauthorized } : { rejectUnauthorized, ca: ssl.ca };
}

/** TypeORM's logger, reduced to the one call that matters: a dropped connection. */
function connectionLogger(listener: ConnectionErrorListener): Logger {
  const ignore = (): void => {
    // Statements are recorded by the engine's own ledger, not TypeORM's logger.
  };
  return {
    logQuery: ignore,
    logQueryError: ignore,
    logQuerySlow: ignore,
    logSchemaBuild: ignore,
    logMigration: ignore,
    log(level) {
      // TypeORM's warnings here are connection errors; its text is not
      // passed on, as a driver message may quote input.
      if (level === 'warn') listener(new DatabaseError('connection_failed'));
    },
  };
}

function defaultConnectionErrorListener(error: DatabaseError): void {
  process.emitWarning(error.message, { type: 'DatabaseWarning', code: error.code });
}

/** The driver connection a query runner checked out. */
interface PgClient {
  query(config: { text: string; values: unknown[] }): Promise<PgQueryResult | PgQueryResult[]>;
}
interface PgQueryResult {
  readonly rows: Row[];
  readonly rowCount: number | null;
  readonly command: string;
}
interface MysqlConnection {
  query(
    sql: string,
    values: unknown[] | undefined,
    callback: (error: unknown, result: unknown) => void,
  ): void;
  destroy(): void;
}
interface MysqlHeader {
  readonly affectedRows: number;
  readonly insertId: number | string;
}

/** TypeORM's PostgreSQL runner can release with an error, which makes pg-pool destroy the client. */
interface PgRunner extends QueryRunner {
  releasePostgresConnection?(error?: Error): Promise<void>;
}

/** Refusals raised by the engine itself before a statement reached the server. */
const ENGINE_CODES: ReadonlySet<DatabaseErrorCode> = new Set([
  'closed',
  'invalid_statement',
  'invalid_parameter',
]);

const PG_WRITE_COMMANDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** PostgreSQL's parameters: pg sends a `Buffer` as bytea, not a plain `Uint8Array`. */
function bindValues(params: readonly SqlValue[]): unknown[] {
  return params.map((value) =>
    value instanceof Uint8Array && !Buffer.isBuffer(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value,
  );
}

async function runPg(
  client: PgClient,
  sql: string,
  params: readonly SqlValue[],
): Promise<RawResult> {
  let result: PgQueryResult | PgQueryResult[];
  try {
    result = await client.query({ text: sql, values: bindValues(params) });
  } catch (error) {
    throw classifyDriverError(error, 'postgres');
  }
  const last = Array.isArray(result) ? result[result.length - 1] : result;
  if (last === undefined) return { rows: [], affected: 0 };
  const affected = PG_WRITE_COMMANDS.has(last.command) ? (last.rowCount ?? 0) : 0;
  return { rows: last.rows, affected, command: last.command };
}

function runMysql(
  connection: MysqlConnection,
  sql: string,
  params: readonly SqlValue[],
): Promise<RawResult> {
  let text: string;
  try {
    text = bindMariadbParameters(sql, params);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<RawResult>((resolve, reject) => {
    // No values go to mysql2: the engine has written them into the text.
    connection.query(text, undefined, (error, result) => {
      if (error !== null && error !== undefined) {
        reject(classifyDriverError(error, 'mariadb'));
        return;
      }
      if (Array.isArray(result)) {
        // A result set: a read, or a write with RETURNING (one row per row written).
        const rows = result as Row[];
        resolve({ rows, affected: isWriteKeyword(leadingKeyword(sql)) ? rows.length : 0 });
        return;
      }
      // An OK packet counts exactly what its statement wrote (0 for DDL); the
      // keyword only decides whether insertId belongs to this statement.
      const header = result as MysqlHeader;
      const keyword = leadingKeyword(sql);
      const insertId =
        (keyword === 'INSERT' || keyword === 'REPLACE') &&
        header.affectedRows > 0 &&
        header.insertId !== 0
          ? integerFromText(String(header.insertId))
          : undefined;
      resolve(
        insertId === undefined
          ? { rows: [], affected: header.affectedRows }
          : { rows: [], affected: header.affectedRows, insertId },
      );
    });
  });
}

const ISOLATION_SQL: Readonly<Record<IsolationLevel, string>> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

/** One checked-out connection. */
interface Checkout {
  readonly runner: PgRunner;
  readonly connection: PgClient | MysqlConnection;
  ended: boolean;
  /** Set when a failure left the session state unknown. */
  broken: boolean;
}

class ServerEngine implements Engine {
  readonly bindLimit: number;
  readonly #lock: FifoLock;
  readonly #checkouts = new Set<Checkout>();
  readonly #configured = new WeakSet<object>();
  #closed = false;
  #closing: Promise<void> | undefined;
  #serverVersion = '';

  constructor(
    readonly dialect: ServerDialect,
    private readonly dataSource: DataSource,
    private readonly config: DatabaseConfig,
  ) {
    this.bindLimit = BIND_LIMITS[dialect];
    this.#lock = new FifoLock(config.pool.max);
  }

  get serverVersion(): string {
    return this.#serverVersion;
  }

  compile(statement: Statement): CompiledStatement {
    return compileStatement(statement, this.dialect);
  }

  async #run(checkout: Checkout, sql: string, params: readonly SqlValue[]): Promise<RawResult> {
    if (this.#closed) throw new DatabaseError('closed');
    try {
      return await (this.dialect === 'postgres'
        ? runPg(checkout.connection as PgClient, sql, params)
        : runMysql(checkout.connection as MysqlConnection, sql, params));
    } catch (error) {
      // A failure the server did not answer with its own code (a dropped
      // socket, a client-side fault) leaves the session in an unknown state:
      // the connection is destroyed at release instead of pooled.
      if (
        isDatabaseError(error) &&
        (error.code === 'connection_failed' ||
          (error.driverCode === undefined && !ENGINE_CODES.has(error.code)))
      ) {
        checkout.broken = true;
      }
      throw error;
    }
  }

  /** Session settings MariaDB has no connection parameter for, once per physical connection. */
  async #configure(checkout: Checkout): Promise<void> {
    if (this.dialect !== 'mariadb' || this.#configured.has(checkout.connection)) return;
    const seconds = this.config.statementTimeoutMs / 1000;
    await this.#run(
      checkout,
      `SET SESSION time_zone = '+00:00', max_statement_time = ${seconds.toFixed(3)}`,
      [],
    );
    this.#configured.add(checkout.connection);
  }

  async #checkout(): Promise<Checkout> {
    if (this.#closed) throw new DatabaseError('closed');
    await this.#lock.acquire(this.config.acquireTimeoutMs);
    const runner = this.dataSource.createQueryRunner('master') as PgRunner;
    let connection: PgClient | MysqlConnection;
    try {
      connection = (await runner.connect()) as PgClient | MysqlConnection;
    } catch (error) {
      this.#lock.release();
      throw classifyDriverError(error, this.dialect, 'connect');
    }
    const checkout: Checkout = { runner, connection, ended: false, broken: false };
    this.#checkouts.add(checkout);
    try {
      await this.#configure(checkout);
    } catch (error) {
      await this.#end(checkout, true);
      throw error;
    }
    return checkout;
  }

  async #end(checkout: Checkout, discard: boolean): Promise<void> {
    if (checkout.ended) return;
    checkout.ended = true;
    this.#checkouts.delete(checkout);
    try {
      if (discard || checkout.broken) await this.#discard(checkout);
      else await checkout.runner.release();
    } finally {
      this.#lock.release();
    }
  }

  /** Destroy the physical connection instead of returning it to the pool. */
  async #discard(checkout: Checkout): Promise<void> {
    if (this.dialect === 'postgres' && checkout.runner.releasePostgresConnection !== undefined) {
      await checkout.runner.releasePostgresConnection(new Error('connection discarded'));
      return;
    }
    // mysql2 removes a destroyed connection from its pool; the runner's
    // release then finds no pool to return it to.
    (checkout.connection as MysqlConnection).destroy();
    await checkout.runner.release();
  }

  #handle(checkout: Checkout): LeaseHandle {
    return {
      run: (sql, params) => this.#run(checkout, sql, params),
      end: (discard) => this.#end(checkout, discard),
    };
  }

  /**
   * MariaDB rolls back a deadlock victim's whole transaction and runs what
   * follows in autocommit mode; ask the session whether it is still inside
   * one. PostgreSQL enforces the abort itself.
   */
  #transactionHandle(checkout: Checkout): LeaseHandle {
    const handle = this.#handle(checkout);
    if (this.dialect !== 'mariadb') return handle;
    return {
      ...handle,
      transactionLost: async () => {
        const { rows } = await this.#run(checkout, 'SELECT @@in_transaction AS open', []);
        return Number(rows[0]?.open) !== 1;
      },
    };
  }

  async lease(): Promise<Conn> {
    return new LeasedConn(this.dialect, this.#handle(await this.#checkout()));
  }

  async begin(options: TransactionOptions = {}): Promise<TransactionConn> {
    const isolation =
      options.isolation === undefined ? undefined : ISOLATION_SQL[options.isolation];
    if (options.isolation !== undefined && isolation === undefined) {
      throw new DatabaseError('invalid_statement', { field: 'isolation' });
    }
    const checkout = await this.#checkout();
    const access = options.readOnly === true ? 'READ ONLY' : 'READ WRITE';
    try {
      if (this.dialect === 'postgres') {
        const level = isolation === undefined ? '' : ` ISOLATION LEVEL ${isolation}`;
        await this.#run(checkout, `BEGIN${level} ${access}`, []);
      } else {
        if (isolation !== undefined) {
          await this.#run(checkout, `SET TRANSACTION ISOLATION LEVEL ${isolation}`, []);
        }
        await this.#run(checkout, `START TRANSACTION ${access}`, []);
      }
    } catch (error) {
      await this.#end(checkout, true);
      throw error;
    }
    return new LeasedTransaction(this.dialect, this.#transactionHandle(checkout));
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#lock.close();
    // A checked-out connection would keep the pool's end waiting; destroy it
    // (the server rolls back its open transaction).
    await Promise.all([...this.#checkouts].map((checkout) => this.#end(checkout, true)));
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }

  /** Read the server version and check it against the floor. */
  async verifyVersion(): Promise<void> {
    const conn = await this.lease();
    try {
      const sql =
        this.dialect === 'postgres' ? 'SHOW server_version' : 'SELECT VERSION() AS server_version';
      const { rows } = await conn.query(sql, [], { origin: 'engine' });
      this.#serverVersion = String(rows[0]?.server_version ?? '');
    } finally {
      await conn.release();
    }
    assertVersionFloor(this.dialect, this.#serverVersion);
  }
}

function dataSourceOptions(
  dialect: ServerDialect,
  config: DatabaseConfig,
  connection: ServerConnection,
  listener: ConnectionErrorListener,
): DataSourceOptions {
  const common = {
    host: connection.host,
    port: connection.port,
    username: connection.user,
    password: connection.password,
    database: connection.database,
    ssl: tlsOptions(connection.ssl),
    poolSize: config.pool.max,
    entities: [],
    subscribers: [],
    migrations: [],
    synchronize: false,
    migrationsRun: false,
    logging: false,
    logger: connectionLogger(listener),
  };
  if (dialect === 'postgres') {
    const pg = loadPg();
    return {
      ...common,
      type: 'postgres',
      driver: pg,
      applicationName: 'jsails',
      connectTimeoutMS: config.connectTimeoutMs,
      poolErrorHandler: (error: unknown) =>
        listener(classifyDriverError(error, 'postgres', 'connect')),
      extra: {
        options: '-c TimeZone=UTC',
        types: pgTypes(pg),
        ...(config.statementTimeoutMs > 0 ? { statement_timeout: config.statementTimeoutMs } : {}),
      },
    };
  }
  return {
    ...common,
    type: 'mariadb',
    driver: loadMysql2(),
    connectTimeout: config.connectTimeoutMs,
    extra: {
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      typeCast: mysqlTypeCast,
    },
  };
}

/** Open a PostgreSQL or MariaDB engine for `config`. */
export async function openServerEngine(
  config: DatabaseConfig,
  options: ServerEngineOptions = {},
): Promise<Engine> {
  const connection = options.connection ?? config.connection;
  if (config.dialect === 'sqlite' || connection === undefined) {
    throw new DatabaseError('invalid_config', { field: 'connection' });
  }
  const listener = options.onConnectionError ?? defaultConnectionErrorListener;
  const { DataSource } = await import('typeorm');
  const dataSource = new DataSource(
    dataSourceOptions(config.dialect, config, connection, listener),
  );
  try {
    await dataSource.initialize();
  } catch (error) {
    if (dataSource.isInitialized) await dataSource.destroy();
    throw classifyDriverError(error, config.dialect, 'connect');
  }
  const engine = new ServerEngine(config.dialect, dataSource, config);
  try {
    await engine.verifyVersion();
  } catch (error) {
    await engine.close();
    throw error;
  }
  return engine;
}
