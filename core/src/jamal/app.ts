/**
 * Jamal app lifecycle verbs: `jamal app <verb>`.
 *
 * The seven verbs mirror Kamal's `kamal app <verb>` surface, operating on the
 * LATEST deployed app container on the remote production server. Every verb
 * requires `config.production` for the target SSH server, and `--dry-run`
 * prints the exact `ssh` argv without running it.
 *
 * The container is the latest entry in `.jamal/deploys.json`, resolved via
 * `containerNameForEntry` — a missing history is a value-free error. `logs`
 * streams its output (and runs without a timeout under `--follow`); `boot`
 * reads the container's running state and starts it only when it is stopped.
 */

import { parseArgs } from 'node:util';

import { formatError } from '../errors/inspect.js';
import {
  loadProductionConfigOrReport,
  readHistoryOrReport,
  printRemoteDryRun,
  remoteRunnerFor,
  type JamalDeps,
  type RemoteTarget,
} from './deps.js';
import { runRemoteCommand, type RemoteCommandOptions } from './remote-command.js';
import type { JamalConfig } from './config/index.js';
import { usageFailure } from './plan-command.js';
import { containerNameForEntry } from './production/plan.js';
import { APP_USAGE } from './usage.js';

/** The recognized app lifecycle verbs. */
const VERBS = new Set(['boot', 'start', 'stop', 'details', 'containers', 'logs', 'exec']);

/** Flags the app verbs accept; parsed independently of the top-level set. */
const APP_OPTIONS = {
  follow: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * Read the deploy history and extract the latest entry. Reports a value-free
 * error and resolves `undefined` when the history is absent or empty.
 */
async function resolveLatestEntry(
  deps: JamalDeps,
): Promise<
  { container: string; server: string; target: RemoteTarget; config: JamalConfig } | undefined
> {
  const history = await readHistoryOrReport(deps);
  if (history === undefined) {
    return undefined;
  }
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) {
    deps.stderr('jsails: no deploy history to inspect');
    return undefined;
  }
  const config = await loadProductionConfigOrReport(deps, 'app');
  if (config === undefined) {
    return undefined;
  }
  return {
    container: containerNameForEntry(config.service, entry),
    server: config.production!.server,
    target: config.production!,
    config,
  };
}

/** The `docker inspect` argv that prints only whether a container is running. */
function runningStateArgv(container: string): readonly string[] {
  return ['docker', 'inspect', '--type', 'container', '--format', '{{.State.Running}}', container];
}

/**
 * `jamal app boot`: start the latest container only when it exists and is
 * stopped. The state probe is captured, not forwarded; a container that does
 * not exist is reported as not deployed rather than handed to `docker start`.
 */
async function bootContainer(
  deps: JamalDeps,
  target: RemoteTarget,
  container: string,
): Promise<number> {
  let probe;
  try {
    probe = await remoteRunnerFor(deps, target).run(target.server, runningStateArgv(container));
  } catch (error) {
    deps.stderr(`jsails: app boot failed: ${formatError(error)}`);
    return 1;
  }
  if (probe.exitCode !== 0) {
    deps.stderr(
      'jsails: app boot: the latest deployed container does not exist on the server; ' +
        'run "jsails jamal deploy"',
    );
    return 1;
  }
  if (probe.stdout.trim() === 'true') {
    deps.stdout('app container is already running');
    return 0;
  }
  return runRemoteCommand(deps, target, ['docker', 'start', container], 'app boot start');
}

/**
 * Run the `jamal app` command over the tokens after `app`. Resolves to a
 * process exit code: 0 on success (including a dry run), 2 for a usage error,
 * and 1 for a config, history, or remote-run failure.
 */
export async function runJamalAppCommand(
  deps: JamalDeps,
  args: readonly string[],
): Promise<number> {
  // `exec` requires `--` before the real command, so don't pass the whole
  // raw arg set through `parseArgs`. Split on the first `--` and parse only
  // what is before it as flags; everything after `--` is the exec command.
  const dashIndex = args.indexOf('--');
  const flagTokens = dashIndex === -1 ? [...args] : args.slice(0, dashIndex);
  const execCommand = dashIndex === -1 ? [] : args.slice(dashIndex + 1);

  let parsed;
  try {
    parsed = parseArgs({
      args: flagTokens,
      options: APP_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(APP_USAGE);
    return 0;
  }

  const verb = positionals[0];
  if (verb === undefined || !VERBS.has(verb)) {
    return usageFailure(
      deps,
      'a verb is required (boot | start | stop | details | containers | logs | exec)',
    );
  }

  // `--follow` is only valid for `logs`.
  if (values.follow && verb !== 'logs') {
    return usageFailure(deps, '--follow is only valid for `jamal app logs`');
  }

  // `exec` requires `--` before the command.
  if (verb === 'exec' && dashIndex === -1) {
    return usageFailure(
      deps,
      '"jamal app exec" requires "--" before the command: jsails jamal app exec -- <cmd...>',
    );
  }
  if (verb === 'exec' && execCommand.length === 0) {
    return usageFailure(deps, '"jamal app exec" requires a command after "--"');
  }

  // `containers` needs only the config (service name), not deploy history.
  if (verb === 'containers') {
    const config = await loadProductionConfigOrReport(deps, 'app');
    if (config === undefined) {
      return 1;
    }
    const server = config.production!.server;
    const argv = ['docker', 'ps', '-a', '--filter', `name=${config.service}`];

    if (values['dry-run']) {
      printRemoteDryRun(deps, server, argv);
      return 0;
    }
    return runRemoteCommand(deps, config.production!, argv, `app ${verb}`);
  }

  // Every other verb resolves the latest deploy entry.
  const resolved = await resolveLatestEntry(deps);
  if (resolved === undefined) {
    return 1;
  }
  const { container, server, target } = resolved;

  // Build the remote argv for each verb.
  let remoteArgv: readonly string[];
  let label: string;
  let runOptions: RemoteCommandOptions = {};

  switch (verb) {
    case 'boot':
      if (values['dry-run']) {
        printRemoteDryRun(deps, server, runningStateArgv(container));
        printRemoteDryRun(deps, server, ['docker', 'start', container]);
        return 0;
      }
      return bootContainer(deps, target, container);

    case 'start':
      remoteArgv = ['docker', 'start', container];
      label = 'app start';
      break;

    case 'stop':
      remoteArgv = ['docker', 'stop', container];
      label = 'app stop';
      break;

    case 'details':
      remoteArgv = ['docker', 'inspect', container];
      label = 'app details';
      break;

    case 'logs':
      remoteArgv = values.follow
        ? ['docker', 'logs', '--follow', container]
        : ['docker', 'logs', container];
      label = 'app logs';
      // A followed log never ends on its own, so it streams with no timeout.
      runOptions = values.follow ? { stream: true, timeoutMs: null } : { stream: true };
      break;

    case 'exec':
      remoteArgv = ['docker', 'exec', container, ...execCommand];
      label = 'app exec';
      break;

    default:
      return usageFailure(deps, `unknown verb: ${verb}`);
  }

  if (values['dry-run']) {
    printRemoteDryRun(deps, server, remoteArgv);
    return 0;
  }

  return runRemoteCommand(deps, target, remoteArgv, label, runOptions);
}
