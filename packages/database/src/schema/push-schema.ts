/**
 * `pushSchema(source, options)`: reconcile the database with the declared
 * schema of one owner, under the schema lock, and report what was applied
 * and what waits for approval.
 *
 * Every step runs on one dedicated connection (`migrationUrl ?? url`):
 *
 * 1. Take the lock. On PostgreSQL and MariaDB a session advisory lock named
 *    from the server-reported database, verified before every later step; on
 *    SQLite one `BEGIN IMMEDIATE` transaction with foreign keys off (a table
 *    rebuild must not cascade), which is the lock, and is checked with
 *    `foreign_key_check` before it commits.
 * 2. In the `test` environment, run the test-database guard.
 * 3. Create the ledger tables if missing, read ownership, introspect, plan.
 *    The plan is computed inside the lock, so two pushes never apply the
 *    same plan twice.
 * 4. Refuse the whole push if an approved digest matches no operation
 *    (`schema.stale_approval`): the approval was for a state that is gone.
 * 5. Decide what waits, for the whole plan at once (`planDeferrals`): a
 *    blocking or destructive operation that is not approved, and any
 *    operation that depends on, or applies together with, one that waits.
 *    Then apply the rest in plan order.
 * 6. Record newly seen unmanaged tables, and, when nothing was deferred, the
 *    digest of the declared schema as `digest:<owner>`.
 *
 * Approving everything (`approve: 'all'`) is accepted only in `development`
 * and `test`.
 *
 * The test harness pushes through {@link pushTestSchema}, which adds one
 * step between 3's introspection and its plan: the harness's own, on the
 * push's connection, after the guard and under the lock.
 */

import type { Conn, Dialect, Engine, TransactionConn } from '../engine/contract.js';
import { isDatabaseError } from '../engine/database-error.js';
import type { TableState } from '../model/index.js';
import { introspect } from './introspect.js';
import type { SchemaState } from './schema-state.js';
import { SchemaErrors } from './schema-errors.js';
import {
  bootstrapLedger,
  digestKey,
  readMetaKeys,
  readOwnership,
  recordOwnership,
  removeOwnership,
  unmanagedKey,
  writeMeta,
} from './schema-ledger.js';
import {
  planDeferrals,
  planSchema,
  type DeferralReason,
  type PlannedOperation,
} from './schema-plan.js';
import { acquireSchemaLock } from './session-lock.js';
import { checkOwner, checkSource, openSchemaEngine, type SchemaSource } from './schema-source.js';
import { assertTestDatabase, connectedDatabase } from './test-guard.js';

const ORIGIN = 'schema';
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 86_400;
const DIGEST = /^[0-9a-f]{16}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,63}$/;
/** Environments where `approve: 'all'` is accepted. */
const APPROVE_ALL_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);

/** Options of {@link pushSchema}. */
export interface PushSchemaOptions {
  /**
   * The blocking and destructive operations to apply, by digest (from a plan
   * of `diffSchema` or an earlier push), or `'all'` in development and test.
   */
  readonly approve?: readonly string[] | 'all';
  /** The environment the push runs in. Default `production`, the strictest. */
  readonly environment?: string;
  /** How long to wait for another push's lock, in seconds. Default 60. */
  readonly waitLockSeconds?: number;
  /** The owner whose tables this push manages. Default `app`. */
  readonly owner?: string;
}

/** An operation the push did not apply, and why. */
export interface DeferredOperation extends PlannedOperation {
  readonly reason: DeferralReason;
}

/** What a push did. */
export interface PushReport {
  readonly dialect: Dialect;
  readonly owner: string;
  readonly applied: readonly PlannedOperation[];
  readonly deferred: readonly DeferredOperation[];
  /** Unmanaged tables seen for the first time; each is reported once. */
  readonly unmanaged: readonly string[];
  /** Whether nothing was deferred, so the database holds the declared schema. */
  readonly complete: boolean;
  /** The declared schema's digest, recorded when the push was complete. */
  readonly digest?: string;
}

/** What the test harness's step inside a push ({@link pushTestSchema}) works with. */
export interface TestPushStep {
  /** The push's own connection, holding the schema lock (on SQLite, inside its transaction). */
  readonly conn: Conn;
  readonly dialect: Dialect;
  /** The owner the push manages. */
  readonly owner: string;
  readonly declared: readonly TableState[];
  /** The live schema the plan is computed from, read after the guard passed. */
  readonly live: SchemaState;
  /** Table ownership from the ledger. */
  readonly ownership: ReadonlyMap<string, string>;
  /** Throw `schema.pooled_connection` unless the lock still holds; call before each statement. */
  verify(): Promise<void>;
}

/** The test harness's step inside a push; it may change rows, never the schema. */
export type TestPushStepRunner = (step: TestPushStep) => Promise<void>;

interface PushSettings {
  readonly approve: ReadonlySet<string> | 'all';
  readonly environment: string;
  readonly waitLockSeconds: number;
  readonly owner: string;
  /** Set only by {@link pushTestSchema}, whose environment is always `test`. */
  readonly beforePlan?: TestPushStepRunner;
}

function settings(options: PushSchemaOptions): PushSettings {
  if (options === null || typeof options !== 'object') {
    throw new SchemaErrors.Error('invalid_options', { field: 'options' });
  }
  const environment = options.environment ?? 'production';
  if (typeof environment !== 'string' || !ENVIRONMENT.test(environment)) {
    throw new SchemaErrors.Error('invalid_options', { field: 'environment' });
  }
  const waitLockSeconds = options.waitLockSeconds ?? DEFAULT_WAIT_SECONDS;
  if (
    typeof waitLockSeconds !== 'number' ||
    !Number.isFinite(waitLockSeconds) ||
    waitLockSeconds < 0 ||
    waitLockSeconds > MAX_WAIT_SECONDS
  ) {
    throw new SchemaErrors.Error('invalid_options', { field: 'waitLockSeconds' });
  }
  const approve = options.approve ?? [];
  if (approve === 'all') {
    if (!APPROVE_ALL_ENVIRONMENTS.has(environment)) {
      throw new SchemaErrors.Error('approve_all_refused', { environment });
    }
  } else if (!Array.isArray(approve) || !approve.every((digest) => DIGEST.test(String(digest)))) {
    throw new SchemaErrors.Error('invalid_options', { field: 'approve' });
  }
  return Object.freeze({
    approve: approve === 'all' ? 'all' : new Set(approve),
    environment,
    waitLockSeconds,
    owner: checkOwner(options.owner),
  });
}

/** One push's connection, the dialect it speaks, and how to prove the lock still holds. */
interface PushSession {
  readonly conn: Conn;
  readonly dialect: Dialect;
  readonly verify: () => Promise<void>;
}

async function applyOperation(
  session: PushSession,
  owner: string,
  op: PlannedOperation,
): Promise<void> {
  const { conn, dialect } = session;
  for (const sql of op.statements) {
    await session.verify();
    await conn.query(sql, [], { origin: ORIGIN });
  }
  const operation = op.operation;
  switch (operation.kind) {
    case 'create_table':
      await session.verify();
      await recordOwnership(conn, dialect, operation.table.name, owner);
      break;
    case 'adopt_table':
      await session.verify();
      await recordOwnership(conn, dialect, operation.table, owner);
      break;
    case 'drop_table':
    case 'forget_table':
      await session.verify();
      await removeOwnership(conn, dialect, operation.table);
      break;
    default:
      break;
  }
}

/** Rows of rebuilt SQLite tables whose foreign keys point nowhere fail the push. */
async function checkRebuiltForeignKeys(
  conn: Conn,
  applied: readonly PlannedOperation[],
): Promise<void> {
  for (const op of applied) {
    if (op.operation.kind !== 'rebuild_table') continue;
    const table = op.operation.table.name;
    const { rows } = await conn.query(
      'SELECT 1 AS broken FROM pragma_foreign_key_check(?) LIMIT 1',
      [table],
      {
        origin: ORIGIN,
      },
    );
    if (rows.length > 0) throw new SchemaErrors.Error('foreign_key_check', { table });
  }
}

async function reconcile(
  session: PushSession,
  declared: readonly TableState[],
  options: PushSettings,
): Promise<PushReport> {
  const { conn, dialect, verify } = session;
  if (options.environment === 'test') {
    await verify();
    await assertTestDatabase(conn);
  }
  await verify();
  await bootstrapLedger(conn, dialect);
  await verify();
  const ownership = await readOwnership(conn, dialect);
  const reported = await readMetaKeys(conn, dialect, 'unmanaged:');
  const live = await introspect(conn, dialect);
  if (options.beforePlan !== undefined) {
    await options.beforePlan(
      Object.freeze({ conn, dialect, owner: options.owner, declared, live, ownership, verify }),
    );
  }
  const plan = planSchema({ dialect, owner: options.owner, declared, live, ownership });

  if (options.approve !== 'all') {
    const digests = new Set(plan.operations.map((op) => op.digest));
    for (const digest of options.approve) {
      if (!digests.has(digest)) throw new SchemaErrors.Error('stale_approval', { digest });
    }
  }

  const { approve } = options;
  const deferrals = planDeferrals(
    plan.operations,
    (digest) => approve === 'all' || approve.has(digest),
  );
  const applied: PlannedOperation[] = [];
  const deferred: DeferredOperation[] = [];
  for (const op of plan.operations) {
    const reason = deferrals.get(op.digest);
    if (reason !== undefined) {
      deferred.push(Object.freeze({ ...op, reason }));
      continue;
    }
    await applyOperation(session, options.owner, op);
    applied.push(op);
  }
  if (dialect === 'sqlite') await checkRebuiltForeignKeys(conn, applied);

  const unmanaged = plan.unmanaged.filter((table) => !reported.has(unmanagedKey(table)));
  for (const table of unmanaged) {
    await verify();
    await writeMeta(conn, dialect, unmanagedKey(table), '1');
  }
  const complete = deferred.length === 0;
  if (complete) {
    await verify();
    await writeMeta(conn, dialect, digestKey(options.owner), plan.declaredDigest);
  }
  return Object.freeze({
    dialect,
    owner: options.owner,
    applied: Object.freeze(applied),
    deferred: Object.freeze(deferred),
    unmanaged: Object.freeze(unmanaged),
    complete,
    ...(complete ? { digest: plan.declaredDigest } : {}),
  });
}

/**
 * Push over an open PostgreSQL or MariaDB session: take and verify the lock
 * on `conn`, reconcile, release. `conn` must be one server session for the
 * whole call; a connection that is not (a transaction-mode pooler) fails
 * with `schema.pooled_connection` before any change.
 */
export async function pushOnSession(
  conn: Conn,
  declared: readonly TableState[],
  options: PushSchemaOptions = {},
): Promise<PushReport> {
  return await pushOnServerSession(conn, declared, settings(options));
}

async function pushOnServerSession(
  conn: Conn,
  declared: readonly TableState[],
  resolved: PushSettings,
): Promise<PushReport> {
  const dialect = conn.dialect;
  if (dialect === 'sqlite') throw new SchemaErrors.Error('invalid_source', { field: 'conn' });
  if (dialect === 'mariadb') {
    // DDL literals double quotes and nothing else (see column-default.ts).
    await conn.query(
      "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'NO_BACKSLASH_ESCAPES')",
      [],
      { origin: ORIGIN },
    );
  }
  const database = await connectedDatabase(conn);
  const lock = await acquireSchemaLock(conn, dialect, database, resolved.waitLockSeconds);
  try {
    return await reconcile({ conn, dialect, verify: lock.verify }, declared, resolved);
  } finally {
    // A session that died took its lock with it; a failed release has
    // nothing left to free, and must not hide the push's own outcome.
    await lock.release().catch(() => undefined);
  }
}

async function pushSqlite(
  engine: Engine,
  declared: readonly TableState[],
  options: PushSettings,
): Promise<PushReport> {
  // foreign_keys cannot change inside a transaction; this engine is the
  // push's own, so no other statement runs on its writer.
  const setup = await engine.lease();
  try {
    await setup.query('PRAGMA foreign_keys = OFF', [], { origin: ORIGIN });
  } finally {
    await setup.release();
  }
  let transaction: TransactionConn;
  try {
    transaction = await engine.begin();
  } catch (error) {
    if (isDatabaseError(error, 'busy'))
      throw new SchemaErrors.Error('lock_timeout', {}, { cause: error });
    throw error;
  }
  let committed = false;
  try {
    const report = await reconcile(
      { conn: transaction, dialect: 'sqlite', verify: () => Promise.resolve() },
      declared,
      options,
    );
    await transaction.commit();
    committed = true;
    return report;
  } finally {
    if (!committed) await transaction.release();
  }
}

/**
 * Reconcile the database of `source` with its models for one owner. See the
 * module header for the steps; the report lists what applied, what is
 * deferred and why, and whether the schema is now the declared one.
 */
export async function pushSchema(
  source: SchemaSource,
  options: PushSchemaOptions = {},
): Promise<PushReport> {
  return await push(source, settings(options));
}

/**
 * `pushSchema` in the `test` environment, with the test harness's
 * `beforePlan` run inside the push: after the test-database guard passed
 * under the schema lock, and before the plan is computed from the live
 * schema the step is handed. The harness empties a kept test database
 * there, so rows an earlier run left behind can never block a change the
 * plan makes (a required column, a unique index, a foreign key), and only a
 * database the guard accepted is ever emptied. The step changes rows only:
 * the plan is computed from the schema read before it ran.
 */
export async function pushTestSchema(
  source: SchemaSource,
  options: Omit<PushSchemaOptions, 'environment'>,
  beforePlan: TestPushStepRunner,
): Promise<PushReport> {
  if (options === null || typeof options !== 'object') {
    throw new SchemaErrors.Error('invalid_options', { field: 'options' });
  }
  if (typeof beforePlan !== 'function') {
    throw new SchemaErrors.Error('invalid_options', { field: 'beforePlan' });
  }
  return await push(
    source,
    Object.freeze({ ...settings({ ...options, environment: 'test' }), beforePlan }),
  );
}

async function push(source: SchemaSource, resolved: PushSettings): Promise<PushReport> {
  const { config, declared } = checkSource(source);
  const engine = await openSchemaEngine(
    config.dialect === 'sqlite'
      ? Object.freeze({ ...config, busyTimeoutMs: resolved.waitLockSeconds * 1000 })
      : config,
  );
  try {
    if (engine.dialect === 'sqlite') return await pushSqlite(engine, declared, resolved);
    const conn = await engine.lease();
    try {
      return await pushOnServerSession(conn, declared, resolved);
    } finally {
      await conn.release();
    }
  } finally {
    await engine.close();
  }
}
