/**
 * The `config:export` and `config:import` CLI commands the `config` plugin
 * contributes. Each runs over the plugin's own config service, so the sets,
 * store, and overrides are exactly the app's. The sync directory resolves
 * against the app config's directory, not the shell's, and the store is closed
 * before the command returns so the process can exit.
 *
 * Output names sets and keys, never values; failures print a value-free line.
 */

import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

import type { CliCommand, CliCommandContext } from 'jsails/extensions';

import type { Config } from './config.js';
import { ConfigError } from './config-error.js';
import { applyImport, exportConfig, planImport } from './sync.js';

const EXPORT_USAGE = 'jsails config:export [--dir <path>]';
const IMPORT_USAGE = 'jsails config:import [--dir <path>] [--dry-run]';

function syncDir(context: CliCommandContext, fallback: string, flag: string | undefined): string {
  const dir = flag ?? fallback;
  return isAbsolute(dir) ? dir : join(dirname(context.configPath), dir);
}

function parse(
  rawArgs: readonly string[],
  context: CliCommandContext,
  usage: string,
  dryRun: boolean,
): { dir?: string; dryRun: boolean } | undefined {
  try {
    const { values } = parseArgs({
      args: [...rawArgs],
      options: {
        dir: { type: 'string' },
        ...(dryRun ? { 'dry-run': { type: 'boolean' as const } } : {}),
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      ...(typeof values.dir === 'string' ? { dir: values.dir } : {}),
      dryRun: values['dry-run'] === true,
    };
  } catch {
    context.stderr(`jsails: usage: ${usage}`);
    return undefined;
  }
}

/** Run `body`, report a failure value-free, and always close the store. */
async function guarded(
  config: Config,
  context: CliCommandContext,
  body: () => Promise<number>,
): Promise<number> {
  let code: number;
  try {
    code = await body();
  } catch (error) {
    context.stderr(
      error instanceof ConfigError
        ? `jsails: ${error.message}${error.set === undefined ? '' : ` (${error.set}${error.key === undefined ? '' : `.${error.key}`})`}`
        : 'jsails: the config command failed',
    );
    code = 1;
  }
  try {
    await config.store.close?.();
  } catch {
    context.stderr('jsails: the config store could not be closed');
    code = 1;
  }
  return code;
}

/** Build the two commands over a config service and its default sync directory. */
export function configCommands(config: Config, defaultDir: string): readonly CliCommand[] {
  const exportCommand: CliCommand = {
    name: 'config:export',
    summary: 'Write the active config of every set to the sync directory',
    usage: EXPORT_USAGE,
    audience: 'developer',
    run: async (rawArgs, context) => {
      const args = parse(rawArgs, context, EXPORT_USAGE, false);
      if (args === undefined) return 2;
      return guarded(config, context, async () => {
        const result = await exportConfig(config, syncDir(context, defaultDir, args.dir));
        for (const set of result.written) context.stdout(`wrote ${set}`);
        if (result.written.length === 0) context.stdout('config sync files are up to date');
        for (const file of result.stale) {
          context.stdout(
            `stale ${file}: no declared set has this name; delete it or declare the set`,
          );
        }
        return 0;
      });
    },
  };

  const importCommand: CliCommand = {
    name: 'config:import',
    summary: 'Apply the sync directory to the active config, all or nothing',
    usage: IMPORT_USAGE,
    audience: 'developer',
    run: async (rawArgs, context) => {
      const args = parse(rawArgs, context, IMPORT_USAGE, true);
      if (args === undefined) return 2;
      return guarded(config, context, async () => {
        const plan = await planImport(config, syncDir(context, defaultDir, args.dir));
        const verb = args.dryRun ? 'would update' : 'updated';
        if (!args.dryRun) await applyImport(config, plan);
        for (const change of plan.changes) {
          context.stdout(`${verb} ${change.set}: ${change.keys.join(', ')}`);
        }
        if (plan.changes.length === 0)
          context.stdout('active config already matches the sync files');
        for (const set of plan.missing) context.stdout(`no sync file for ${set}; left unchanged`);
        return 0;
      });
    },
  };

  return Object.freeze([exportCommand, importCommand]);
}
