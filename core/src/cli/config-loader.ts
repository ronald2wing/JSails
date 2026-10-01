/**
 * Config-module loading for the CLI commands that read a plain default export
 * (the data source, seeders, the console). The app config has its own loader,
 * `loadAppConfig`, which validates and resolves the config object.
 *
 * Every loader shares the "compile TypeScript first" rejection and value-free
 * failure discipline.
 */

import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { JsailsDataSource } from '../database/data-source.js';
import { isTypeScriptConfig } from '../config-modules.js';
import { formatError } from '../errors/inspect.js';
import { bootstrapModels } from '../models/bootstrap.js';

/**
 * Load a compiled config module and return its default export. A TypeScript
 * path is rejected rather than executed; every failure is value-free.
 */
export async function loadConfigModule(configPath: string): Promise<unknown> {
  const absolute = resolve(configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new Error(
      `config "${configPath}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point --config at the compiled output`,
    );
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new Error(`failed to load config "${configPath}": ${formatError(error)}`);
  }
  return (module as { default?: unknown }).default;
}

/** Load a database config module default-exporting a `JsailsDataSource`. */
export async function loadDataSourceConfig(configPath: string): Promise<JsailsDataSource> {
  // Populate the compiler-generated model registry before the config module is
  // imported, so a data source that harvests the registry sees every model with
  // zero user wiring. A project with no registry is a silent no-op.
  await bootstrapModels({ rootDir: dirname(resolve(configPath)) });
  const dataSource = await loadConfigModule(configPath);
  if (!(dataSource instanceof JsailsDataSource)) {
    throw new Error(`config "${configPath}" must default-export a JsailsDataSource instance`);
  }
  return dataSource;
}
