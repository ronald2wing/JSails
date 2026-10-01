/**
 * `jsails config:import [--dir <path>] [--dry-run]`: apply the sync directory
 * to the active config, all or nothing. Output names sets and keys, never
 * values.
 */

import { defineCommand, type DefinedCommand } from 'jsails/kernel';

import { configSyncToken, configToken } from '../plugin.js';
import { applyImport, planImport } from '../sync.js';
import { DIR_OPTION, reportConfigFailure, syncDirOf } from './sync-command.js';

/**
 * The `config:import` command, which this package's `jsails.commands` lists.
 *
 * @public
 */
const importCommand: DefinedCommand<
  {
    readonly dir: typeof DIR_OPTION;
    readonly 'dry-run': { readonly type: 'boolean'; readonly summary: string };
  },
  { readonly services: readonly [] }
> = defineCommand({
  summary: 'Apply the sync directory to the active config, all or nothing',
  options: {
    dir: DIR_OPTION,
    'dry-run': { type: 'boolean', summary: 'Print what would change, and change nothing' },
  },
  needs: { services: [] },
  run: (context) =>
    reportConfigFailure(context, async () => {
      const config = context.services.registry.get(configToken);
      const { dir } = context.services.registry.get(configSyncToken);
      const dryRun = context.values['dry-run'] === true;
      const plan = await planImport(config, syncDirOf(context, context.values.dir, dir));
      if (!dryRun) await applyImport(config, plan);
      const verb = dryRun ? 'would update' : 'updated';
      for (const change of plan.changes) {
        context.stdout(`${verb} ${change.set}: ${change.keys.join(', ')}`);
      }
      if (plan.changes.length === 0) context.stdout('active config already matches the sync files');
      for (const set of plan.missing) context.stdout(`no sync file for ${set}; left unchanged`);
      return 0;
    }),
});

export default importCommand;
