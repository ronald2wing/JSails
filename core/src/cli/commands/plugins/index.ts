/**
 * The `plugins` builtin command: list and check the JSails plugin packages an
 * application depends on.
 *
 * The dispatcher parses its flags against the manifest's descriptor; this
 * module routes the subcommand to the read-only `list` and `check` reports
 * (`./list`). Plugins run only when the app config lists them in
 * `plugins.use`; nothing this command does activates, installs, or changes
 * one. The subcommands of the old installer and state store are refused with
 * a usage error that says so, without echoing anything the caller typed.
 *
 * The command reads `package.json` manifests only, never imports plugin entry
 * code, and every failure is value-free.
 */

import type { CommandModule, CommandValues } from '../../descriptor.js';
import type { PLUGINS_OPTIONS } from '../../manifest.js';
import { runDiscoverCommand } from './list.js';

/** Dependency seam for the `plugins` command. Tests inject cwd, output sinks, and the version. */
export interface PluginsDeps {
  /** Working directory whose `package.json` and `node_modules` are read. */
  readonly cwd: string;
  /** Framework version to check against; defaults to the installed framework's. */
  readonly frameworkVersion?: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

const SUBCOMMANDS: ReadonlySet<string> = new Set(['list', 'check']);

/**
 * The subcommands of the deleted installer and plugin state store. Each is
 * refused with one fixed message rather than as an unknown subcommand, so an
 * old script learns where plugins come from now.
 */
const REMOVED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'install',
  'uninstall',
  'enable',
  'disable',
  'rollback',
  'resolve',
  'export',
  'import',
]);

const REMOVED_MESSAGE =
  'that plugins subcommand was removed: plugins run when the app config lists them in plugins.use';

/**
 * Run `jsails plugins` over its parsed values and positionals. The positional
 * is variadic so a removed subcommand with its old operands still gets the
 * removal message rather than an argument count.
 */
export function runPluginsCommand(
  values: CommandValues<typeof PLUGINS_OPTIONS>,
  positionals: readonly string[],
  deps: PluginsDeps,
  usage: (message: string) => number,
): number {
  const subcommand = positionals[0] ?? 'list';
  if (REMOVED_SUBCOMMANDS.has(subcommand)) return usage(REMOVED_MESSAGE);
  if (!SUBCOMMANDS.has(subcommand))
    return usage('unknown subcommand: the subcommands are list and check');
  if (positionals.length > 1) return usage(`unexpected argument after ${subcommand}`);
  return runDiscoverCommand(subcommand as 'list' | 'check', { json: values.json === true }, deps);
}

/** `jsails plugins [list|check]`. */
export const pluginsCommand: CommandModule<typeof PLUGINS_OPTIONS, 'nothing'> = {
  run: (context) =>
    runPluginsCommand(
      context.values,
      context.positionals,
      {
        cwd: context.cwd,
        stdout: (text) => context.stdout(text),
        stderr: (text) => context.stderr(text),
      },
      (message) => context.usage(message),
    ),
};
