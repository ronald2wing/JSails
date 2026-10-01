/**
 * Jamal accessory lifecycle verbs: `jamal accessory <verb> [name]`.
 *
 * The seven verbs mirror Kamal's `kamal accessory <verb>` surface, operating
 * on backing service containers (mariadb, postgres, valkey) declared in
 * `config.services`. Dev tools (mailpit, adminer) are rejected as unknown
 * accessory names, and every verb requires `config.production` for the target
 * SSH server. `--dry-run` prints the exact `ssh` argv without running it.
 *
 * These verbs are pure CLI lifecycle verbs that run one or more remote `docker`
 * commands per invocation; they never touch the app, restart the deploy engine,
 * or mutate history. A failed command returns the child's exit code (or 1 for a
 * spawn failure) without affecting other independent services.
 *
 * `boot` starts a container exactly as a deploy does: on the shared network,
 * with its credentials resolved from the secrets files and written to a
 * mode-0600 env file on the server, never placed on the command line.
 */

import { parseArgs } from 'node:util';

import { formatError } from './thrown-value.js';
import {
  loadConfigOrReport,
  printRemoteDryRun,
  remoteRunnerFor,
  reportFailure,
  type JamalDeps,
  type RemoteTarget,
} from './deps.js';
import type { JamalConfig } from './config/index.js';
import type { ResolvedEnv } from './env-resolve.js';
import { usageFailure } from './usage-failure.js';
import { containerDetailsArgv, runRemoteCommand } from './remote-command.js';
import { resolveEnvForRelease } from './release-verbs.js';
import {
  ACCESSORY_ENV_FILE_MODE,
  accessoryEnvFileContents,
  accessoryEnvSources,
  accessoryRunArgv,
} from './production/accessories.js';
import { accessoryEnvFilePath } from './production/host-layout.js';
import { ensureNetworkArgv } from './production/network.js';
import { remoteWriteFileArgv, writeRemoteFile } from './production/remote-file.js';
import {
  SERVICE_CONVENTIONS,
  isAccessoryServiceType,
  type AccessoryServiceType,
} from './service-conventions.js';
import { ACCESSORY_USAGE } from './usage.js';

/** The recognized accessory lifecycle verbs. */
const VERBS = new Set(['boot', 'start', 'stop', 'reboot', 'logs', 'remove', 'details']);

/** Flags the accessory verbs accept; parsed independently of the top-level set. */
const ACCESSORY_OPTIONS = {
  follow: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/**
 * All accessory services (mariadb, postgres, valkey) declared in
 * `config.services`, in sorted key order.
 * Dev tools and local-only services are never included.
 */
function allAccessoryNames(config: JamalConfig): { name: string; type: AccessoryServiceType }[] {
  const names: { name: string; type: AccessoryServiceType }[] = [];
  for (const name of Object.keys(config.services).sort()) {
    const service = config.services[name];
    if (service !== undefined && isAccessoryServiceType(service.type)) {
      names.push({ name, type: service.type });
    }
  }
  return names;
}

/**
 * The sorted list of valid accessory names for error messages, from config.
 * Dev tools are excluded so the message only names legitimate targets.
 */
function sortedAccessoryNames(config: JamalConfig): string[] {
  return allAccessoryNames(config).map((entry) => entry.name);
}

/**
 * Require that `name` is a declared backing service in `config.services`.
 * Returns the resolved service type; throws a value-free error naming the valid
 * accessory names when the name is unknown or is a dev tool.
 */
export function resolveAccessoryName(config: JamalConfig, name: string): AccessoryServiceType {
  const service = config.services[name];
  if (service === undefined || !isAccessoryServiceType(service.type)) {
    const valid = sortedAccessoryNames(config);
    throw new Error(
      valid.length === 0
        ? `unknown accessory "${name}"; no backing services are declared`
        : `unknown accessory "${name}"; valid: ${valid.join(', ')}`,
    );
  }
  return service.type;
}

/**
 * Build a `docker volume create` argv for one service. Idempotent — the volume
 * is left intact when it already exists.
 */
function bootVolumeArgv(type: AccessoryServiceType): string[] {
  return ['docker', 'volume', 'create', SERVICE_CONVENTIONS[type].volume];
}

/**
 * Build a `docker inspect` argv for one service (check whether the container
 * already exists). Returns exit 0 when it exists.
 */
function inspectArgv(name: string): string[] {
  return ['docker', 'inspect', '--type', 'container', name];
}

/** Build a `docker logs` argv for one service, optionally following. */
function logsArgv(name: string, options: { readonly follow: boolean }): string[] {
  return options.follow ? ['docker', 'logs', '--follow', name] : ['docker', 'logs', name];
}

/** The credentials env-file path for one accessory, or undefined when it needs none. */
function envFilePathFor(
  config: JamalConfig,
  name: string,
  type: AccessoryServiceType,
): string | undefined {
  return accessoryEnvSources(config, type).length === 0
    ? undefined
    : accessoryEnvFilePath(config.service, config.production?.destination, name);
}

/**
 * Run one complete `boot` for a single accessory: network and volume (both
 * idempotent), then the existence check, then — only for a missing container —
 * the credentials env file and `docker run`. Returns the exit code of the last
 * operation that ran (0 when the container already exists).
 */
async function bootOne(
  deps: JamalDeps,
  config: JamalConfig,
  target: RemoteTarget,
  name: string,
  type: AccessoryServiceType,
  resolveEnv: () => Promise<ResolvedEnv | undefined>,
): Promise<number> {
  const networkCode = await runRemoteCommand(
    deps,
    target,
    ensureNetworkArgv([name]),
    `accessory boot ${name} network`,
  );
  if (networkCode !== 0) {
    return networkCode;
  }

  // Volume create is idempotent.
  const volArgv = bootVolumeArgv(type);
  const volCode = await runRemoteCommand(deps, target, volArgv, `accessory boot ${name} volume`);
  if (volCode !== 0) {
    return volCode;
  }

  // Check whether the container already exists; the probe output is not forwarded.
  const remote = remoteRunnerFor(deps, target);
  let inspect;
  try {
    inspect = await remote.run(target.server, inspectArgv(name));
  } catch (error) {
    await reportFailure(deps, error, `accessory boot ${name} inspect failed`);
    return 1;
  }
  if (inspect.exitCode === 0) {
    return 0; // Container already exists — no need to recreate.
  }

  const envFilePath = envFilePathFor(config, name, type);
  if (envFilePath !== undefined) {
    const env = await resolveEnv();
    if (env === undefined) {
      return 1;
    }
    try {
      const contents = accessoryEnvFileContents(accessoryEnvSources(config, type), env);
      await writeRemoteFile(remote, target.server, envFilePath, Buffer.from(contents, 'utf8'), {
        mode: ACCESSORY_ENV_FILE_MODE,
      });
    } catch (error) {
      await reportFailure(deps, error, `accessory boot ${name} env-file failed`);
      return 1;
    }
  }

  return runRemoteCommand(
    deps,
    target,
    accessoryRunArgv(type, name, envFilePath),
    `accessory boot ${name} run`,
  );
}

/**
 * Print the `--dry-run` ssh commands for one `boot`. The env-file write shows
 * only its destination: the credentials travel on stdin.
 */
function bootDryRun(
  deps: JamalDeps,
  config: JamalConfig,
  server: string,
  name: string,
  type: AccessoryServiceType,
): void {
  printRemoteDryRun(deps, server, ensureNetworkArgv([name]));
  printRemoteDryRun(deps, server, bootVolumeArgv(type));
  // In dry-run mode, print the inspect check and the potential env file and run.
  printRemoteDryRun(deps, server, inspectArgv(name));
  const envFilePath = envFilePathFor(config, name, type);
  if (envFilePath !== undefined) {
    printRemoteDryRun(
      deps,
      server,
      remoteWriteFileArgv(envFilePath, { mode: ACCESSORY_ENV_FILE_MODE }),
    );
  }
  printRemoteDryRun(deps, server, accessoryRunArgv(type, name, envFilePath));
}

/**
 * Run the `jamal accessory` command over the tokens after `accessory`. Resolves
 * to a process exit code: 0 on success (including a dry run), 2 for a usage
 * error, and 1 for a config or remote-run failure.
 */
export async function runAccessoryCommand(
  deps: JamalDeps,
  args: readonly string[],
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: ACCESSORY_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(ACCESSORY_USAGE);
    return 0;
  }

  const verb = positionals[0];
  if (verb === undefined || !VERBS.has(verb)) {
    return usageFailure(
      deps,
      'a verb is required (boot | start | stop | reboot | logs | remove | details)',
    );
  }

  // `follow` is only valid for `logs`.
  if (values.follow && verb !== 'logs') {
    return usageFailure(deps, '--follow is only valid for `jamal accessory logs`');
  }

  const rawName = positionals[1];

  // `logs` and `details` require a single service name.
  if ((verb === 'logs' || verb === 'details') && rawName === undefined) {
    return usageFailure(deps, `"jamal accessory ${verb}" requires a service name`);
  }
  if (positionals.length > 2) {
    return usageFailure(deps, `unexpected argument: ${positionals.slice(2).join(' ')}`);
  }

  // Load the config and require production.
  const config = await loadConfigOrReport(deps);
  if (config === undefined) {
    return 1;
  }
  if (config.production === undefined) {
    deps.stderr('jamal: config.production is required for `jamal accessory`');
    return 1;
  }
  const server = config.production.server;
  const target: RemoteTarget = config.production;
  // Secrets are resolved once, and only when a boot actually creates a container.
  let resolvedEnv: Promise<ResolvedEnv | undefined> | undefined;
  const resolveEnv = (): Promise<ResolvedEnv | undefined> => {
    resolvedEnv ??= resolveEnvForRelease(deps, config);
    return resolvedEnv;
  };

  // Resolve the accessory name(s) to operate on.
  let names: { name: string; type: AccessoryServiceType }[];
  if (rawName !== undefined) {
    let type: AccessoryServiceType;
    try {
      type = resolveAccessoryName(config, rawName);
    } catch (error) {
      return usageFailure(deps, formatError(error));
    }
    names = [{ name: rawName, type }];
  } else {
    names = allAccessoryNames(config);
    if (names.length === 0) {
      deps.stderr('jamal: no backing services are declared in config.services');
      return 1;
    }
  }

  // Execute each service in order; a failure stops the chain.
  for (const { name, type } of names) {
    let exitCode: number;

    switch (verb) {
      case 'boot':
        try {
          if (values['dry-run']) {
            bootDryRun(deps, config, server, name, type);
            exitCode = 0;
          } else {
            exitCode = await bootOne(deps, config, target, name, type, resolveEnv);
          }
        } catch (error) {
          await reportFailure(deps, error, `accessory boot ${name} failed`);
          exitCode = 1;
        }
        break;

      case 'start':
        if (values['dry-run']) {
          printRemoteDryRun(deps, server, ['docker', 'start', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            target,
            ['docker', 'start', name],
            `accessory start ${name}`,
          );
        }
        break;

      case 'stop':
        if (values['dry-run']) {
          printRemoteDryRun(deps, server, ['docker', 'stop', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            target,
            ['docker', 'stop', name],
            `accessory stop ${name}`,
          );
        }
        break;

      case 'reboot':
        if (values['dry-run']) {
          printRemoteDryRun(deps, server, ['docker', 'restart', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            target,
            ['docker', 'restart', name],
            `accessory reboot ${name}`,
          );
        }
        break;

      case 'logs':
        if (values['dry-run']) {
          printRemoteDryRun(deps, server, logsArgv(name, { follow: values.follow }));
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            target,
            logsArgv(name, { follow: values.follow }),
            `accessory logs ${name}`,
            values.follow ? { stream: true, timeoutMs: null } : { stream: true },
          );
        }
        break;

      case 'remove':
        if (values['dry-run']) {
          printRemoteDryRun(deps, server, ['docker', 'rm', '-f', name]);
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            target,
            ['docker', 'rm', '-f', name],
            `accessory remove ${name}`,
          );
        }
        break;

      case 'details':
        if (values['dry-run']) {
          printRemoteDryRun(deps, server, containerDetailsArgv(name));
          exitCode = 0;
        } else {
          exitCode = await runRemoteCommand(
            deps,
            target,
            containerDetailsArgv(name),
            `accessory details ${name}`,
          );
        }
        break;

      default:
        return usageFailure(deps, `unknown verb: ${verb}`);
    }

    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}
