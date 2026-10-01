/**
 * The boot check: does the database hold the schema this code declares?
 *
 * A complete push records the digest of the declared schema as
 * `digest:<owner>`. At boot one row is read and compared with the digest of
 * the models the app runs with, so a deploy that forgot `db:push`, or code
 * rolled forward past the database, is caught before the first request
 * instead of at the first query that touches a missing column. Outside
 * development and test a mismatch is fatal (`schema.schema_out_of_date`);
 * in development and test the pending plan is returned for the caller to
 * print. A database never pushed has no meta table: that is detected only
 * when the read fails, so the common path stays one statement.
 */

import type { Conn, Dialect, Engine } from '../engine/contract.js';
import type { ModelTarget } from '../model/index.js';
import { declaredDigest, declaredTables } from './declared-tables.js';
import { introspect } from './introspect.js';
import { SchemaErrors } from './schema-errors.js';
import { digestKey, readMeta, SCHEMA_META_TABLE } from './schema-ledger.js';
import type { SchemaPlan } from './schema-plan.js';
import { checkOwner, planOnConnection } from './schema-source.js';

/** Options of {@link verifySchema}. */
export interface VerifySchemaOptions {
  /** The environment the app boots in. Default `production`, where a mismatch is fatal. */
  readonly environment?: string;
  /** The owner whose schema to check. Default `app`. */
  readonly owner?: string;
}

/** The outcome of {@link verifySchema}. */
export type SchemaVerification =
  | { readonly status: 'current'; readonly digest: string }
  /** Development and test only: what a push would do. */
  | { readonly status: 'pending'; readonly plan: SchemaPlan };

const LENIENT_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);

/** The recorded digest of `owner`, or `undefined` when there is none (or no ledger). */
async function appliedDigest(
  conn: Conn,
  dialect: Dialect,
  owner: string,
): Promise<string | undefined> {
  try {
    return await readMeta(conn, dialect, digestKey(owner));
  } catch (error) {
    const live = await introspect(conn, dialect, [SCHEMA_META_TABLE]);
    if (live.tables.length === 0) return undefined;
    throw error;
  }
}

/**
 * Compare the schema recorded in the database of `engine` with the digest
 * of `models`. Throws `schema.schema_out_of_date` outside development and
 * test when they differ.
 */
export async function verifySchema(
  engine: Engine,
  models: readonly ModelTarget[],
  options: VerifySchemaOptions = {},
): Promise<SchemaVerification> {
  const owner = checkOwner(options.owner);
  const environment = options.environment ?? 'production';
  const declared = declaredTables(models, engine.dialect);
  const expected = declaredDigest(declared, engine.dialect);
  const conn = await engine.lease();
  try {
    if ((await appliedDigest(conn, engine.dialect, owner)) === expected) {
      return Object.freeze({ status: 'current', digest: expected });
    }
    if (!LENIENT_ENVIRONMENTS.has(environment)) {
      throw new SchemaErrors.Error('schema_out_of_date', { owner });
    }
    return Object.freeze({
      status: 'pending',
      plan: await planOnConnection(conn, engine.dialect, declared, owner),
    });
  } finally {
    await conn.release();
  }
}
