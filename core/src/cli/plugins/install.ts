/**
 * The `install`/`uninstall` lifecycle subcommands. They manage installed
 * bundles through the plugin installer and never evaluate plugin code; every
 * failure is value-free and exits non-zero.
 *
 * When the app config enables managed plugins (`plugins.managed: true`), both
 * operations use the same database-backed state source the enable/disable/
 * rollback commands use. A managed install therefore writes the bundle to the
 * plugins folder and its state to `jsails_plugin_state`; a managed uninstall
 * removes both. Non-managed installs keep the installer's JSON state store.
 */

import { resolve } from 'node:path';

import type { DataSource } from 'typeorm';

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/index.js';
import { formatError } from '../../internal/errors.js';
import { createDatabasePluginStateStore } from '../../plugins/database-state-store.js';
import { createPluginInstaller } from '../../plugins/installer.js';
import type { PluginStateSource } from '../../plugins/state-store.js';

import type { ParsedValues, PluginsDeps } from '../plugins-commands.js';
import { resolvePluginsDir } from './list.js';
import {
  defaultLoadAppPlugins,
  defaultLoadDataSource,
  fail,
  safeMessage,
  usageFailure,
  type AppPluginSettings,
} from './state.js';

/** Default database config path for managed installs. */
const DEFAULT_DB_CONFIG_PATH = 'jsails.config.js';

/** The app config path a lifecycle command reads. */
function appConfigPath(deps: PluginsDeps, values: ParsedValues): string {
  return resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);
}

/** The database seam opened only in managed mode. */
interface ManagedState {
  readonly dataSource?: DataSource;
  readonly stateStore?: PluginStateSource;
}

/** Open the DB state source when `plugins.managed` is true. */
async function openManagedState(
  deps: PluginsDeps,
  values: ParsedValues,
  settings: AppPluginSettings | undefined,
): Promise<ManagedState> {
  if (settings?.managed !== true) {
    return {};
  }
  const dbConfigPath = resolve(deps.cwd, values['db-config'] ?? DEFAULT_DB_CONFIG_PATH);
  const dataSource = await (deps.loadDataSource ?? defaultLoadDataSource)(dbConfigPath);
  await dataSource.initialize();
  const stateStore = (deps.createStateStore ?? createDatabasePluginStateStore)({ dataSource });
  return { dataSource, stateStore };
}

/** Close a managed data source, preserving an earlier command failure. */
async function closeManagedState(
  managed: ManagedState,
  deps: PluginsDeps,
  result: number,
): Promise<number> {
  if (managed.dataSource === undefined) {
    return result;
  }
  try {
    await managed.dataSource.destroy();
    return result;
  } catch {
    return result === 0
      ? fail(deps, 'the managed plugin state database could not be closed')
      : result;
  }
}

/**
 * `install`: refuse a code-enabled id, then download/verify/install the bundle.
 * The conflict check reads the app config's `plugins.enabled` when the config is
 * present; a broken config is surfaced value-free so no installer step runs.
 */
export async function runInstall(
  id: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  if (values.version === undefined) {
    return usageFailure(deps, 'plugins install requires --version');
  }
  if (values.url === undefined) {
    return usageFailure(deps, 'plugins install requires --url');
  }
  const version = values.version;
  const url = values.url;

  let settings: AppPluginSettings | undefined;
  try {
    settings = await (deps.loadAppPlugins ?? defaultLoadAppPlugins)(appConfigPath(deps, values));
  } catch (error) {
    return fail(deps, safeMessage(error, 'the app config could not be read'));
  }
  if ((settings?.enabled ?? []).includes(id)) {
    return fail(
      deps,
      `plugin ${JSON.stringify(id)} is code-enabled in the app config; refusing to install over it`,
    );
  }

  let pluginsDir: string;
  try {
    pluginsDir = resolvePluginsDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  let managed: ManagedState;
  try {
    managed = await openManagedState(deps, values, settings);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the managed plugin state database could not be opened'));
  }
  const installer = (deps.createInstaller ?? createPluginInstaller)({
    pluginsDir,
    ...(managed.stateStore === undefined ? {} : { stateStore: managed.stateStore }),
  });

  const sha256 = values.sha256?.trim();
  const checksums =
    sha256 === undefined || sha256 === '' ? undefined : { [artifactName(url)]: sha256 };

  let result = 0;
  try {
    const installed = await installer.install({
      id,
      version,
      url,
      checksums,
      signature: values.signature,
      force: values.force,
    });
    deps.stdout(`Installed ${installed.id}@${installed.version}.`);
    for (const warning of installed.warnings) {
      deps.stderr(`jsails: warning: ${warning}`);
    }
  } catch (error) {
    result = fail(deps, safeMessage(error, 'plugin install failed'));
  } finally {
    result = await closeManagedState(managed, deps, result);
  }
  return result;
}

/** `uninstall`: remove the installed bundle and its managed state. */
export async function runUninstall(
  id: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  let settings: AppPluginSettings | undefined;
  try {
    settings = await (deps.loadAppPlugins ?? defaultLoadAppPlugins)(appConfigPath(deps, values));
  } catch (error) {
    return fail(deps, safeMessage(error, 'the app config could not be read'));
  }
  if ((settings?.enabled ?? []).includes(id)) {
    return fail(
      deps,
      `plugin ${JSON.stringify(id)} is code-enabled in the app config; refusing to uninstall it`,
    );
  }

  let pluginsDir: string;
  try {
    pluginsDir = resolvePluginsDir(deps.cwd, values.dir);
  } catch (error) {
    deps.stderr(`jsails: ${formatError(error)}`);
    return 1;
  }

  let managed: ManagedState;
  try {
    managed = await openManagedState(deps, values, settings);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the managed plugin state database could not be opened'));
  }
  const installer = (deps.createInstaller ?? createPluginInstaller)({
    pluginsDir,
    ...(managed.stateStore === undefined ? {} : { stateStore: managed.stateStore }),
  });

  let result = 0;
  try {
    await installer.uninstall(id, { force: values.force === true });
    deps.stdout(`Uninstalled ${id}.`);
  } catch (error) {
    result = fail(deps, safeMessage(error, 'plugin uninstall failed'));
  } finally {
    result = await closeManagedState(managed, deps, result);
  }
  return result;
}

/** Derive the bundle artifact name from a URL's path basename (query/fragment stripped). */
function artifactName(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? '';
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}
