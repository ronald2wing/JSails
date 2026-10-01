/**
 * Cross-process schema lock: serializes `db:push` runs against one database.
 *
 * Two deploy instances that push at boot would otherwise introspect the same
 * live schema, compute the same plan, and both execute it; the loser fails on
 * "already exists", and on MySQL/MariaDB (no transactional DDL) it can fail
 * after part of its own plan was applied. {@link withSchemaLock} holds a
 * database-level advisory lock for the whole reconcile → apply → data
 * migration sequence, so the second process waits, then introspects a schema
 * that is already up to date. The plan must therefore be computed inside the
 * callback, never before it.
 *
 * - PostgreSQL: a session-level `pg_try_advisory_lock`, polled until the
 *   timeout (a blocking `pg_advisory_lock` cannot be bounded without changing
 *   the pooled session's `lock_timeout`).
 * - MySQL/MariaDB: `GET_LOCK(name, timeout)`. Those locks are server-wide, so
 *   the name carries a digest of the database name and two databases on one
 *   server do not contend.
 * - SQLite (sql.js): the database lives inside one process, which is already
 *   the single writer; the callback runs directly.
 *
 * The lock is held on a dedicated connection and released (and the connection
 * returned) even when the callback throws; a crashed process loses its
 * session, which releases the lock with it.
 */

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { QueryRunner } from 'typeorm';

import type { SchemaEditorDriver } from './schema-editor.js';
import { MigrationError } from './schema-types.js';

/** Structural contract the lock needs from a data source. */
export interface SchemaLockDataSource {
  readonly isInitialized: boolean;
  readonly jsailsDriver: SchemaEditorDriver;
  readonly options: { readonly database?: unknown };
  createQueryRunner(): QueryRunner;
}

/** Options for {@link withSchemaLock}. */
export interface SchemaLockOptions {
  /** How long to wait for another process's push, in seconds. Default 60. */
  readonly timeoutSeconds?: number;
  /** PostgreSQL polling interval in milliseconds. Default 250. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_POLL_INTERVAL_MS = 250;

/** The PostgreSQL advisory-lock key: the bytes of `jsails` as one integer. */
const POSTGRES_LOCK_KEY = '116963839798387';

/** The MySQL/MariaDB lock name for `database`; at most 64 characters. */
function mysqlLockName(database: unknown): string {
  const digest = createHash('sha256')
    .update(typeof database === 'string' ? database : '')
    .digest('hex')
    .slice(0, 32);
  return `jsails_schema_${digest}`;
}

function timeoutError(): MigrationError {
  return new MigrationError(
    'lock_timeout',
    'timed out waiting for another schema push to finish; retry once it completes',
  );
}

/** Read the single scalar a lock query returns, whatever the driver names it. */
function lockResult(rows: unknown): unknown {
  if (!Array.isArray(rows)) return undefined;
  const first: unknown = rows[0];
  if (first === null || typeof first !== 'object') return undefined;
  return Object.values(first)[0];
}

function isTruthyLockValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 1n;
}

async function acquirePostgres(
  queryRunner: QueryRunner,
  timeoutSeconds: number,
  pollIntervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const rows: unknown = await queryRunner.query(
      `SELECT pg_try_advisory_lock(${POSTGRES_LOCK_KEY}) AS locked`,
    );
    if (isTruthyLockValue(lockResult(rows))) return;
    if (Date.now() >= deadline) throw timeoutError();
    await sleep(pollIntervalMs);
  }
}

async function acquireMysql(
  queryRunner: QueryRunner,
  name: string,
  timeoutSeconds: number,
): Promise<void> {
  const rows: unknown = await queryRunner.query('SELECT GET_LOCK(?, ?) AS locked', [
    name,
    timeoutSeconds,
  ]);
  const value = lockResult(rows);
  if (isTruthyLockValue(value)) return;
  // 0 is a timeout; NULL is a server-side error (out of memory, killed thread).
  if (value === 0 || value === '0' || value === 0n) throw timeoutError();
  throw new MigrationError('lock_timeout', 'the schema lock could not be acquired');
}

/**
 * Run `fn` while holding the database's schema lock. Throws a
 * {@link MigrationError} (`lock_timeout`) when another process holds it for
 * longer than `timeoutSeconds`; `fn` does not run in that case.
 */
export async function withSchemaLock<T>(
  dataSource: SchemaLockDataSource,
  fn: () => Promise<T>,
  options: SchemaLockOptions = {},
): Promise<T> {
  if (!dataSource.isInitialized) {
    throw new MigrationError(
      'not_initialized',
      'data source must be initialized before taking the schema lock',
    );
  }
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new MigrationError('invalid_options', 'timeoutSeconds must be a non-negative number');
  }
  const driver = dataSource.jsailsDriver;
  if (driver === 'sqlite') {
    return fn();
  }

  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  const lockName = mysqlLockName(dataSource.options.database);
  let acquired = false;
  let primaryError: unknown;
  let failed = false;
  let result: T | undefined;
  try {
    if (driver === 'postgres') {
      await acquirePostgres(
        queryRunner,
        timeoutSeconds,
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      );
    } else {
      await acquireMysql(queryRunner, lockName, Math.ceil(timeoutSeconds));
    }
    acquired = true;
    result = await fn();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  // Release failures are secondary: they never hide the callback's own error.
  const cleanup: (() => Promise<unknown>)[] = [];
  if (acquired) {
    cleanup.push(() =>
      driver === 'postgres'
        ? queryRunner.query(`SELECT pg_advisory_unlock(${POSTGRES_LOCK_KEY})`)
        : queryRunner.query('SELECT RELEASE_LOCK(?)', [lockName]),
    );
  }
  cleanup.push(() => queryRunner.release());
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      if (!failed) {
        failed = true;
        primaryError = error;
      }
    }
  }
  if (failed) throw primaryError;
  return result as T;
}
