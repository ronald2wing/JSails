/**
 * Config-module loading for the CLI commands that read a plain default export
 * (the data source, seeders, the console), and the commands' entry to the app
 * config loader, which validates and resolves the config object.
 *
 * `loadDatabaseConfig` also recognizes a data-layer schema config by its
 * brand and hands back the command table it carries.
 *
 * Every loader shares the "compile TypeScript first" rejection and value-free
 * failure discipline. Importing this module loads none of what a loader needs
 * once called (the app config schema and Zod, the data-source class), so a
 * command imports it for its help and usage paths at no cost.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ResolvedAppConfig } from '../app/config/index.js';
import type { LoadedApp } from '../kernel/load-app.js';
import type { JsailsDataSource } from '../database/data-source.js';
import { isTypeScriptConfig } from '../config-modules.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { bootstrapModels } from '../models/bootstrap.js';
import { importFile, relativePathSlot } from '../support/project-paths.server.js';

const CONFIG_MODULE_ERRORS = {
  typescript_config: {
    kind: 'internal',
    message: 'config {path} is a TypeScript module',
    context: { path: 'relative-path' },
    suggestion:
      'compile it to JavaScript first (e.g. tsc) and point --config at the compiled output',
  },
  not_found: {
    kind: 'not_found',
    message: 'config {path} was not found',
    context: { path: 'relative-path' },
    suggestion: 'run the command from the project root, or pass --config <path>',
  },
  load_failed: {
    kind: 'internal',
    message: 'failed to load config {path}',
    context: { path: 'relative-path' },
  },
  invalid_data_source: {
    kind: 'internal',
    message: 'config {path} must default-export a JsailsDataSource instance',
    context: { path: 'relative-path' },
  },
  invalid_database_config: {
    kind: 'internal',
    message:
      'config {path} must default-export a JsailsDataSource instance or a defineSchemaConfig() config',
    context: { path: 'relative-path' },
  },
} as const;

/**
 * Config-module loading's codes, `config_module.*`. The context names the
 * module by its path relative to the working directory; an import failure
 * keeps the thrown value as its `cause`, never in the message (a syntax error
 * wrapped in the `module_syntax.*` error that says where it is), and the CLI
 * prints that chain value-free.
 */
export const ConfigModuleErrors: ErrorRegistry<'config_module', typeof CONFIG_MODULE_ERRORS> =
  defineErrors('config_module', CONFIG_MODULE_ERRORS);

/** Options for {@link loadConfigModule} and {@link loadDataSourceConfig}. */
export interface ConfigModuleLoadOptions {
  /**
   * Evaluate a fresh instance of the module instead of the ESM-cached one, so a
   * module that reads the environment at top level sees the current values.
   * Only the config module itself is re-evaluated; its imports stay cached.
   */
  readonly fresh?: boolean;
}

let freshImportCounter = 0;

/**
 * Load a compiled config module and return its default export. A TypeScript
 * path is rejected rather than executed; every failure is value-free.
 */
export async function loadConfigModule(
  configPath: string,
  options: ConfigModuleLoadOptions = {},
): Promise<unknown> {
  const absolute = resolve(configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new ConfigModuleErrors.Error('typescript_config', { path: relativePathSlot(configPath) });
  }
  if (!existsSync(absolute)) {
    throw new ConfigModuleErrors.Error('not_found', { path: relativePathSlot(configPath) });
  }
  let module: unknown;
  try {
    if (options.fresh === true) {
      // ESM caches by URL, so a distinct version is the only way to get a
      // second evaluation of the same file in this process.
      freshImportCounter += 1;
      module = await importFile(absolute, { version: `fresh-${freshImportCounter}` });
    } else {
      module = await importFile(absolute);
    }
  } catch (error) {
    const { explainModuleImportFailure } = await import('../support/syntax-location.server.js');
    throw new ConfigModuleErrors.Error(
      'load_failed',
      { path: relativePathSlot(configPath) },
      { cause: await explainModuleImportFailure(absolute, error) },
    );
  }
  return (module as { default?: unknown }).default;
}

// A database config module that default-exports `defineSchemaConfig(...)`
// (from `@jsails/database/schema`) carries its own `db:push`/`db:diff`
// command modules under the global symbol `jsails.database.schema-config`,
// so the built-in commands reach the data layer without core importing it.
// The command contribution contract replaces this with commands the
// `database()` plugin declares.

/** The brand a schema config carries; its value is the command table. */
const SCHEMA_CONFIG_BRAND: unique symbol = Symbol.for('jsails.database.schema-config') as never;

/** Where a schema command reads its environment and writes its output. */
export interface SchemaCommandIo {
  /** The config module the command was loaded from. */
  readonly configPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(line: string): void;
}

/** `db:push`'s flags on the schema-config path. */
export interface SchemaPushFlags {
  readonly approve: readonly string[];
  readonly approveAll: boolean;
  readonly waitLock?: string;
  readonly json: boolean;
}

/** `db:diff`'s flags on the schema-config path. */
export interface SchemaDiffFlags {
  readonly json: boolean;
}

/** The commands a schema config carries. */
export interface SchemaCommandTable {
  readonly 'db:push': (flags: SchemaPushFlags, io: SchemaCommandIo) => Promise<number>;
  readonly 'db:diff': (flags: SchemaDiffFlags, io: SchemaCommandIo) => Promise<number>;
}

/** The command table of a schema config, or `undefined` for any other value. */
export function schemaCommandTable(value: unknown): SchemaCommandTable | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const table: unknown = (value as Record<symbol, unknown>)[SCHEMA_CONFIG_BRAND];
  if (typeof table !== 'object' || table === null) return undefined;
  const commands = table as Record<string, unknown>;
  if (typeof commands['db:push'] !== 'function' || typeof commands['db:diff'] !== 'function') {
    return undefined;
  }
  return table as SchemaCommandTable;
}

/** What a database config module default-exports. */
export type DatabaseConfigModule =
  | { readonly kind: 'data-source'; readonly dataSource: JsailsDataSource }
  | { readonly kind: 'schema'; readonly commands: SchemaCommandTable };

async function importDatabaseConfig(
  configPath: string,
  options: ConfigModuleLoadOptions,
): Promise<DatabaseConfigModule | undefined> {
  // Populate the compiler-generated model registry before the config module is
  // imported, so a data source that harvests the registry sees every model with
  // zero user wiring. A project with no registry is a silent no-op.
  await bootstrapModels({ rootDir: dirname(resolve(configPath)) });
  const exported = await loadConfigModule(configPath, options);
  const commands = schemaCommandTable(exported);
  if (commands !== undefined) return { kind: 'schema', commands };
  // A database config imports `jsails/database` itself, so this import is
  // already in the module cache whenever the check can pass.
  const { JsailsDataSource } = await import('../database/data-source.js');
  return exported instanceof JsailsDataSource
    ? { kind: 'data-source', dataSource: exported }
    : undefined;
}

/** Load a database config module default-exporting a `JsailsDataSource`. */
export async function loadDataSourceConfig(
  configPath: string,
  options: ConfigModuleLoadOptions = {},
): Promise<JsailsDataSource> {
  const loaded = await importDatabaseConfig(configPath, options);
  if (loaded?.kind !== 'data-source') {
    throw new ConfigModuleErrors.Error('invalid_data_source', {
      path: relativePathSlot(configPath),
    });
  }
  return loaded.dataSource;
}

/**
 * Load the database config module of `db:push`/`db:diff`: a
 * `JsailsDataSource`, or a `defineSchemaConfig()` config of the data layer,
 * which carries the commands that handle it.
 */
export async function loadDatabaseConfig(
  configPath: string,
  options: ConfigModuleLoadOptions = {},
): Promise<DatabaseConfigModule> {
  const loaded = await importDatabaseConfig(configPath, options);
  if (loaded === undefined) {
    throw new ConfigModuleErrors.Error('invalid_database_config', {
      path: relativePathSlot(configPath),
    });
  }
  return loaded;
}

/**
 * Load the app at `configPath` with the kernel loader, from the environment
 * the bin resolved for this command.
 */
export async function loadCliApp(configPath: string): Promise<LoadedApp> {
  const { loadApp } = await import('../kernel/load-app.js');
  return loadApp({ configPath });
}

/** The resolved config of the app at `configPath`, for a command that reads nothing else. */
export async function loadAppConfig(configPath: string): Promise<ResolvedAppConfig> {
  return (await loadCliApp(configPath)).config;
}
