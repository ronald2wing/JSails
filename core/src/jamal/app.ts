/**
 * Jamal app lifecycle verbs: `jamal app <verb>`.
 *
 * The seven verbs mirror Kamal's `kamal app <verb>` surface, operating on the
 * LATEST deployed app container on the remote production server. Every verb
 * requires `config.production` for the target SSH server, and `--dry-run`
 * prints the exact `ssh` argv without running it.
 *
 * The container is the latest entry in `.jamal/deploys.json`, resolved via
 * `containerNameForTag` — a missing history is a value-free error.
 */

import { parseArgs } from 'node:util';

import { formatError } from '../errors/inspect.js';
import {
  loadProductionConfigOrReport,
  readHistoryOrReport,
  printRemoteDryRun,
  type JamalDeps,
} from './deps.js';
import { runRemoteCommand } from './remote-command.js';
import type { JamalConfig } from './config/index.js';
import { usageFailure } from './plan-command.js';
import { containerNameForTag } from './production/plan.js';
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
): Promise<{ container: string; server: string; config: JamalConfig } | undefined> {
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
    container: containerNameForTag(config.service, entry.tag),
    server: config.production!.server,
    config,
  };
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
    return runRemoteCommand(deps, server, argv, `app ${verb}`);
  }

  // Every other verb resolves the latest deploy entry.
  const resolved = await resolveLatestEntry(deps);
  if (resolved === undefined) {
    return 1;
  }
  const { container, server } = resolved;

  // Build the remote argv for each verb.
  let remoteArgv: readonly string[];
  let label: string;

  switch (verb) {
    case 'boot':
      // docker inspect <container> — if exit 0, no-op; else docker start <container>.
      // We run two commands: inspect, then conditionally start.
      if (values['dry-run']) {
        printRemoteDryRun(deps, server, ['docker', 'inspect', container]);
        printRemoteDryRun(deps, server, ['docker', 'start', container]);
        return 0;
      }
      {
        const inspectCode = await runRemoteCommand(
          deps,
          server,
          ['docker', 'inspect', container],
          'app boot inspect',
        );
        // A non-zero inspect exit code means the container does not exist; start it.
        if (inspectCode !== 0) {
          return runRemoteCommand(deps, server, ['docker', 'start', container], 'app boot start');
        }
        // Container already running — silent no-op.
        return 0;
      }

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

  return runRemoteCommand(deps, server, remoteArgv, label);
}
