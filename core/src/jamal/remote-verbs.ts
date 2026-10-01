/**
 * Jamal remote verbs over the production server: `status`, and the routing of
 * `logs`/`exec` to the latest deployed container when a production config is
 * present.
 */

import { loadConfigOrReport, readHistoryOrReport, type JamalDeps } from './deps.js';
import { usageFailure } from './plan-command.js';
import { containerNameForTag } from './production/plan.js';
import { remoteExecArgv, remoteLogsArgv, remoteStatusArgv } from './production/execute.js';
import { runRemoteCommand } from './remote-command.js';

/** `jamal status`: list containers on the production server. */
export async function runRemoteStatusVerb(deps: JamalDeps): Promise<number> {
  const config = await loadConfigOrReport(deps);
  if (config === undefined) {
    return 1;
  }
  if (config.production === undefined) {
    deps.stderr('jsails: config.production is required for `jamal status`');
    return 1;
  }
  return runRemoteCommand(deps, config.production.server, remoteStatusArgv(), 'status');
}

/**
 * Route `logs`/`exec` to the remote container when a production config is
 * present, else resolve `undefined` so the caller falls back to the local
 * Compose project. The container is the latest recorded deploy.
 */
export async function routeRemoteLogsOrExec(
  deps: JamalDeps,
  verb: 'logs' | 'exec',
  rest: readonly string[],
  values: { readonly follow: boolean },
  args: readonly string[],
): Promise<number | undefined> {
  const config = await loadConfigOrReport(deps);
  if (config === undefined || config.production === undefined) {
    return undefined;
  }
  const history = await readHistoryOrReport(deps);
  if (history === undefined) {
    return 1;
  }
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) {
    deps.stderr('jsails: no deploy history to inspect');
    return 1;
  }
  const container = containerNameForTag(config.service, entry.tag);
  const server = config.production.server;
  if (verb === 'logs') {
    if (rest.length > 0) {
      return usageFailure(
        deps,
        `"jamal logs" takes no arguments in remote mode; got: ${rest.join(' ')}`,
      );
    }
    return runRemoteCommand(
      deps,
      server,
      remoteLogsArgv(container, { follow: values.follow }),
      'logs',
    );
  }
  if (!args.includes('--')) {
    return usageFailure(
      deps,
      '"jamal exec" requires "--" before the command: jsails jamal exec -- <cmd...>',
    );
  }
  if (rest.length === 0) {
    return usageFailure(deps, '"jamal exec" requires a command after "--"');
  }
  return runRemoteCommand(deps, server, remoteExecArgv(container, rest), 'exec');
}
