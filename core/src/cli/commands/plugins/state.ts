/**
 * Shared state and lifecycle helpers for the `plugins` command.
 *
 * This module is the dependency leaf of the plugins command: it owns the
 * value-free error discipline, the per-subcommand flag allowlists, the default
 * app-config/data-source loaders, and the managed-state mutations
 * (`enable`/`disable`/`rollback`) shared by the lifecycle subcommands. It reads
 * manifests, config modules, and the plugin state database only — it never
 * imports plugin code.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { DataSource } from 'typeorm';

import { DEFAULT_APP_CONFIG_PATH } from '../../../app/config/defaults.js';
import { AppConfigError } from '../../../app/config/errors.js';
import { usageFailure as reportUsageFailure } from '../../usage-error.js';
import { isTypeScriptConfig } from '../../../config-modules.js';
import { JsailsError } from '../../../errors/jsails-error.js';
import type { createDatabasePluginStateStore } from '../../../plugins/database-state-store.js';
import { PluginEnablementError } from '../../../plugins/enablement.js';
import type { createPluginInstaller } from '../../../plugins/installer.js';
import { PluginInstallerError } from '../../../plugins/installer-error.js';
import { PluginSnapshotError } from '../../../plugins/snapshot-error.js';
import { PluginStateError } from '../../../plugins/state-error.js';
import type { PluginStateEntry } from '../../../plugins/state-store.js';

import type { ParsedValues, PluginsDeps } from './index.js';
import { DEFAULT_DATABASE_CONFIG_PATH } from '../../../config-modules.js';
import { loadAppConfig, loadDataSourceConfig } from '../../config-loader.js';

/** The plugin settings the lifecycle commands read from the app config. */
export interface AppPluginSettings {
  /** Plugin ids enabled out of the box (code-managed; install refuses these). */
  readonly enabled?: readonly string[];
  /** Whether plugin state is managed in the database. */
  readonly managed?: boolean;
  /**
   * The absolute plugins folder the server scans (`plugins.pluginsDir`
   * resolved against the app's `rootDir`, default `<storageDir>/plugins`).
   */
  readonly pluginsDir?: string;
}

/** Machine-readable reason for a {@link PluginsCommandError}. */
type PluginsCommandErrorCode = 'unsupported_config' | 'invalid_config' | 'not_found';

/** A value-free error raised by this command; its message is safe to echo. */
class PluginsCommandError extends JsailsError {
  constructor(
    readonly code: PluginsCommandErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Report a usage failure (exit 2) with the plugins help hint. */
export function usageFailure(deps: PluginsDeps, message: string): number {
  return reportUsageFailure(deps, 'Run "jsails plugins --help" for usage.', message);
}

/** Report a runtime (non-usage) failure with a value-free message; exit 1. */
export function fail(deps: PluginsDeps, message: string): number {
  deps.stderr(`jsails: ${message}`);
  return 1;
}

/**
 * The database-backed state store factory, imported when a subcommand opens
 * managed state: it loads TypeORM, which discovery, `check`, and an unmanaged
 * app never need.
 */
export async function loadDatabaseStateStore(): Promise<typeof createDatabasePluginStateStore> {
  return (await import('../../../plugins/database-state-store.js')).createDatabasePluginStateStore;
}

/** The bundle installer factory, imported by `install` and `uninstall` only. */
export async function loadPluginInstaller(): Promise<typeof createPluginInstaller> {
  return (await import('../../../plugins/installer.js')).createPluginInstaller;
}

/** Read the app config's plugin settings; `undefined` when the config is absent. */
export async function defaultLoadAppPlugins(
  configPath: string,
): Promise<AppPluginSettings | undefined> {
  if (!existsSync(configPath)) {
    return undefined;
  }
  const resolved = await loadAppConfig(configPath);
  return {
    enabled: resolved.plugins?.enabled,
    managed: resolved.plugins?.managed,
    pluginsDir: resolved.pluginsDir,
  };
}

/** Load a compiled database config module default-exporting a `JsailsDataSource`. */
export async function defaultLoadDataSource(configPath: string): Promise<DataSource> {
  if (isTypeScriptConfig(configPath)) {
    throw new PluginsCommandError(
      'unsupported_config',
      'the database config is a TypeScript module; compile it to JavaScript first',
    );
  }
  try {
    return await loadDataSourceConfig(configPath);
  } catch {
    throw new PluginsCommandError('invalid_config', 'failed to load the database config');
  }
}

/** Echo only value-free error messages; anything else falls back to a fixed message. */
export function safeMessage(error: unknown, fallback: string): string {
  if (
    error instanceof PluginsCommandError ||
    error instanceof PluginInstallerError ||
    error instanceof PluginStateError ||
    error instanceof PluginSnapshotError ||
    error instanceof AppConfigError ||
    error instanceof PluginEnablementError
  ) {
    return error.message;
  }
  return fallback;
}

/** The flags each subcommand may carry (everything else is a usage error). */
const SUBCOMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  list: new Set(['dir', 'config', 'json']),
  check: new Set(['dir', 'config', 'json']),
  resolve: new Set(['config', 'db-config', 'json']),
  install: new Set([
    'dir',
    'config',
    'db-config',
    'version',
    'url',
    'sha256',
    'signature',
    'allow-unverified',
    'force',
  ]),
  uninstall: new Set(['dir', 'config', 'db-config', 'force']),
  enable: new Set(['config', 'db-config']),
  disable: new Set(['config', 'db-config']),
  rollback: new Set(['config', 'db-config']),
  export: new Set(['dir', 'config', 'db-config', 'output']),
  import: new Set(['dir', 'config', 'db-config', 'force']),
};

/** The flags explicitly present in the parsed values (defaults are ignored). */
export function explicitlySetFlags(values: ParsedValues): string[] {
  const flags: string[] = [];
  if (values.dir !== undefined) flags.push('dir');
  if (values.json === true) flags.push('json');
  if (values.config !== undefined) flags.push('config');
  if (values['db-config'] !== undefined) flags.push('db-config');
  if (values.version !== undefined) flags.push('version');
  if (values.url !== undefined) flags.push('url');
  if (values.sha256 !== undefined) flags.push('sha256');
  if (values.signature !== undefined) flags.push('signature');
  if (values['allow-unverified'] === true) flags.push('allow-unverified');
  if (values.force === true) flags.push('force');
  if (values.output !== undefined) flags.push('output');
  return flags;
}

/** Reject a flag outside a subcommand's allowlist, or `undefined` when all pass. */
export function rejectFlags(
  subcommand: string,
  flags: readonly string[],
  deps: PluginsDeps,
): number | undefined {
  const allowed = SUBCOMMAND_FLAGS[subcommand] ?? new Set<string>();
  for (const flag of flags) {
    if (!allowed.has(flag)) {
      return usageFailure(deps, `--${flag} is not valid for "plugins ${subcommand}"`);
    }
  }
  return undefined;
}

/**
 * `enable`/`disable`: flip a managed plugin's `enabled` flag in the database,
 * keeping the rest of its entry (persisted settings included).
 */
export async function runManagedToggle(
  id: string,
  enable: boolean,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);
  const dbConfigPath = resolve(deps.cwd, values['db-config'] ?? DEFAULT_DATABASE_CONFIG_PATH);
  return runManagedStateUpdate(deps, configPath, dbConfigPath, id, (entry) => ({
    ...entry,
    enabled: enable,
  }));
}

/** `rollback`: flip a managed plugin's active version, keeping its settings and flag. */
export async function runRollback(
  id: string,
  version: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);
  const dbConfigPath = resolve(deps.cwd, values['db-config'] ?? DEFAULT_DATABASE_CONFIG_PATH);
  return runManagedStateUpdate(deps, configPath, dbConfigPath, id, (entry) => ({
    ...entry,
    active: version,
  }));
}

/**
 * Require a managed app config, then apply `mutate` to one plugin's entry in
 * the database-backed plugin state. Only that entry is written back
 * (`putEntry`): the loaded snapshot can already be stale, and writing the
 * whole document would revert a change another process made to other plugins
 * in the meantime. The data source is initialized before the store is built
 * and destroyed in a `finally`, whether the update succeeds or fails.
 */
async function runManagedStateUpdate(
  deps: PluginsDeps,
  configPath: string,
  dbConfigPath: string,
  id: string,
  mutate: (entry: PluginStateEntry) => PluginStateEntry,
): Promise<number> {
  let settings: AppPluginSettings | undefined;
  try {
    settings = await (deps.loadAppPlugins ?? defaultLoadAppPlugins)(configPath);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the app config could not be read'));
  }
  if (settings?.managed !== true) {
    return fail(deps, 'plugin state is not managed (set plugins.managed in the app config)');
  }

  let dataSource: DataSource;
  try {
    dataSource = await (deps.loadDataSource ?? defaultLoadDataSource)(dbConfigPath);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the plugin state database config could not be loaded'));
  }

  try {
    await dataSource.initialize();
  } catch {
    return fail(deps, 'the plugin state database could not be initialized');
  }

  let result = 0;
  try {
    const store = (deps.createStateStore ?? (await loadDatabaseStateStore()))({ dataSource });
    const state = await store.load();
    const entry = state.plugins[id];
    if (entry === undefined) {
      throw new PluginsCommandError('not_found', 'plugin is not installed');
    }
    await store.putEntry(id, mutate(entry));
    result = 0;
  } catch (error) {
    result = fail(deps, safeMessage(error, 'the plugin state could not be updated'));
  } finally {
    try {
      await dataSource.destroy();
    } catch {
      if (result === 0) {
        result = fail(deps, 'the plugin state database could not be closed');
      }
    }
  }
  return result;
}
