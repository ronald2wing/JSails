/**
 * Config-module loading for the CLI commands that read a plain default export
 * (the data source, seeders, the console), and the commands' entry to the app
 * config loader, which validates and resolves the config object.
 *
 * Every loader shares the "compile TypeScript first" rejection and value-free
 * failure discipline. Importing this module loads none of what a loader needs
 * once called (the app config schema and Zod, the data-source class), so a
 * command imports it for its help and usage paths at no cost.
 */

import { dirname, resolve } from 'node:path';

import type { ResolvedAppConfig } from '../app/config/index.js';
import type { JsailsDataSource } from '../database/data-source.js';
import { isTypeScriptConfig } from '../config-modules.js';
import { formatError } from '../errors/inspect.js';
import { bootstrapModels } from '../models/bootstrap.js';
import { importFile } from '../support/project-paths.server.js';

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
    throw new Error(
      `config "${configPath}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point --config at the compiled output`,
    );
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
    throw new Error(`failed to load config "${configPath}": ${formatError(error)}`);
  }
  return (module as { default?: unknown }).default;
}

/** Load a database config module default-exporting a `JsailsDataSource`. */
export async function loadDataSourceConfig(
  configPath: string,
  options: ConfigModuleLoadOptions = {},
): Promise<JsailsDataSource> {
  // Populate the compiler-generated model registry before the config module is
  // imported, so a data source that harvests the registry sees every model with
  // zero user wiring. A project with no registry is a silent no-op.
  await bootstrapModels({ rootDir: dirname(resolve(configPath)) });
  const dataSource = await loadConfigModule(configPath, options);
  // A database config imports `jsails/database` itself, so this import is
  // already in the module cache whenever the check can pass.
  const { JsailsDataSource } = await import('../database/data-source.js');
  if (!(dataSource instanceof JsailsDataSource)) {
    throw new Error(`config "${configPath}" must default-export a JsailsDataSource instance`);
  }
  return dataSource;
}

/** Load and resolve the app config module (`loadAppConfig` of the app config barrel). */
export async function loadAppConfig(configPath: string): Promise<ResolvedAppConfig> {
  const { loadAppConfig: load } = await import('../app/config/load.js');
  return load(configPath);
}
