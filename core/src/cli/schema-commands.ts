/**
 * Declarative schema commands: `db:push` (diff + apply) and `db:diff` (read-only).
 *
 * The reconciler compares the declared model schema against the live database
 * and emits a plan of operations. `db:push` applies the plan, then runs the
 * config's data migrations (phase 2); `db:diff` prints the schema plan. Both use
 * a single {@link JsailsDataSource} for model metadata and the live connection —
 * there is no migration history, no tracking table, and no rollback.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { QueryRunner } from 'typeorm';

import { type Operation } from '../migrations/operations.js';
import { reconcileDataSource, type SchemaPlan } from '../migrations/reconciler.js';
import { executeSchemaPlan } from '../migrations/schema-executor.js';
import { previewSchemaOperations } from '../migrations/sql-preview.js';
import {
  createDataMigrationRegistry,
  orderDataMigrations,
  type DataMigration,
} from '../migrations/data.js';
import { MigrationError } from '../migrations/schema-types.js';

import { collectPluginSchemaEntities } from '../plugins/schema.js';
import { resolvePluginUse } from '../plugins/use.js';
import { DEFAULT_APP_CONFIG_PATH, loadAppConfig, loadDataSourceConfig } from './config-loader.js';

// ---------------------------------------------------------------------------
// Format operations for human-readable output
// ---------------------------------------------------------------------------

/**
 * Render a single operation as a human-readable line. Only table/column/index
 * identifiers already present in the operation are included; no driver-specific
 * type or definition details are surfaced.
 */
export function formatOperation(op: Operation): string {
  switch (op.kind) {
    case 'create_table':
      return `create_table ${op.table.name}`;
    case 'drop_table':
      return `drop_table ${op.table.name}`;
    case 'add_column':
      return `add_column ${op.table}.${op.column.name}`;
    case 'drop_column':
      return `drop_column ${op.table}.${op.column.name}`;
    case 'rename_column':
      return `rename_column ${op.table}.${op.from} -> ${op.to}`;
    case 'rename_table':
      return `rename_table ${op.from} -> ${op.to}`;
    case 'alter_column':
      return `alter_column ${op.table}.${op.column.name}`;
    case 'copy_column':
      return `copy_column ${op.table}.${op.from} -> ${op.to}`;
    case 'alter_inheritance':
      return `alter_inheritance ${op.table}`;
    case 'alter_polymorphic':
      return `alter_polymorphic ${op.table}`;
    case 'add_index':
      return `add_index ${op.table} ${op.index.name}`;
    case 'drop_index':
      return `drop_index ${op.table} ${op.index.name}`;
    case 'add_unique':
      return `add_unique ${op.table} ${op.unique.name}`;
    case 'drop_unique':
      return `drop_unique ${op.table} ${op.unique.name}`;
    case 'add_fk':
      return `add_fk ${op.table} ${op.foreignKey.name}`;
    case 'drop_fk':
      return `drop_fk ${op.table} ${op.foreignKey.name}`;
    case 'add_check':
      return `add_check ${op.table} ${op.check.name}`;
    case 'drop_check':
      return `drop_check ${op.table} ${op.check.name}`;
  }
}

/** Render a {@link SchemaPlan} as an ordered array of lines for printing. */
export function formatSchemaPlan(plan: SchemaPlan): string[] {
  const lines: string[] = [];
  for (const op of plan.operations) {
    lines.push(formatOperation(op));
  }
  if (plan.upToDate) {
    lines.push('Database is up to date.');
  } else {
    const destructiveFlag = plan.destructive ? ' (destructive)' : '';
    lines.push(`${plan.operations.length} operation(s)${destructiveFlag}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Declarative DB commands: db:push and db:diff
// ---------------------------------------------------------------------------

/** Options for `runDbPush`. */
interface DbPushOptions {
  readonly dryRun: boolean;
  readonly allowDestructive: boolean;
  /** App config used to discover plugin-owned schema. Defaults to jsails.app.js. */
  readonly appConfigPath?: string;
}

/**
 * Discover the static schema entities declared by the app's enabled plugins.
 *
 * The app config is optional: a CLI-only or schema-only project without
 * `jsails.app.js` simply contributes no plugin entities. An explicitly supplied
 * path that does not exist is an error; the default path is silent when absent.
 */
async function discoverPluginSchemaEntities(appConfigPath?: string): Promise<readonly Function[]> {
  const requested = appConfigPath ?? DEFAULT_APP_CONFIG_PATH;
  if (!existsSync(resolve(requested))) {
    if (appConfigPath === undefined) return Object.freeze([]);
    throw new MigrationError(`app config "${requested}" does not exist`);
  }
  const appConfig = await loadAppConfig(requested);
  const result = await resolvePluginUse({ entries: appConfig.plugins?.use ?? [] });
  if (result.issues.length > 0) {
    const specifiers = result.issues.map((issue) => issue.path ?? 'unknown').join(', ');
    throw new MigrationError(`plugin schema could not be loaded: ${specifiers}`);
  }
  return collectPluginSchemaEntities(result.plugins);
}

/**
 * Load the `dataMigrations` named export from the config module, if present.
 *
 * The config module keeps its default export as the `JsailsDataSource`; data
 * migrations ride a separate named export so the schema surface stays
 * `default`-only. Returns a validated registry keyed by name in **declaration
 * order** (object key order), or an empty map when the module exports none.
 *
 * A module that fails to load returns an empty map — {@link loadDataSourceConfig}
 * will have already failed with a better error, so this never masks a real
 * config problem.
 */
async function loadDataMigrationRegistry(
  configPath: string,
): Promise<ReadonlyMap<string, DataMigration>> {
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(resolve(configPath)).href)) as Record<string, unknown>;
  } catch {
    return new Map();
  }
  const raw = module.dataMigrations;
  if (raw === undefined) {
    return new Map();
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new MigrationError(
      'the "dataMigrations" export must be an object of DataMigration values',
    );
  }
  // `createDataMigrationRegistry` validates names/functions; the returned Map
  // preserves insertion (declaration) order, which is the execution order.
  return createDataMigrationRegistry(raw as Record<string, DataMigration>);
}

/** Structural contract a data migration needs from a data source. */
export interface DataMigrationDataSource {
  createQueryRunner(): QueryRunner;
}

/**
 * Run the config's data migrations in dependency order against an initialized
 * data source. Each migration runs in its own transaction by default; a failure
 * rolls back that migration only. No ledger: every migration's `up` runs on
 * every call, so each must be idempotent. Returns the names run, in order.
 *
 * The query runner is connected for the batch and released in a `finally`; a
 * migration that throws surfaces unwrapped and stops the sequence (later
 * migrations are not run).
 */
export async function runDataMigrations(
  dataSource: DataMigrationDataSource,
  migrations: ReadonlyMap<string, DataMigration>,
): Promise<readonly string[]> {
  const ran: string[] = [];
  const ordered = orderDataMigrations(migrations);
  if (ordered.size === 0) {
    return ran;
  }
  const queryRunner = dataSource.createQueryRunner();
  let primaryError: unknown;
  let connected = false;
  try {
    await queryRunner.connect();
    connected = true;
    for (const migration of ordered.values()) {
      if (migration.transactional === false) {
        await migration.up({ queryRunner });
        if (queryRunner.isTransactionActive) {
          throw new MigrationError(
            `data migration "${migration.name}" left an active transaction; ` +
              'commit or roll it back before returning',
          );
        }
        ran.push(migration.name);
        continue;
      }
      if (queryRunner.isTransactionActive) {
        throw new MigrationError(
          `data migration "${migration.name}" is transactional but the query runner already ` +
            'has an active transaction; set transactional: false',
        );
      }
      await queryRunner.startTransaction();
      try {
        await migration.up({ queryRunner });
        await queryRunner.commitTransaction();
        ran.push(migration.name);
      } catch (error) {
        try {
          await queryRunner.rollbackTransaction();
        } catch {
          // Rollback failure is secondary; surface the migration error.
        }
        throw error;
      }
    }
  } catch (error) {
    // A failed self-managed migration may have left a transaction open; the
    // runner is ours, so roll it back rather than releasing a dirty session.
    if (queryRunner.isTransactionActive) {
      try {
        await queryRunner.rollbackTransaction();
      } catch {
        // Rollback failure is secondary; surface the primary migration error.
      }
    }
    primaryError = error;
  }
  if (connected) {
    try {
      await queryRunner.release();
    } catch (error) {
      if (primaryError === undefined) primaryError = error;
    }
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  return ran;
}

/**
 * Diff the declared model schema against the live database and apply the plan,
 * then run data migrations (phase 2).
 *
 * When `options.dryRun` is set the plan is printed and nothing is applied.
 * When the plan is destructive and `options.allowDestructive` is not set, the
 * command refuses (exit 1) and lists the destructive operations — and phase 2
 * never runs (a refused phase 1 short-circuits the push).
 *
 * Data migrations run on **every** push, including when the schema is already up
 * to date: they carry no ledger, so a data-only change must remain runnable
 * without a schema diff.
 */
export async function runDbPush(configPath: string, options: DbPushOptions): Promise<number> {
  const dataSource = await loadDataSourceConfig(configPath);
  try {
    dataSource.addEntities(await discoverPluginSchemaEntities(options.appConfigPath));
    const plan = await reconcileDataSource(dataSource, { allowDestructive: true });

    if (plan.destructive && !options.allowDestructive) {
      console.log(
        'The plan contains destructive operations. Review them and re-run with --allow-destructive:',
      );
      for (const op of plan.operations) {
        console.log(`  ${formatOperation(op)}`);
      }
      return 1;
    }

    if (options.dryRun) {
      if (plan.upToDate) {
        console.log('Database is up to date.');
      } else {
        for (const line of formatSchemaPlan(plan)) {
          console.log(line);
        }
      }
      // Phase 2 is not connected, so a dry run can only report what *would* run.
      const migrations = await loadDataMigrationRegistry(configPath);
      for (const name of migrations.keys()) {
        console.log(`Would run data migration ${name}`);
      }
      return 0;
    }

    // `reconcileDataSource` introspects the live database through
    // `getLiveSchema`, which initializes the data source as a side effect. Only
    // initialize when it is somehow not yet connected, so we never double-connect.
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    if (plan.upToDate) {
      console.log('Database is up to date.');
    } else {
      await executeSchemaPlan(dataSource, plan.operations);
      for (const op of plan.operations) {
        console.log(`Applied ${formatOperation(op)}`);
      }
    }

    const migrations = await loadDataMigrationRegistry(configPath);
    const ran = await runDataMigrations(dataSource, migrations);
    for (const name of ran) {
      console.log(`Ran data migration ${name}`);
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}

/** Options for `runDbDiff`. */
export interface DbDiffOptions {
  /** Print driver-specific SQL instead of the operation summary. */
  readonly sql?: boolean;
  /** App config used to discover plugin-owned schema. Defaults to jsails.app.js. */
  readonly appConfigPath?: string;
}

/**
 * Diff the declared model schema against the live database and print the plan
 * without applying it. Read-only: never requires `--allow-destructive`. With
 * `sql: true`, render driver-specific SQL via a non-connecting preview runner.
 */
export async function runDbDiff(configPath: string, options?: DbDiffOptions): Promise<number> {
  const dataSource = await loadDataSourceConfig(configPath);
  try {
    dataSource.addEntities(await discoverPluginSchemaEntities(options?.appConfigPath));
    // Build with destructive changes permitted so `db:diff` can always show the
    // full plan; nothing is applied.
    const plan = await reconcileDataSource(dataSource, { allowDestructive: true });
    if (options?.sql !== true) {
      for (const line of formatSchemaPlan(plan)) {
        console.log(line);
      }
      return 0;
    }

    if (plan.upToDate) {
      console.log('Database is up to date.');
      return 0;
    }

    const entries = await previewSchemaOperations(plan.operations, dataSource.jsailsDriver);
    for (const entry of entries) {
      console.log(`-- ${formatOperation(entry.operation)}`);
      if (entry.note !== undefined) {
        console.log(`-- ${entry.note}`);
      } else if (entry.statements.length === 0) {
        console.log('-- (no SQL; metadata-only)');
      } else {
        for (const statement of entry.statements) {
          console.log(`${statement};`);
        }
      }
    }
  } finally {
    await dataSource.destroy();
  }
  return 0;
}
