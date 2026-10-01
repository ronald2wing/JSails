/**
 * `diffSchema(source, options)`: the plan a push would apply now, without
 * taking the lock or changing anything (the ledger tables are not even
 * created). Each blocking or destructive operation carries the digest a push
 * accepts with `approve`; a push recomputes the plan under the lock and
 * refuses a digest whose operation or table changed meanwhile.
 */

import {
  checkOwner,
  checkSource,
  openSchemaEngine,
  planOnConnection,
  type SchemaSource,
} from './schema-source.js';
import type { SchemaPlan } from './schema-plan.js';

/** Options of {@link diffSchema}. */
export interface DiffSchemaOptions {
  /** The owner whose tables to compare. Default `app`. */
  readonly owner?: string;
}

/** The plan a push of `source` would apply now. */
export async function diffSchema(
  source: SchemaSource,
  options: DiffSchemaOptions = {},
): Promise<SchemaPlan> {
  const owner = checkOwner(options.owner);
  const { config, declared } = checkSource(source);
  const engine = await openSchemaEngine(config);
  try {
    const conn = await engine.lease();
    try {
      return await planOnConnection(conn, engine.dialect, declared, owner);
    } finally {
      await conn.release();
    }
  } finally {
    await engine.close();
  }
}
