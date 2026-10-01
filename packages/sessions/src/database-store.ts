/**
 * Database-backed {@link SessionStore}.
 *
 * {@link createDatabaseSessionStore} persists sessions in the framework-owned
 * `jsails_session` table through the injected TypeORM `DataSource`'s
 * repository — no raw SQL and no runtime DDL. The table must already exist: an
 * app includes {@link sessionEntities} in its `JsailsDataSource` entities and
 * creates the table through the normal declarative schema history (`db:push`).
 * A missing table fails with a value-free {@link SessionStoreError}
 * (`missing_table`) telling the caller to run that command; the store never
 * creates it. A data source that is not initialized fails (`not_initialized`)
 * before any repository query runs.
 *
 * A session row stores the full session — id, CSRF token, session data, and
 * millisecond expiry — as JSON in `data`, with `sessionId` and `expiresAt`
 * denormalized into scalar columns for lookup and expiry pruning. Reads parse
 * and validate that JSON value-free: a malformed row (invalid JSON, a shape
 * that is not a session, or a stored id that disagrees with the `sessionId`
 * column) is rejected (`malformed_row`) without ever echoing its contents.
 * Expired rows are deleted lazily on `get` and in bulk by `pruneExpired`;
 * expiry is judged against the reconstructed session's millisecond expiry so it
 * never depends on a driver's datetime precision.
 */

import type { DataSource } from 'typeorm';
import { LessThanOrEqual } from 'typeorm';

import type { Session, SessionStore } from 'jsails';
import { JsailsError, createOwnedTables, isRecord, upsertRow } from 'jsails/plugin-sdk';
import { JsailsSession, SESSION_ID_COLUMN_LENGTH, SESSION_TABLE } from './entities.js';

/** Machine-readable reason for a {@link SessionStoreError}. */
export type SessionStoreErrorCode =
  'not_initialized' | 'missing_table' | 'invalid_session' | 'malformed_row';

/** Raised for a missing or unready table, an invalid write, or a malformed row. Value-free. */
export class SessionStoreError extends JsailsError {
  constructor(
    readonly code: SessionStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Options for {@link createDatabaseSessionStore}. */
export interface DatabaseSessionStoreOptions {
  /** The initialized TypeORM data source backing sessions. */
  readonly dataSource: DataSource;
  /** Clock returning epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * A database-backed {@link SessionStore}; `pruneExpired` is the bulk expiry
 * sweep an app schedules alongside the request-time lazy deletion.
 */
export interface DatabaseSessionStore extends SessionStore {
  /** Delete every row whose `expiresAt` is at or before now; returns the count. */
  pruneExpired(): Promise<number>;
}

/** Structural check that `value` is a TypeORM data source. */
function isDataSource(value: unknown): value is DataSource {
  return (
    isRecord(value) &&
    typeof value.getRepository === 'function' &&
    typeof value.createQueryRunner === 'function' &&
    typeof value.transaction === 'function'
  );
}

/** Structural check of a parsed JSON value as a {@link Session}. Value-free. */
function isSessionValue(value: unknown): value is Session {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= SESSION_ID_COLUMN_LENGTH &&
    typeof value.csrfToken === 'string' &&
    value.csrfToken.length > 0 &&
    isRecord(value.data) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt)
  );
}

/** Validate and serialize an inbound {@link Session}, value-free. */
function serializeSession(session: Session): string {
  if (!isSessionValue(session)) {
    throw new SessionStoreError('invalid_session', 'session store received an invalid session');
  }
  try {
    return JSON.stringify(session);
  } catch (error) {
    throw new SessionStoreError(
      'invalid_session',
      'session store received a session that is not JSON-serializable',
      { cause: error },
    );
  }
}

/** Parse and validate a stored row's `data` JSON into a {@link Session}, value-free. */
function parseSessionRow(row: JsailsSession): Session {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    throw new SessionStoreError(
      'malformed_row',
      'session store encountered a malformed session row',
    );
  }
  if (!isSessionValue(parsed) || parsed.id !== row.sessionId) {
    throw new SessionStoreError(
      'malformed_row',
      'session store encountered a malformed session row',
    );
  }
  return parsed;
}

/**
 * Create a database-backed {@link SessionStore} over an initialized TypeORM
 * data source. The `jsails_session` table must already exist. See the module
 * doc for the exact contract.
 */
export function createDatabaseSessionStore(
  options: DatabaseSessionStoreOptions,
): DatabaseSessionStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createDatabaseSessionStore requires an options object');
  }
  if (!isDataSource(options.dataSource)) {
    throw new TypeError('dataSource must be a TypeORM data source');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  const dataSource = options.dataSource;
  const now = options.now ?? Date.now;
  const repository = dataSource.getRepository(JsailsSession);
  const tables = createOwnedTables({
    dataSource,
    tables: [SESSION_TABLE],
    makeError: (failure) =>
      failure === 'not_initialized'
        ? new SessionStoreError('not_initialized', 'the session data source must be initialized')
        : new SessionStoreError(
            'missing_table',
            'the jsails_session table does not exist; run db:push to create it',
          ),
  });

  async function get(id: string): Promise<Session | null> {
    await tables.open();
    const row = await repository.findOneBy({ sessionId: id });
    if (row === null) {
      return null;
    }
    const session = parseSessionRow(row);
    if (session.expiresAt <= now()) {
      await repository.delete({ id: row.id });
      return null;
    }
    return session;
  }

  async function set(session: Session): Promise<void> {
    const serialized = serializeSession(session);
    const expiresAt = new Date(session.expiresAt);
    await tables.open();
    await upsertRow({
      dataSource,
      entity: JsailsSession,
      where: { sessionId: session.id },
      update: (existing) => {
        existing.data = serialized;
        existing.expiresAt = expiresAt;
      },
      create: () => ({
        sessionId: session.id,
        data: serialized,
        expiresAt,
        createdAt: new Date(now()),
      }),
    });
  }

  async function remove(id: string): Promise<void> {
    await tables.open();
    await repository.delete({ sessionId: id });
  }

  async function pruneExpired(): Promise<number> {
    await tables.open();
    const result = await repository.delete({ expiresAt: LessThanOrEqual(new Date(now())) });
    return result.affected ?? 0;
  }

  return { get, set, delete: remove, pruneExpired };
}
