/**
 * The schema lock on PostgreSQL and MariaDB: a session-level advisory lock,
 * taken and held on the push's one dedicated connection, named from the
 * database the server reports (not from the configuration, which a URL can
 * override).
 *
 * - PostgreSQL: `pg_try_advisory_lock(k1, k2)`, polled. `k1` is the constant
 *   `0x6a737363` ("jssc") and `k2` the first 31 bits of the database name's
 *   SHA-256, both positive, so `pg_locks` shows them unchanged as
 *   `classid`/`objid` (with `objsubid = 2` for the two-key form). PostgreSQL's
 *   advisory locks are per database already; the name only makes the key
 *   stable and readable.
 * - MariaDB: `GET_LOCK('jsails_schema_<sha256(db)[0..32]>', 0)`, polled.
 *   MariaDB's named locks are server-wide, so two databases on one server
 *   must not share a name.
 *
 * A lock is only as good as the session that holds it. Behind a
 * transaction-mode pooler consecutive statements can run on different server
 * sessions, so a lock taken by one statement protects nothing after it.
 * {@link SchemaLock.verify} asks the server whether this session still holds
 * the lock (`pg_locks` for `pg_backend_pid()`; `IS_USED_LOCK(name) =
 * CONNECTION_ID()`) and throws `schema.pooled_connection` when it does not.
 * The push verifies before every operation.
 *
 * SQLite needs none of this: the push is one write transaction, and the
 * database file's write lock is the schema lock.
 */

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Conn, Row } from '../engine/contract.js';
import { SchemaErrors } from './schema-errors.js';

const ORIGIN = 'schema';
const POSTGRES_CLASS = 0x6a737363;
const POLL_MS = 100;

/** A held schema lock. */
export interface SchemaLock {
  /** The MariaDB lock name, or `<k1>:<k2>` for PostgreSQL. */
  readonly name: string;
  /** Throw `schema.pooled_connection` unless this session still holds the lock. */
  verify(): Promise<void>;
  /** Release the lock; a session that already lost it releases nothing. */
  release(): Promise<void>;
}

function first(rows: readonly Row[]): unknown {
  const row = rows[0];
  return row === undefined ? undefined : Object.values(row)[0];
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === 1n || value === '1' || value === 't';
}

function digest(database: string): Buffer {
  return createHash('sha256').update(database).digest();
}

/** The MariaDB lock name for `database`: at most 64 characters. */
export function mariadbLockName(database: string): string {
  return `jsails_schema_${digest(database).toString('hex').slice(0, 32)}`;
}

/** The PostgreSQL advisory-lock keys for `database`. */
export function postgresLockKeys(database: string): readonly [number, number] {
  return [POSTGRES_CLASS, digest(database).readUInt32BE(0) & 0x7fffffff];
}

async function poll(attempt: () => Promise<boolean>, waitSeconds: number): Promise<void> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    if (await attempt()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SchemaErrors.Error('lock_timeout');
    await sleep(Math.min(POLL_MS, remaining));
  }
}

/**
 * Take the schema lock of `database` on `conn`, waiting up to `waitSeconds`
 * for another push to release it (`schema.lock_timeout` after that), and
 * verify it once taken.
 */
export async function acquireSchemaLock(
  conn: Conn,
  dialect: 'postgres' | 'mariadb',
  database: string,
  waitSeconds: number,
): Promise<SchemaLock> {
  const query = async (sql: string, params: readonly (string | number)[]): Promise<unknown> =>
    first((await conn.query(sql, params, { origin: ORIGIN })).rows);
  let lock: SchemaLock;
  if (dialect === 'postgres') {
    const [classId, objectId] = postgresLockKeys(database);
    await poll(
      async () =>
        truthy(await query('SELECT pg_try_advisory_lock($1, $2) AS locked', [classId, objectId])),
      waitSeconds,
    );
    lock = {
      name: `${classId}:${objectId}`,
      verify: async () => {
        const held = await query(
          `SELECT count(*) AS held FROM pg_catalog.pg_locks
           WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
             AND classid = $1 AND objid = $2 AND objsubid = 2`,
          [classId, objectId],
        );
        if (Number(held) < 1) throw new SchemaErrors.Error('pooled_connection');
      },
      release: async () => {
        await query('SELECT pg_advisory_unlock($1, $2) AS released', [classId, objectId]);
      },
    };
  } else {
    const name = mariadbLockName(database);
    await poll(
      async () => truthy(await query('SELECT GET_LOCK(?, 0) AS locked', [name])),
      waitSeconds,
    );
    lock = {
      name,
      verify: async () => {
        const held = await query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [name]);
        if (!truthy(held)) throw new SchemaErrors.Error('pooled_connection');
      },
      release: async () => {
        await query('SELECT RELEASE_LOCK(?) AS released', [name]);
      },
    };
  }
  try {
    await lock.verify();
  } catch (error) {
    // Whichever session took the lock keeps it until it ends; release what
    // this statement's session may hold, and report the lost lock.
    await lock.release().catch(() => undefined);
    throw error;
  }
  return Object.freeze(lock);
}
