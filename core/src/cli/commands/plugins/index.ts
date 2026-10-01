/**
 * The `plugins` builtin command: discover, check, and manage JSails plugins.
 *
 * This module is the thin dispatcher: it parses arguments, gates the subcommand
 * and its flags, and routes to the read-only `list`/`check` (`.plugins/list`),
 * the installer-backed `install`/`uninstall` (`.plugins/install`), and the
 * managed-state `enable`/`disable`/`rollback` (`.plugins/state`) subcommands.
 *
 * The command reads manifests and config modules only, never imports plugin
 * entry code; every failure is value-free and exits non-zero. `--json` applies
 * only to `list`/`check`. Each subcommand's module is imported once it is
 * chosen, and the installer and the database-backed state store (TypeORM) only
 * by the subcommands that use them, so help, usage errors, and discovery load
 * neither.
 */

import { parseArgs } from 'node:util';

import type { DataSource } from 'typeorm';

import { formatError } from '../../../errors/inspect.js';
import type { DatabasePluginStateStoreOptions } from '../../../plugins/database-state-store.js';
import type { PluginInstaller, PluginInstallerOptions } from '../../../plugins/installer.js';
import { PLUGIN_ID_PATTERN } from '../../../plugins/manifest/plugin-id.js';
import { isValidSemverVersion } from '../../../plugins/manifest/semver.js';
import type { PluginStateSource } from '../../../plugins/state-store.js';

import {
  defaultLoadAppPlugins,
  defaultLoadDataSource,
  explicitlySetFlags,
  fail,
  rejectFlags,
  runManagedToggle,
  runRollback,
  usageFailure,
  type AppPluginSettings,
} from './state.js';

/** Dependency seam for the `plugins` command. Tests inject cwd + output sinks + factories. */
export interface PluginsDeps {
  /** Working directory the plugins folder and config paths resolve against. */
  readonly cwd: string;
  /** Framework version to check against; defaults to {@link readFrameworkVersion}. */
  readonly frameworkVersion?: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Load the app config's plugin settings, or `undefined` when the config is absent. */
  loadAppPlugins?(configPath: string): Promise<AppPluginSettings | undefined>;
  /** Load the database config module default-exporting a `JsailsDataSource`. */
  loadDataSource?(configPath: string): Promise<DataSource>;
  /** Build the plugin installer for a plugins directory; defaults to the real installer. */
  createInstaller?(options: PluginInstallerOptions): PluginInstaller;
  /** Build the plugin state store; defaults to the database-backed store. */
  createStateStore?(options: DatabasePluginStateStoreOptions): PluginStateSource;
}

const defaultPluginsDeps: PluginsDeps = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  loadAppPlugins: defaultLoadAppPlugins,
  loadDataSource: defaultLoadDataSource,
};

const PLUGINS_OPTIONS = {
  dir: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  config: { type: 'string' },
  'db-config': { type: 'string' },
  version: { type: 'string' },
  url: { type: 'string' },
  sha256: { type: 'string' },
  signature: { type: 'string' },
  'allow-unverified': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  output: { type: 'string' },
} as const;

const PLUGINS_USAGE = `plugins - discover, check, and manage installed JSails plugins

Usage:
  jsails plugins [list|check|resolve] [options]
  jsails plugins install <id> --version <v> --url <tgz> --sha256 <hex> [--force] [options]
  jsails plugins install <id> --version <v> --url <tgz> --allow-unverified [--force] [options]
  jsails plugins enable <id> [options]
  jsails plugins disable <id> [options]
  jsails plugins uninstall <id> [--force] [options]
  jsails plugins rollback <id> <version> [options]
  jsails plugins export [--output <path>] [options]
  jsails plugins import <file> [--force] [options]

Subcommands:
  list        List discovered plugins with their provenance (default)
  check       Validate plugins against the framework version
  resolve     Resolve plugin enablement from the code list and managed state
  install     Download and install a plugin bundle
  enable      Enable a managed plugin in the plugin state database
  disable     Disable a managed plugin in the plugin state database
  uninstall   Remove an installed plugin bundle
  rollback    Flip the active version of a managed plugin
  export      Export managed plugin state as a snapshot document
  import      Import a snapshot document into managed plugin state

Options:
  --dir <path>        Plugins folder override, inside cwd (list/check/install/uninstall/
                      export/import; default: the app config's plugins.pluginsDir,
                      else <cwd>/storage/plugins)
  --json              Emit machine-readable JSON (list/check/resolve only)
  --config <path>     App config module (default: jsails.app.js)
  --db-config <path>  Database config module (install/uninstall/enable/disable/rollback/resolve/
                      export/import; default: jsails.database.js)
  --version <v>       Plugin version (install; required)
  --url <tgz>         Bundle URL (install; required; loopback and private-network
                      hosts are allowed, since the URL comes from the operator)
  --sha256 <hex>      Bundle SHA-256 checksum (install; required unless --allow-unverified)
  --signature <b64>   Detached bundle signature (install; refused: the CLI has no
                      signature verifier, so a signature could never be checked)
  --allow-unverified  Install a bundle with no checksum, logged as a warning (install;
                      plain http: is then accepted for loopback hosts only)
  --force             Bypass the dependency guard (install/uninstall/import)
  --output <path>     Snapshot output path (export; default: stdout)
  -h, --help          Show this help

Plugins are discovered from direct npm dependencies that self-identify through
their package.json "jsails" field, and from manifest.json bundles in the plugins
folder. The command reads manifests and config modules only and never imports
plugin code.
`;

const SUBCOMMANDS = new Set([
  'list',
  'check',
  'install',
  'enable',
  'disable',
  'uninstall',
  'rollback',
  'resolve',
  'export',
  'import',
]);

/** The flags the `plugins` command parses (all optional; defaults are ignored). */
export interface ParsedValues {
  readonly dir?: string;
  readonly json?: boolean;
  readonly config?: string;
  readonly 'db-config'?: string;
  readonly version?: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly signature?: string;
  readonly 'allow-unverified'?: boolean;
  readonly force?: boolean;
  readonly output?: string;
}

/** Run `jsails plugins` over the tokens after the command name. */
export async function runPluginsCommand(
  args: readonly string[],
  deps: PluginsDeps = defaultPluginsDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: PLUGINS_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(PLUGINS_USAGE);
    return 0;
  }

  const subcommand = positionals[0] ?? 'list';
  if (!SUBCOMMANDS.has(subcommand)) {
    return usageFailure(deps, `unknown subcommand ${JSON.stringify(subcommand)}`);
  }

  if (subcommand === 'list' || subcommand === 'check') {
    if (positionals.length > 1) {
      return usageFailure(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
    }
    const { runDiscoverCommand } = await import('./list.js');
    return runDiscoverCommand(subcommand, values, deps);
  }

  if (subcommand === 'resolve') {
    if (positionals.length > 1) {
      return usageFailure(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
    }
    const { runResolve } = await import('./resolve.js');
    return runResolve(values, deps);
  }

  if (subcommand === 'export') {
    const rejected = rejectFlags(subcommand, explicitlySetFlags(values), deps);
    if (rejected !== undefined) {
      return rejected;
    }
    if (positionals.length > 1) {
      return usageFailure(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
    }
    const { runExport } = await import('./snapshot.js');
    return runExport(values, deps);
  }

  if (subcommand === 'import') {
    const rejected = rejectFlags(subcommand, explicitlySetFlags(values), deps);
    if (rejected !== undefined) {
      return rejected;
    }
    const file = positionals[1];
    if (file === undefined || positionals.length > 2) {
      return usageFailure(deps, 'plugins import requires <file>');
    }
    const { runImport } = await import('./snapshot.js');
    return runImport(file, values, deps);
  }

  return runLifecycleCommand(subcommand, positionals, values, deps);
}

/** Dispatch the lifecycle subcommands after shared gating. */
async function runLifecycleCommand(
  subcommand: string,
  positionals: readonly string[],
  values: ParsedValues,
  deps: PluginsDeps,
): Promise<number> {
  const rejected = rejectFlags(subcommand, explicitlySetFlags(values), deps);
  if (rejected !== undefined) {
    return rejected;
  }

  const id = positionals[1];
  const version = positionals[2];
  if (subcommand === 'rollback') {
    if (id === undefined || version === undefined || positionals.length > 3) {
      return usageFailure(deps, 'plugins rollback requires <id> <version>');
    }
  } else if (id === undefined || positionals.length > 2) {
    return usageFailure(deps, `plugins ${subcommand} requires <id>`);
  }

  if (!PLUGIN_ID_PATTERN.test(id)) {
    return fail(deps, 'plugin id is invalid');
  }

  switch (subcommand) {
    case 'install':
      return (await import('./install.js')).runInstall(id, values, deps);
    case 'uninstall':
      return (await import('./install.js')).runUninstall(id, values, deps);
    case 'enable':
    case 'disable':
      return runManagedToggle(id, subcommand === 'enable', values, deps);
    case 'rollback': {
      if (version === undefined || !isValidSemverVersion(version)) {
        return fail(deps, 'plugin version is invalid');
      }
      return runRollback(id, version, values, deps);
    }
    default:
      return usageFailure(deps, `unknown subcommand ${JSON.stringify(subcommand)}`);
  }
}
