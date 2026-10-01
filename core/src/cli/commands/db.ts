/**
 * Declarative schema commands: `db:push` (diff + apply) and `db:diff` (read-only).
 *
 * The database config module decides which schema layer runs:
 *
 * - A `defineSchemaConfig()` config (`@jsails/database`) carries the data
 *   layer's own command modules, which this file calls with the parsed
 *   flags: owned introspection and DDL, the schema ledger, a verified
 *   session lock, and per-operation approval (`--approve <digest>`,
 *   `--approve-all` in development and test, `--wait-lock <seconds>`,
 *   `--json`).
 * - A `JsailsDataSource` takes the TypeORM reconciler in `db-schema.ts`:
 *   `db:push` applies the plan, then runs the config's data migrations;
 *   `db:diff` prints the plan (`--dry-run`, `--allow-destructive`, `--sql`,
 *   `--app-config`).
 *
 * Each path refuses the other's flags, so a flag never silently does
 * nothing. Each command loads and validates the config module before it
 * loads a schema layer, so a missing or broken config is reported at the
 * cost of the config loader alone.
 */

import { DEFAULT_DATABASE_CONFIG_PATH } from '../../config-modules.js';
import { loadDatabaseConfig, type SchemaCommandIo } from '../config-loader.js';
import type { CommandInvocation, CommandModule } from '../descriptor.js';
import type { DB_DIFF_OPTIONS, DB_PUSH_OPTIONS } from '../manifest.js';
import { prepareConfigModule } from '../stages.js';
import { usageError } from '../usage-error.js';
import type { DbDiffOptions, DbPushDeps, DbPushOptions } from './db-schema.js';

export type { DbDiffOptions, DbPushDeps, DbPushOptions } from './db-schema.js';

/** `db:push`'s flags, for either schema layer. */
export interface DbPushCommandOptions extends DbPushOptions {
  /** `--approve <digest>`: schema-config path only. */
  readonly approve?: readonly string[];
  /** `--approve-all`: schema-config path only. */
  readonly approveAll?: boolean;
  /** `--wait-lock <seconds>`: schema-config path only. */
  readonly waitLock?: string;
  /** `--json`: schema-config path only. */
  readonly json?: boolean;
}

/** `db:diff`'s flags, for either schema layer. */
export interface DbDiffCommandOptions extends DbDiffOptions {
  /** `--json`: schema-config path only. */
  readonly json?: boolean;
}

function helpHint(command: string): string {
  return `Run "jsails ${command} --help" for usage.`;
}

function refuse(command: string, flag: string, layer: string): number {
  return usageError(
    (line) => console.error(line),
    helpHint(command),
    `${command}: --${flag} is not valid with ${layer}`,
  );
}

/** The environment the commands hand to a schema config's command modules. */
type CommandEnv = Readonly<Record<string, string | undefined>>;

function io(configPath: string, env: CommandEnv): SchemaCommandIo {
  return {
    configPath,
    env,
    stdout: (line) => console.log(line),
  };
}

const SCHEMA_CONFIG = 'a defineSchemaConfig() config';
const DATA_SOURCE = 'a JsailsDataSource config';

/**
 * `jsails db:push`: reconcile the live database with the declared schema.
 * See the module header for the two schema layers; `deps` replaces the
 * TypeORM path's collaborators in tests.
 */
export async function runDbPush(
  configPath: string,
  options: DbPushCommandOptions,
  env: CommandEnv,
  deps?: DbPushDeps,
): Promise<number> {
  const config = await loadDatabaseConfig(configPath);
  if (config.kind === 'schema') {
    if (options.dryRun) return refuse('db:push', 'dry-run', SCHEMA_CONFIG);
    if (options.allowDestructive) return refuse('db:push', 'allow-destructive', SCHEMA_CONFIG);
    if (options.appConfigPath !== undefined) {
      return refuse('db:push', 'app-config', SCHEMA_CONFIG);
    }
    return config.commands['db:push'](
      {
        approve: options.approve ?? [],
        approveAll: options.approveAll === true,
        json: options.json === true,
        ...(options.waitLock === undefined ? {} : { waitLock: options.waitLock }),
      },
      io(configPath, env),
    );
  }
  if ((options.approve ?? []).length > 0) return refuse('db:push', 'approve', DATA_SOURCE);
  if (options.approveAll === true) return refuse('db:push', 'approve-all', DATA_SOURCE);
  if (options.waitLock !== undefined) return refuse('db:push', 'wait-lock', DATA_SOURCE);
  if (options.json === true) return refuse('db:push', 'json', DATA_SOURCE);
  const { pushSchema } = await import('./db-schema.js');
  return pushSchema(
    config.dataSource,
    configPath,
    {
      dryRun: options.dryRun,
      allowDestructive: options.allowDestructive,
      ...(options.appConfigPath === undefined ? {} : { appConfigPath: options.appConfigPath }),
    },
    deps,
  );
}

/**
 * `jsails db:diff`: print the plan a push would apply, changing nothing.
 */
export async function runDbDiff(
  configPath: string,
  options: DbDiffCommandOptions,
  env: CommandEnv,
): Promise<number> {
  const config = await loadDatabaseConfig(configPath);
  if (config.kind === 'schema') {
    if (options.sql === true) return refuse('db:diff', 'sql', SCHEMA_CONFIG);
    if (options.appConfigPath !== undefined) {
      return refuse('db:diff', 'app-config', SCHEMA_CONFIG);
    }
    return config.commands['db:diff']({ json: options.json === true }, io(configPath, env));
  }
  if (options.json === true) return refuse('db:diff', 'json', DATA_SOURCE);
  const { diffSchema } = await import('./db-schema.js');
  return diffSchema(config.dataSource, configPath, {
    ...(options.sql === undefined ? {} : { sql: options.sql }),
    ...(options.appConfigPath === undefined ? {} : { appConfigPath: options.appConfigPath }),
  });
}

/** The database config path of an invocation, its globals installed. */
function databaseConfigPath(context: CommandInvocation): Promise<string> {
  const value = context.values['config'];
  return prepareConfigModule(
    context.cwd,
    typeof value === 'string' ? value : DEFAULT_DATABASE_CONFIG_PATH,
  );
}

/** `jsails db:push`. */
export const dbPushCommand: CommandModule<typeof DB_PUSH_OPTIONS, 'environment'> = {
  async run(context) {
    const { values } = context;
    return runDbPush(
      await databaseConfigPath(context),
      {
        dryRun: values['dry-run'] === true,
        allowDestructive: values['allow-destructive'] === true,
        ...(values['app-config'] === undefined ? {} : { appConfigPath: values['app-config'] }),
        approve: values.approve ?? [],
        approveAll: values['approve-all'] === true,
        ...(values['wait-lock'] === undefined ? {} : { waitLock: values['wait-lock'] }),
        json: values.json === true,
      },
      context.env,
    );
  },
};

/** `jsails db:diff`. */
export const dbDiffCommand: CommandModule<typeof DB_DIFF_OPTIONS, 'environment'> = {
  async run(context) {
    const { values } = context;
    return runDbDiff(
      await databaseConfigPath(context),
      {
        sql: values.sql === true,
        ...(values['app-config'] === undefined ? {} : { appConfigPath: values['app-config'] }),
        json: values.json === true,
      },
      context.env,
    );
  },
};
