/**
 * `jsails config:export [--dir <path>]`: write the active config of every set
 * to the sync directory. Output names sets and files, never values.
 */

import { defineCommand, type DefinedCommand } from 'jsails/kernel';

import { configSyncToken, configToken } from '../plugin.js';
import { exportConfig } from '../sync.js';
import { DIR_OPTION, reportConfigFailure, syncDirOf } from './sync-command.js';

/**
 * The `config:export` command, which this package's `jsails.commands` lists.
 *
 * @public
 */
const exportCommand: DefinedCommand<
  { readonly dir: typeof DIR_OPTION },
  { readonly services: readonly [] }
> = defineCommand({
  summary: 'Write the active config of every set to the sync directory',
  options: { dir: DIR_OPTION },
  needs: { services: [] },
  run: (context) =>
    reportConfigFailure(context, async () => {
      const config = context.services.registry.get(configToken);
      const { dir } = context.services.registry.get(configSyncToken);
      const result = await exportConfig(config, syncDirOf(context, context.values.dir, dir));
      for (const set of result.written) context.stdout(`wrote ${set}`);
      if (result.written.length === 0) context.stdout('config sync files are up to date');
      for (const file of result.stale) {
        context.stdout(
          `stale ${file}: no declared set has this name; delete it or declare the set`,
        );
      }
      return 0;
    }),
});

export default exportCommand;
