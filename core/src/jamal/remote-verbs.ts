/**
 * Jamal's `status` verb: list the containers on the production server. The
 * app container's logs and shell are `jamal app logs` and `jamal app exec`;
 * the bare `logs` and `exec` verbs always act on the local project.
 */

import { loadConfigOrReport, type JamalDeps } from './deps.js';
import { remoteStatusArgv } from './production/execute.js';
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
