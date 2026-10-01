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
 * The session id is the cookie credential, so the table never holds it: the
 * `sessionId` column stores a SHA-256 digest of the id, and the CSRF token in
 * the `data` JSON is AES-256-GCM sealed under a key derived from the raw id.
 * A leaked backup or a SQL read therefore yields neither a cookie nor a
 * matching `X-CSRF-Token`; only a caller presenting the real id can find and
 * open its row. Lookups stay one indexed equality on the digest.
 *
 * `data` holds `{ v: 2, csrf, data, expiresAt }`, with `expiresAt` also
 * denormalized into a scalar column for pruning. Rows written before hashing
 * (the raw id in `sessionId`, the plaintext session in `data`) are still read,
 * and rewritten in the hashed format on first read, so upgrading does not sign
 * anyone out. Reads validate the JSON value-free: a malformed row (invalid
 * JSON, a shape that is not a session, a stored id that disagrees with the
 * presented one, or a CSRF seal that does not open) is rejected
 * (`malformed_row`) without echoing its contents. Expired rows are deleted
 * lazily on `get` and in bulk by `pruneExpired`; expiry is judged against the
 * session's millisecond expiry so it never depends on a driver's datetime
 * precision.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { DataSource } from 'typeorm';
import { LessThanOrEqual } from 'typeorm';

import type { Session, SessionStore } from 'jsails';
import { JsailsError, createOwnedTables, isRecord } from 'jsails/plugin-sdk';
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

/** Version tag of the hashed row format; legacy rows carry no `v`. */
const ROW_FORMAT_VERSION = 2;

const SEAL_IV_BYTES = 12;
const SEAL_TAG_BYTES = 16;

/**
 * The `sessionId` column value for a session id. Purpose-labelled so the
 * digest is unrelated to the sealing key derived from the same id.
 */
export function sessionLookupKey(id: string): string {
  return createHash('sha256').update('jsails-session-lookup\u0000').update(id).digest('hex');
}

/** The AES-256-GCM key sealing a session's CSRF token, derived from its raw id. */
function csrfSealKey(id: string): Buffer {
  return createHash('sha256').update('jsails-session-csrf\u0000').update(id).digest();
}

function sealCsrfToken(id: string, token: string): string {
  const iv = randomBytes(SEAL_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', csrfSealKey(id), iv);
  const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
}

function malformedRow(): SessionStoreError {
  return new SessionStoreError(
    'malformed_row',
    'session store encountered a malformed session row',
  );
}

function openCsrfToken(id: string, sealed: string): string {
  const bytes = Buffer.from(sealed, 'base64url');
  if (bytes.length <= SEAL_IV_BYTES + SEAL_TAG_BYTES) {
    throw malformedRow();
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      csrfSealKey(id),
      bytes.subarray(0, SEAL_IV_BYTES),
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - SEAL_TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(SEAL_IV_BYTES, bytes.length - SEAL_TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw malformedRow();
  }
}

/** Whether a row is in the hashed format, judged by its version tag. */
function isHashedRow(row: JsailsSession): boolean {
  try {
    const parsed: unknown = JSON.parse(row.data);
    return isRecord(parsed) && parsed.v === ROW_FORMAT_VERSION;
  } catch {
    return false;
  }
}

/** Validate and serialize an inbound {@link Session} into the hashed row format, value-free. */
function serializeSession(session: Session): string {
  if (!isSessionValue(session)) {
    throw new SessionStoreError('invalid_session', 'session store received an invalid session');
  }
  try {
    return JSON.stringify({
      v: ROW_FORMAT_VERSION,
      csrf: sealCsrfToken(session.id, session.csrfToken),
      data: session.data,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    throw new SessionStoreError(
      'invalid_session',
      'session store received a session that is not JSON-serializable',
      { cause: error },
    );
  }
}

/**
 * Parse and validate a stored row's `data` JSON into the {@link Session} for
 * the presented `id`, value-free. Reads both the hashed format and the legacy
 * plaintext one. A hashed row reached through the legacy raw-id lookup means
 * the caller presented a digest copied from the table, so it is not a match.
 */
function parseSessionRow(
  row: JsailsSession,
  id: string,
  lookup: 'hashed' | 'legacy',
): Session | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    throw malformedRow();
  }
  if (isRecord(parsed) && parsed.v === ROW_FORMAT_VERSION) {
    if (lookup === 'legacy') {
      return null;
    }
    if (
      row.sessionId !== sessionLookupKey(id) ||
      typeof parsed.csrf !== 'string' ||
      !isRecord(parsed.data) ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      throw malformedRow();
    }
    const session: unknown = {
      id,
      csrfToken: openCsrfToken(id, parsed.csrf),
      data: parsed.data,
      expiresAt: parsed.expiresAt,
    };
    if (!isSessionValue(session)) {
      throw malformedRow();
    }
    return session;
  }
  if (!isSessionValue(parsed) || parsed.id !== id || row.sessionId !== id) {
    throw malformedRow();
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
  const column = (property: keyof JsailsSession): string => {
    const found = repository.metadata.findColumnWithPropertyName(property);
    if (found === undefined) {
      throw new TypeError('jsails_session entity metadata is missing a column');
    }
    return found.databaseName;
  };
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

  /**
   * One atomic insert-or-update on the unique `sessionId` index. `createdAt`
   * is only written on insert, so it survives later writes.
   */
  async function write(session: Session): Promise<void> {
    const serialized = serializeSession(session);
    await repository
      .createQueryBuilder()
      .insert()
      .values({
        sessionId: sessionLookupKey(session.id),
        data: serialized,
        expiresAt: new Date(session.expiresAt),
        createdAt: new Date(now()),
      })
      .orUpdate([column('data'), column('expiresAt')], [column('sessionId')])
      .execute();
  }

  async function get(id: string): Promise<Session | null> {
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }
    await tables.open();
    const hashed = await repository.findOneBy({ sessionId: sessionLookupKey(id) });
    const row = hashed ?? (await repository.findOneBy({ sessionId: id }));
    if (row === null) {
      return null;
    }
    const session = parseSessionRow(row, id, hashed === null ? 'legacy' : 'hashed');
    if (session === null) {
      return null;
    }
    if (session.expiresAt <= now()) {
      await repository.delete({ id: row.id });
      return null;
    }
    if (hashed === null) {
      // A legacy plaintext row: move it to the hashed format so the raw
      // credential leaves the table.
      await write(session);
      await repository.delete({ id: row.id });
    }
    return session;
  }

  async function set(session: Session): Promise<void> {
    if (!isSessionValue(session)) {
      throw new SessionStoreError('invalid_session', 'session store received an invalid session');
    }
    await tables.open();
    await write(session);
  }

  async function remove(id: string): Promise<void> {
    await tables.open();
    await repository.delete({ sessionId: sessionLookupKey(id) });
    // A legacy plaintext row is keyed by the raw id. A hashed row whose digest
    // equals the presented id is someone else's session, so it is left alone.
    const legacy = await repository.findOneBy({ sessionId: id });
    if (legacy !== null && !isHashedRow(legacy)) {
      await repository.delete({ id: legacy.id });
    }
  }

  async function pruneExpired(): Promise<number> {
    await tables.open();
    const result = await repository.delete({ expiresAt: LessThanOrEqual(new Date(now())) });
    return result.affected ?? 0;
  }

  return { get, set, delete: remove, pruneExpired };
}
