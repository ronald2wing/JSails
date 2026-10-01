/**
 * Declarative schema commands: `db:push` (diff + apply) and `db:diff` (read-only).
 *
 * The reconciler compares the declared model schema against the live database
 * and emits a plan of operations. `db:push` applies the plan, then runs the
 * config's data migrations (phase 2); `db:diff` prints the schema plan. Both use
 * a single {@link JsailsDataSource} for model metadata and the live connection —
 * there is no migration history, no tracking table, and no rollback.
 *
 * `db:push` (dry run included) computes and applies its plan while holding the
 * database's schema lock, so two instances pushing at boot run one after the
 * other and the second sees an up-to-date schema instead of racing the DDL.
 *
 * Tables another migrator owns are left out of both plans: the enabled
 * plugins' `schema.unmanagedTables` plus the config module's optional
 * `unmanagedTables` named export.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { QueryRunner } from 'typeorm';

import { type Operation } from '../../migrations/operations.js';
import { reconcileDataSource, type SchemaPlan } from '../../migrations/reconciler.js';
import { executeSchemaPlan, PartialSchemaPlanError } from '../../migrations/schema-executor.js';
import { withSchemaLock } from '../../migrations/schema-lock.js';
import { previewSchemaOperations } from '../../migrations/sql-preview.js';
import {
  createDataMigrationRegistry,
  orderDataMigrations,
  type DataMigration,
} from '../../migrations/data.js';
import { MigrationError } from '../../migrations/schema-types.js';

import { collectPluginSchemaEntities, collectPluginUnmanagedTables } from '../../plugins/schema.js';
import { resolvePluginUse } from '../../plugins/use.js';
import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/defaults.js';
import { loadAppConfig, loadDataSourceConfig } from '../config-loader.js';
import { isRecord } from '../../json/shape.js';
import { isValidIdentifier } from '../../migrations/schema-validation.js';
import type { JsailsDataSource } from '../../database/data-source.js';
import { transactionScopes, type TransactionScope } from '../../database/transaction-scope.js';
import { importFile } from '../../support/project-paths.server.js';

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

/** The schema the app's enabled plugins declare statically. */
export interface PluginSchemaDiscovery {
  /** Entity classes to register on the data source. */
  readonly entities: readonly Function[];
  /** Live tables owned by a plugin's own migrator. */
  readonly unmanagedTables: readonly string[];
}

const NO_PLUGIN_SCHEMA: PluginSchemaDiscovery = Object.freeze({
  entities: Object.freeze([]),
  unmanagedTables: Object.freeze([]),
});

/**
 * Discover the static schema declared by the app's enabled plugins: their
 * entities and their unmanaged table names.
 *
 * The app config is optional: a CLI-only or schema-only project without
 * `jsails.app.js` simply contributes nothing. An explicitly supplied path that
 * does not exist is an error; the default path is silent when absent.
 */
export async function discoverPluginSchema(appConfigPath?: string): Promise<PluginSchemaDiscovery> {
  const requested = appConfigPath ?? DEFAULT_APP_CONFIG_PATH;
  if (!existsSync(resolve(requested))) {
    if (appConfigPath === undefined) return NO_PLUGIN_SCHEMA;
    throw new MigrationError('not_found', `app config "${requested}" does not exist`);
  }
  const appConfig = await loadAppConfig(requested);
  const result = await resolvePluginUse({ entries: appConfig.plugins?.use ?? [] });
  if (result.issues.length > 0) {
    const specifiers = result.issues.map((issue) => issue.path ?? 'unknown').join(', ');
    throw new MigrationError(
      'plugin_load_failed',
      `plugin schema could not be loaded: ${specifiers}`,
    );
  }
  return Object.freeze({
    entities: collectPluginSchemaEntities(result.plugins),
    unmanagedTables: collectPluginUnmanagedTables(result.plugins),
  });
}

/**
 * Load the config module, or `undefined` when it cannot be imported:
 * {@link loadDataSourceConfig} has already failed with a better error then, so
 * this never masks a real config problem.
 */
async function importConfigModule(
  configPath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await importFile(configPath);
  } catch {
    return undefined;
  }
}

/**
 * Read the config module's optional `unmanagedTables` named export: live
 * tables another migrator owns, which the plan leaves alone. Each entry must be
 * a plain SQL identifier.
 */
async function loadConfigUnmanagedTables(configPath: string): Promise<readonly string[]> {
  const raw = (await importConfigModule(configPath))?.unmanagedTables;
  if (raw === undefined) return [];
  const entries: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const names = entries.filter(isValidIdentifier);
  if (!Array.isArray(raw) || names.length !== entries.length) {
    throw new MigrationError(
      'invalid_config',
      'the "unmanagedTables" export must be an array of table names',
    );
  }
  return names;
}

/**
 * The tables a plan skips: the plugins' declarations merged with the config
 * module's (when a config path is given), deduplicated.
 */
async function resolveUnmanagedTables(
  configPath: string | undefined,
  plugins: PluginSchemaDiscovery,
): Promise<readonly string[]> {
  const fromConfig = configPath === undefined ? [] : await loadConfigUnmanagedTables(configPath);
  return Object.freeze([...new Set([...plugins.unmanagedTables, ...fromConfig])]);
}

/**
 * Register the enabled plugins' entities on a data source that is not
 * initialized yet, and resolve the tables every plan of it leaves alone: the
 * plugins' `schema.unmanagedTables` plus the config module's export. Shared by
 * `db:push`, `db:diff`, and `jsails test`, so all three own the same tables.
 */
export async function preparePluginSchema(
  dataSource: JsailsDataSource,
  options: { readonly configPath?: string; readonly appConfigPath?: string },
): Promise<readonly string[]> {
  const pluginSchema = await discoverPluginSchema(options.appConfigPath);
  const unmanagedTables = await resolveUnmanagedTables(options.configPath, pluginSchema);
  dataSource.addEntities(pluginSchema.entities);
  return unmanagedTables;
}

/**
 * Plan the data source's full reconcile, destructive changes included, with
 * the unmanaged tables left out at introspection: another migrator's columns
 * (Better Auth's string primary keys, for one) need not fit the portable
 * model, so they are never read, let alone diffed.
 */
export function planSchema(
  dataSource: JsailsDataSource,
  unmanagedTables: readonly string[],
): Promise<SchemaPlan> {
  return reconcileDataSource(
    {
      getModelSchema: () => dataSource.getModelSchema(),
      getLiveSchema: () => dataSource.getLiveSchema({ excludeTables: unmanagedTables }),
    },
    { allowDestructive: true, unmanagedTables },
  );
}

/**
 * Load the `dataMigrations` named export from the config module, if present.
 *
 * The config module keeps its default export as the `JsailsDataSource`; data
 * migrations ride a separate named export so the schema surface stays
 * `default`-only. Returns a validated registry keyed by name in **declaration
 * order** (object key order), or an empty map when the module exports none.
 *
 * A module that fails to load returns an empty map (see {@link importConfigModule}).
 */
async function loadDataMigrationRegistry(
  configPath: string,
): Promise<ReadonlyMap<string, DataMigration>> {
  const module = await importConfigModule(configPath);
  if (module === undefined) {
    return new Map();
  }
  const raw = module.dataMigrations;
  if (raw === undefined) {
    return new Map();
  }
  if (!isRecord(raw)) {
    throw new MigrationError(
      'invalid_config',
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
 * Run `up` with the migration's open transaction registered as the ambient
 * `transaction()` scope for `dataSource`, as if `up` were a `transaction()`
 * body. Active Record calls, the data source's own manager and query runners,
 * and nested `transaction()` calls then join the migration's transaction on
 * every driver. On `sqljs` this is what keeps them from queuing behind the
 * migration's own hold on the connection, which would never be released.
 * The scope closes when `up` settles, before the commit, so a promise `up`
 * left running does not join a transaction that is about to end.
 */
async function runInMigrationScope(
  dataSource: DataMigrationDataSource,
  scope: TransactionScope,
  up: () => Promise<void>,
): Promise<void> {
  const scopes = new Map(transactionScopes.getStore() ?? []);
  scopes.set(dataSource, scope);
  try {
    await transactionScopes.run(scopes, up);
  } finally {
    scope.active = false;
  }
}

/**
 * Run the config's data migrations in dependency order against an initialized
 * data source. Each migration runs in its own transaction by default; a failure
 * rolls back that migration only. No ledger: every migration's `up` runs on
 * every call, so each must be idempotent. Returns the names run, in order.
 *
 * A transactional migration's `up` runs as the ambient transaction scope of
 * `dataSource` (see {@link runInMigrationScope}): model calls and nested
 * `transaction()` calls join it, and `afterCommit` / `afterRollback`
 * callbacks registered by nested calls run once the migration commits or
 * rolls back, with the same semantics as `transaction()`. A
 * `transactional: false` migration runs outside any scope.
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
            'invalid_data_migration',
            `data migration "${migration.name}" left an active transaction; ` +
              'commit or roll it back before returning',
          );
        }
        ran.push(migration.name);
        continue;
      }
      if (queryRunner.isTransactionActive) {
        throw new MigrationError(
          'invalid_data_migration',
          `data migration "${migration.name}" is transactional but the query runner already ` +
            'has an active transaction; set transactional: false',
        );
      }
      const scope: TransactionScope = {
        txManager: queryRunner.manager,
        active: true,
        afterCommitCallbacks: [],
        afterRollbackCallbacks: [],
      };
      await queryRunner.startTransaction();
      try {
        await runInMigrationScope(dataSource, scope, () => migration.up({ queryRunner }));
        await queryRunner.commitTransaction();
      } catch (error) {
        try {
          await queryRunner.rollbackTransaction();
        } catch {
          // Rollback failure is secondary; surface the migration error.
        }
        // Post-mortem cleanup must not mask the migration error.
        for (const callback of scope.afterRollbackCallbacks) {
          try {
            await callback();
          } catch {
            // swallowed, as in transaction()
          }
        }
        throw error;
      }
      // Committed: a throwing afterCommit callback stops the sequence, but the
      // migration's writes are durable.
      for (const callback of scope.afterCommitCallbacks) {
        await callback();
      }
      ran.push(migration.name);
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

/** Collaborators `runDbPush` reaches through, replaceable in tests. */
export interface DbPushDeps {
  readonly withSchemaLock: typeof withSchemaLock;
  readonly executeSchemaPlan: typeof executeSchemaPlan;
}

const defaultDbPushDeps: DbPushDeps = Object.freeze({ withSchemaLock, executeSchemaPlan });

/**
 * Report what a MySQL/MariaDB plan committed before it failed. Those
 * operations stay applied, so the operator needs the list and the knowledge
 * that a re-run computes a fresh plan from the live schema.
 */
function reportPartialPlan(error: PartialSchemaPlanError): void {
  console.error(
    `Schema plan stopped at ${formatOperation(error.failed)}; ` +
      `${error.applied.length} operation(s) were applied before the failure:`,
  );
  for (const op of error.applied) {
    console.error(`  ${formatOperation(op)}`);
  }
  console.error(
    'Fix the cause and re-run db:push to resume: the next plan covers only what is left.',
  );
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
 *
 * Reconcile, apply, and data migrations all run inside {@link withSchemaLock};
 * the plan is computed after the lock is held, never before, or a waiting
 * process would apply a plan that the holder already applied.
 */
export async function runDbPush(
  configPath: string,
  options: DbPushOptions,
  deps: DbPushDeps = defaultDbPushDeps,
): Promise<number> {
  const dataSource = await loadDataSourceConfig(configPath);
  try {
    const unmanagedTables = await preparePluginSchema(dataSource, {
      configPath,
      ...(options.appConfigPath !== undefined ? { appConfigPath: options.appConfigPath } : {}),
    });
    // The lock lives on a connection of this data source, so it must be
    // connected first; entities are registered above because they cannot be
    // added after initialization.
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    return await deps.withSchemaLock(dataSource, async () => {
      const plan = await planSchema(dataSource, unmanagedTables);

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
        // A dry run never executes data migrations (they write), so it only lists them.
        const migrations = await loadDataMigrationRegistry(configPath);
        for (const name of migrations.keys()) {
          console.log(`Would run data migration ${name}`);
        }
        return 0;
      }

      if (plan.upToDate) {
        console.log('Database is up to date.');
      } else {
        try {
          await deps.executeSchemaPlan(dataSource, plan.operations);
        } catch (error) {
          if (error instanceof PartialSchemaPlanError) reportPartialPlan(error);
          throw error;
        }
        for (const op of plan.operations) {
          console.log(`Applied ${formatOperation(op)}`);
        }
      }

      const migrations = await loadDataMigrationRegistry(configPath);
      const ran = await runDataMigrations(dataSource, migrations);
      for (const name of ran) {
        console.log(`Ran data migration ${name}`);
      }
      return 0;
    });
  } finally {
    // A discovery failure throws before the connection opens; destroying an
    // unopened source would replace that error with a connection error.
    if (dataSource.isInitialized) await dataSource.destroy();
  }
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
    const unmanagedTables = await preparePluginSchema(dataSource, {
      configPath,
      ...(options?.appConfigPath !== undefined ? { appConfigPath: options.appConfigPath } : {}),
    });
    // The plan permits destructive changes so `db:diff` can always show the
    // full plan; nothing is applied.
    const plan = await planSchema(dataSource, unmanagedTables);
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
    // A discovery failure throws before the connection opens; destroying an
    // unopened source would replace that error with a connection error.
    if (dataSource.isInitialized) await dataSource.destroy();
  }
  return 0;
}
