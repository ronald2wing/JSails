/**
 * The jamal dependency seam and the report-and-bail idiom every subcommand
 * shares. Tests inject runners and captured output sinks so nothing spawns or
 * touches the network; the defaults are the real runners and the process's
 * stdout/stderr. The `OrReport` helpers resolve
 * `undefined` after printing a value-free failure, so a subcommand returns a
 * non-zero exit code without repeating the try/catch.
 */

import { formatError } from './thrown-value.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  JamalConfigError,
  loadJamalConfig,
  type JamalConfig,
  type JamalSshConfig,
} from './config/index.js';
import type { LocalPlanOptions } from './compose.js';
import { defaultDockerCommandRunner, type DockerCommandRunner } from './docker.js';
import { defaultImageTag } from './production/execute.js';
import {
  appendDeployEntry,
  readDeployHistory,
  type DeployHistory,
  type DeployHistoryEntry,
} from './production/history.js';
import { createProcessRunner, type ProcessRunner } from './production/process-runner.js';
import type { HealthCheck } from './production/release.js';
import {
  createRemoteRunner,
  remoteCommandLine,
  shellQuote,
  type RemoteRunner,
} from './production/transport.js';
import { loadJamalSecrets, type JamalSecrets, type LoadJamalSecretsOptions } from './secrets.js';

/** The injectable collaborators of every jamal subcommand. */
export interface JamalDeps {
  /**
   * Load and normalize the jamal config for the managed Compose project
   * (`up`/`exec`, and `down`/`ps`/`logs` when `.jamal/compose.yml` exists).
   * Injected for tests; absent in a test seam, the real loader is used.
   */
  loadJamalConfig?(configDir: string): Promise<JamalConfig>;
  /** The project root: where the config, secrets, and `.jamal/` live. */
  readonly cwd: string;
  /**
   * The platform the command runs on; defaults to `process.platform`. On
   * Windows only the local-services verbs run (`platform.ts`).
   */
  readonly platform?: NodeJS.Platform;
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Spawn a fixed argv array with a given working directory. Injected for the
   * execution verbs (`up`/`down`/`ps`/`logs`/`exec`) so tests never spawn a real
   * process; defaults to the streaming `docker compose` runner. Absent in a
   * test seam, an execution verb reports "docker compose is unavailable".
   */
  readonly runCommand?: DockerCommandRunner;
  /**
   * Run a production step (build/push) as a fixed argv array with an optional
   * timeout. Injected so tests never spawn a real process; defaults to the
   * captured-output {@link createProcessRunner}.
   */
  readonly processRunner?: ProcessRunner;
  /**
   * Run a fixed argv array on the production server over ssh. Absent, each
   * command builds a runner over {@link processRunner} with the loaded
   * `config.production.ssh` options.
   */
  readonly remoteRunner?: RemoteRunner;
  /**
   * Replace the default health probe (run inside the new container over ssh)
   * with a URL check; one call is one bounded attempt.
   */
  readonly healthCheck?: HealthCheck;
  /**
   * Resolve the image tag for `deploy` when `--tag` is absent.
   * Defaults to `git rev-parse --short HEAD` with a timestamp fallback.
   */
  resolveTag?(cwd: string): Promise<string>;
  /** Read the local deploy history; defaults to `.jamal/deploys.json`. */
  readHistory?(dir: string): Promise<DeployHistory>;
  /** Record one deploy history entry; defaults to the atomic append. */
  appendHistory?(dir: string, entry: DeployHistoryEntry): Promise<DeployHistory>;
  /**
   * Load the deploy secrets files. Injected so tests never read the real
   * `.jamal/secrets`; defaults to {@link loadJamalSecrets}.
   */
  loadSecrets?(options: LoadJamalSecretsOptions): JamalSecrets;
}

const defaultProcessRunner = createProcessRunner();

/** The ssh target of a remote verb: `config.production` carries both fields. */
export interface RemoteTarget {
  readonly server: string;
  readonly ssh?: JamalSshConfig | undefined;
}

/**
 * The remote runner for one command: the injected one when present, else a
 * runner that applies the target's ssh options to every connection.
 */
export function remoteRunnerFor(deps: JamalDeps, target: RemoteTarget): RemoteRunner {
  if (deps.remoteRunner !== undefined) {
    return deps.remoteRunner;
  }
  return createRemoteRunner({
    processRunner: deps.processRunner ?? defaultProcessRunner,
    ...(target.ssh === undefined ? {} : { ssh: target.ssh }),
  });
}

export const defaultJamalDeps: JamalDeps = Object.freeze<JamalDeps>({
  loadJamalConfig: (configDir) => loadJamalConfig(configDir),
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  runCommand: defaultDockerCommandRunner,
  processRunner: defaultProcessRunner,
  resolveTag: (cwd) => defaultImageTag(cwd),
  readHistory: (dir) => readDeployHistory(dir),
  appendHistory: (dir, entry) => appendDeployEntry(dir, entry),
  loadSecrets: (options) => loadJamalSecrets(options),
});

/** Environment variables that override the dev container's user and group id. */
export const DEV_UID_ENV = 'JAMAL_DEV_UID';
export const DEV_GID_ENV = 'JAMAL_DEV_GID';

/**
 * The developer's user and group id for the local planner, so the dev
 * container writes files they own. `JAMAL_DEV_UID`/`JAMAL_DEV_GID` override
 * them: rootless Docker and Podman map container root to the developer, so
 * there both are `0`. Absent on Windows, where the planner's default applies.
 */
export function hostUserOption(env: NodeJS.ProcessEnv = process.env): LocalPlanOptions {
  const uid = idFromEnv(env[DEV_UID_ENV], DEV_UID_ENV) ?? process.getuid?.();
  const gid = idFromEnv(env[DEV_GID_ENV], DEV_GID_ENV) ?? process.getgid?.();
  return uid === undefined || gid === undefined ? {} : { hostUser: { uid, gid } };
}

function idFromEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (!/^[0-9]{1,10}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new JamalConfigError(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

/**
 * Create the dev container's mount points that Docker would otherwise create
 * as root inside the project mount: the `node_modules` volume sits inside
 * `..:/app`, and a root-owned `node_modules` folder would block a host
 * `npm install`. Returns `false` after reporting a failure.
 */
export async function prepareDevMountPoints(
  deps: JamalDeps,
  targetDir: string,
  config: JamalConfig,
): Promise<boolean> {
  if (config.local.app !== 'dev') return true;
  try {
    await mkdir(join(targetDir, 'node_modules'), { recursive: true });
    return true;
  } catch (error) {
    deps.stderr(`jamal: could not create node_modules: ${formatError(error)}`);
    return false;
  }
}

/** Report a value-free failure on stderr in the `jamal: ...` form. */
export function reportFailure(deps: JamalDeps, error: unknown): void {
  deps.stderr(`jamal: ${formatError(error)}`);
}

/**
 * Load and normalize the jamal config from `configDir` (default `deps.cwd`),
 * reporting a value-free failure and resolving `undefined` so the caller
 * returns exit code 1. `JamalConfigError` messages never embed config values.
 */
export async function loadConfigOrReport(
  deps: JamalDeps,
  configDir: string = deps.cwd,
): Promise<JamalConfig | undefined> {
  const loader = deps.loadJamalConfig ?? ((dir: string) => loadJamalConfig(dir));
  try {
    return await loader(configDir);
  } catch (error) {
    reportFailure(deps, error);
    return undefined;
  }
}

/**
 * Load the config and require its `production` section, the SSH target every
 * remote verb needs. `verb` names the subcommand in the failure message.
 */
export async function loadProductionConfigOrReport(
  deps: JamalDeps,
  verb: string,
): Promise<JamalConfig | undefined> {
  const config = await loadConfigOrReport(deps);
  if (config === undefined) {
    return undefined;
  }
  if (config.production === undefined) {
    deps.stderr(`jamal: config.production is required for \`jamal ${verb}\``);
    return undefined;
  }
  return config;
}

/** Read the deploy history, reporting a value-free failure and resolving undefined. */
export async function readHistoryOrReport(deps: JamalDeps): Promise<DeployHistory | undefined> {
  const reader = deps.readHistory ?? ((dir: string) => readDeployHistory(dir));
  try {
    return await reader(deps.cwd);
  } catch (error) {
    reportFailure(deps, error);
    return undefined;
  }
}

/**
 * Print the exact argv a run would execute, shell-quoted as the remote shell
 * receives it, without executing it, and succeed.
 */
export function printDryRun(deps: JamalDeps, argv: readonly string[]): number {
  deps.stdout(`[dry-run] ${argv.map((token) => shellQuote(token)).join(' ')}`);
  return 0;
}

/**
 * Print the ssh command a remote run would execute, without executing it, and
 * succeed. The remote part is printed as the one quoted command line the
 * runner sends, so the printed line can be pasted into a shell as is.
 */
export function printRemoteDryRun(
  deps: JamalDeps,
  server: string,
  argv: readonly string[],
): number {
  deps.stdout(`[dry-run] ssh ${shellQuote(server)} ${shellQuote(remoteCommandLine(argv))}`);
  return 0;
}
