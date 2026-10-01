/**
 * Run one remote command over ssh and forward its output.
 *
 * Shared by the production inspection, app, accessory, and domain verbs. The
 * ssh connection honours `config.production.ssh` (user, port, keys, proxy
 * command, config file). A spawn failure or timeout returns 1; a non-zero exit
 * forwards stdout/stderr and returns the command's exit code. With `stream`,
 * output goes straight to the terminal as it arrives (a followed log), and
 * `timeoutMs: null` lets it run until the operator interrupts it. The label is
 * a fixed verb name, never caller input.
 */

import { formatError } from '../errors/inspect.js';
import { remoteRunnerFor, type JamalDeps, type RemoteTarget } from './deps.js';
import type { RemoteRunOptions } from './production/transport.js';

/** Per-call options for {@link runRemoteCommand}. */
export interface RemoteCommandOptions {
  readonly stream?: boolean;
  readonly timeoutMs?: number | null;
}

export async function runRemoteCommand(
  deps: JamalDeps,
  target: RemoteTarget,
  argv: readonly string[],
  label: string,
  options: RemoteCommandOptions = {},
): Promise<number> {
  const remote = remoteRunnerFor(deps, target);
  const runOptions: RemoteRunOptions = {
    ...(options.stream === true ? { stream: true } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  let result;
  try {
    result =
      Object.keys(runOptions).length === 0
        ? await remote.run(target.server, argv)
        : await remote.run(target.server, argv, runOptions);
  } catch (error) {
    deps.stderr(`jsails: ${label} failed: ${formatError(error)}`);
    return 1;
  }
  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jsails: ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}
