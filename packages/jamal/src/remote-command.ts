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
 *
 * {@link containerDetailsArgv} is the `details` verbs' inspection: an
 * accessory's environment holds the credentials its env file delivered, and
 * any container's may hold a clear secret a config opted onto the command
 * line, so the verbs print a fixed selection of `docker inspect` fields that
 * leaves the environment out.
 */

import { remoteRunnerFor, reportFailure, type JamalDeps, type RemoteTarget } from './deps.js';
import type { RemoteRunOptions, RemoteRunner } from './production/transport.js';

/**
 * The `docker inspect` fields the `details` verbs print, as one JSON object.
 * `Config.Env` is left out on purpose: it carries every credential an
 * accessory read from its env file.
 */
const DETAILS_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Created":{{json .Created}},' +
  '"Image":{{json .Config.Image}},"Cmd":{{json .Config.Cmd}},' +
  '"Labels":{{json .Config.Labels}},"State":{{json .State}},' +
  '"RestartCount":{{json .RestartCount}},"RestartPolicy":{{json .HostConfig.RestartPolicy}},' +
  '"Mounts":{{json .Mounts}},"Networks":{{json .NetworkSettings.Networks}}}';

/** The remote argv that describes one container without its environment. */
export function containerDetailsArgv(container: string): readonly string[] {
  return ['docker', 'inspect', '--type', 'container', '--format', DETAILS_FORMAT, container];
}

/** Per-call options for {@link runRemoteCommand}. */
export interface RemoteCommandOptions {
  readonly stream?: boolean;
  readonly timeoutMs?: number | null;
  /** The runner to send it through (a deploy lock's fenced runner); defaults to the target's. */
  readonly remote?: RemoteRunner;
}

export async function runRemoteCommand(
  deps: JamalDeps,
  target: RemoteTarget,
  argv: readonly string[],
  label: string,
  options: RemoteCommandOptions = {},
): Promise<number> {
  const remote = options.remote ?? remoteRunnerFor(deps, target);

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
    await reportFailure(deps, error, `${label} failed`);
    return 1;
  }
  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jamal: ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}
