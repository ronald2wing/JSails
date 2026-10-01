/**
 * Database-backed {@link FeatureStore}.
 *
 * {@link createDatabaseFlagStore} persists flags in the framework-owned
 * `jsails_feature_flag` table through the injected TypeORM `DataSource`'s
 * repository — no raw SQL and no runtime DDL. The table must already exist: an
 * app includes {@link flagsEntities} in its `JsailsDataSource` entities and
 * creates the table through the normal declarative schema history (`db:push`).
 * A missing table fails with a value-free {@link FeatureFlagError}
 * (`missing_table`) telling the caller to run that command; the store never
 * creates it. A data source that is not initialized fails (`not_initialized`)
 * before any repository query runs.
 */

import type { DataSource } from 'typeorm';
import { createOwnedTables, isRecord, upsertRow } from 'jsails/plugin-sdk';

import { FEATURE_FLAG_TABLE, JsailsFeatureFlag } from './entities.js';
import {
  FeatureFlagError,
  assertFlagKey,
  assertFlagScope,
  assertFlagValue,
  type FeatureStore,
} from './flags.js';

/** Options for {@link createDatabaseFlagStore}. */
export interface DatabaseFlagStoreOptions {
  /** The initialized TypeORM data source backing feature flags. */
  readonly dataSource: DataSource;
  /** Clock stamping `updatedAt` on every write. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** The column value for the global scope: the empty string, never `null`. */
function scopeColumn(scope: string | undefined): string {
  return scope ?? '';
}

/**
 * Create a database-backed {@link FeatureStore} over an initialized TypeORM
 * data source. The `jsails_feature_flag` table must already exist. See the
 * module doc for the exact contract.
 */
export function createDatabaseFlagStore(options: DatabaseFlagStoreOptions): FeatureStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createDatabaseFlagStore requires an options object');
  }
  if (!isRecord(options.dataSource) || typeof options.dataSource.getRepository !== 'function') {
    throw new TypeError('dataSource must be a TypeORM data source');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  const { dataSource } = options;
  const now = options.now ?? (() => new Date());
  const repository = dataSource.getRepository(JsailsFeatureFlag);
  const tables = createOwnedTables({
    dataSource,
    tables: [FEATURE_FLAG_TABLE],
    makeError: (failure) =>
      failure === 'not_initialized'
        ? new FeatureFlagError(
            'not_initialized',
            'the feature flag data source must be initialized',
          )
        : new FeatureFlagError(
            'missing_table',
            'the jsails_feature_flag table does not exist; run db:push to create it',
          ),
  });

  async function get(key: string, scope?: string): Promise<boolean | null> {
    assertFlagKey(key);
    assertFlagScope(scope);
    await tables.open();
    const row = await repository.findOneBy({ key, scope: scopeColumn(scope) });
    return row === null ? null : row.value;
  }

  async function set(key: string, value: boolean, scope?: string): Promise<void> {
    assertFlagKey(key);
    assertFlagScope(scope);
    assertFlagValue(value);
    await tables.open();
    const columnScope = scopeColumn(scope);
    await upsertRow({
      dataSource,
      entity: JsailsFeatureFlag,
      where: { key, scope: columnScope },
      update: (existing) => {
        existing.value = value;
        existing.updatedAt = now();
      },
      create: () => ({ key, scope: columnScope, value, updatedAt: now() }),
    });
  }

  async function remove(key: string, scope?: string): Promise<void> {
    assertFlagKey(key);
    assertFlagScope(scope);
    await tables.open();
    await repository.delete({ key, scope: scopeColumn(scope) });
  }

  async function all(scope?: string): Promise<Record<string, boolean>> {
    assertFlagScope(scope);
    await tables.open();
    const rows = await repository.findBy({ scope: scopeColumn(scope) });
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  return { get, set, delete: remove, all };
}
