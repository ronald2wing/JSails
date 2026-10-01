/**
 * The `plugins export` / `plugins import` subcommands: round-trip managed
 * plugin state as a deterministic, versioned snapshot document (Drupal
 * `cex`/`cim`, Magento `app:config:dump`).
 *
 * `export` reads the app config, requires `plugins.managed`, loads the
 * database-backed state source, and projects it into a {@link PluginSnapshot};
 * the JSON lands on stdout or, with `--output`, in the file written atomically.
 * `import` reads a snapshot file, validates it, and reconciles the database
 * state only — it never installs bundle files. Both commands never import
 * plugin code and keep every failure value-free.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { DataSource } from 'typeorm';

import { DEFAULT_APP_CONFIG_PATH } from '../../app/config/index.js';
import { createDatabasePluginStateStore } from '../../plugins/database-state-store.js';
import {
  exportPluginSnapshot,
  importPluginSnapshot,
  parsePluginSnapshot,
  PluginSnapshotError,
} from '../../plugins/snapshot.js';

import type { ParsedValues, PluginsDeps } from '../plugins-commands.js';
import { resolvePluginsDir } from './list.js';
import {
  defaultLoadAppPlugins,
  defaultLoadDataSource,
  fail,
  safeMessage,
  type AppPluginSettings,
} from './state.js';

/** Default database config path for the snapshot commands. */
const DEFAULT_DB_CONFIG_PATH = 'jsails.config.js';

/**
 * `export`: refuse a non-managed deployment, then load state and emit the
 * snapshot to stdout or `--output` (written atomically). The data source is
 * initialized before the store loads and destroyed in a `finally`.
 */
export async function runExport(values: ParsedValues, deps: PluginsDeps): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);

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
    dataSource = await (deps.loadDataSource ?? defaultLoadDataSource)(
      resolve(deps.cwd, values['db-config'] ?? DEFAULT_DB_CONFIG_PATH),
    );
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
    const store = (deps.createStateStore ?? createDatabasePluginStateStore)({ dataSource });
    const snapshot = exportPluginSnapshot(await store.load(), { pluginsDir: pluginsDir(deps) });
    const json = `${JSON.stringify(snapshot, null, 2)}\n`;
    if (values.output !== undefined && values.output !== '') {
      writeSnapshotFile(resolve(deps.cwd, values.output), json);
      deps.stdout(`Exported plugin state to ${values.output}.`);
    } else {
      deps.stdout(json);
    }
  } catch (error) {
    result = fail(deps, safeMessage(error, 'the plugin state could not be exported'));
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

/**
 * `import`: read and validate the snapshot file, then reconcile the database
 * state only. Missing bundles are rejected per entry (unless `--force`) and
 * every rejection is reported; the operation is idempotent.
 */
export async function runImport(
  file: string,
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const configPath = resolve(deps.cwd, values.config ?? DEFAULT_APP_CONFIG_PATH);
  const snapshotPath = resolve(deps.cwd, file);

  let settings: AppPluginSettings | undefined;
  try {
    settings = await (deps.loadAppPlugins ?? defaultLoadAppPlugins)(configPath);
  } catch (error) {
    return fail(deps, safeMessage(error, 'the app config could not be read'));
  }
  if (settings?.managed !== true) {
    return fail(deps, 'plugin state is not managed (set plugins.managed in the app config)');
  }

  let raw: string;
  try {
    raw = readFileSync(snapshotPath, 'utf8');
  } catch {
    return fail(deps, 'the plugin snapshot file could not be read');
  }

  let snapshot;
  try {
    snapshot = parsePluginSnapshot(parseSnapshotJson(raw));
  } catch (error) {
    return fail(deps, safeMessage(error, 'the plugin snapshot is invalid'));
  }

  let dataSource: DataSource;
  try {
    dataSource = await (deps.loadDataSource ?? defaultLoadDataSource)(
      resolve(deps.cwd, values['db-config'] ?? DEFAULT_DB_CONFIG_PATH),
    );
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
    const store = (deps.createStateStore ?? createDatabasePluginStateStore)({ dataSource });
    const current = await store.load();
    const built = importPluginSnapshot(snapshot, current, {
      pluginsDir: pluginsDir(deps),
      force: values.force === true,
    });
    await store.save(built.state);
    for (const entry of built.rejected) {
      const label = entry.id === undefined ? 'an entry' : `plugin "${entry.id}"`;
      deps.stderr(`jsails: warning: ${label} was rejected (${entry.code})`);
    }
    deps.stdout(`Imported ${Object.keys(built.state.plugins).length} plugin(s).`);
  } catch (error) {
    result = fail(deps, safeMessage(error, 'the plugin state could not be imported'));
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

/** Parse a snapshot body, mapping a JSON syntax failure to a value-free error. */
function parseSnapshotJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginSnapshotError('plugin snapshot is not valid JSON');
  }
  return parsed;
}

/** Resolve the plugins folder (default `<cwd>/storage/plugins`). */
function pluginsDir(deps: PluginsDeps): string {
  return resolvePluginsDir(deps.cwd, undefined);
}

/** Write `body` to `path` atomically (temp file + rename). */
function writeSnapshotFile(path: string, body: string): void {
  let parent: string;
  try {
    parent = dirname(path);
  } catch {
    throw new PluginSnapshotError('plugin snapshot output path is invalid');
  }
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    throw new PluginSnapshotError('plugin snapshot output directory could not be created');
  }
  const temp = `${path}.tmp`;
  try {
    writeFileSync(temp, body);
    renameSync(temp, path);
  } catch {
    throw new PluginSnapshotError('plugin snapshot could not be written');
  }
}
