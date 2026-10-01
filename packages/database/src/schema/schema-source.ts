/**
 * What a push, a diff or a boot check works from: a resolved database
 * configuration and the models that declare the schema. The data source
 * (DAT-07) hands over exactly these; until then a schema config module or a
 * test builds one directly.
 *
 * The shared steps live here too: checking a source before any connection
 * opens, opening the dedicated schema connection, and planning over a
 * connection that is already open.
 */

import { MEMORY_DATABASE, type DatabaseConfig } from '../engine/config.js';
import type { Conn, Dialect, Engine } from '../engine/contract.js';
import { createEngine } from '../engine/create-engine.js';
import type { ModelTarget, TableState } from '../model/index.js';
import { declaredTables } from './declared-tables.js';
import { introspect } from './introspect.js';
import { SchemaErrors } from './schema-errors.js';
import { readOwnership, SCHEMA_OBJECTS_TABLE } from './schema-ledger.js';
import { planSchema, type SchemaPlan } from './schema-plan.js';

/** The database and the models whose schema a push, diff or boot check compares. */
export interface SchemaSource {
  readonly config: DatabaseConfig;
  readonly models: readonly ModelTarget[];
}

/** The owner a push manages when none is named: the application. */
export const APP_OWNER = 'app';

const OWNER = /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/;

/** Check an owner name: an identifier of at most 128 characters. */
export function checkOwner(owner: unknown): string {
  if (owner === undefined) return APP_OWNER;
  if (typeof owner !== 'string' || !OWNER.test(owner)) {
    throw new SchemaErrors.Error('invalid_options', { field: 'owner' });
  }
  return owner;
}

/**
 * Check `source` and lower its models, before any connection opens. Refuses
 * an in-memory SQLite database, which a second connection cannot reach.
 */
export function checkSource(source: SchemaSource): {
  readonly config: DatabaseConfig;
  readonly declared: TableState[];
} {
  if (source === null || typeof source !== 'object') {
    throw new SchemaErrors.Error('invalid_source', { field: 'source' });
  }
  const { config } = source;
  if (config === null || typeof config !== 'object' || typeof config.dialect !== 'string') {
    throw new SchemaErrors.Error('invalid_source', { field: 'config' });
  }
  if (config.dialect === 'sqlite' && config.file === MEMORY_DATABASE) {
    throw new SchemaErrors.Error('memory_database');
  }
  return { config, declared: declaredTables(source.models, config.dialect) };
}

/** Open the dedicated schema connection: `migrationUrl ?? url`, one connection, no statement timeout. */
export function openSchemaEngine(config: DatabaseConfig): Promise<Engine> {
  return createEngine(config, { purpose: 'migration' });
}

/**
 * Plan over an open connection without changing anything: the ledger is read
 * when it exists and treated as empty when it does not.
 */
export async function planOnConnection(
  conn: Conn,
  dialect: Dialect,
  declared: readonly TableState[],
  owner: string,
): Promise<SchemaPlan> {
  const live = await introspect(conn, dialect);
  const ledger = live.tables.some((table) => table.name === SCHEMA_OBJECTS_TABLE);
  const ownership = ledger ? await readOwnership(conn, dialect) : new Map<string, string>();
  return planSchema({ dialect, owner, declared, live, ownership });
}
