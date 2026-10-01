/**
 * The jamal dependency seam and the report-and-bail idiom every subcommand
 * shares. Tests inject runners and captured output sinks so nothing spawns or
 * touches the network; the defaults are the real runners and the process's
 * stdout/stderr. The `OrReport` helpers resolve
 * `undefined` after printing a value-free failure, so a subcommand returns a
 * non-zero exit code without repeating the try/catch.
 */

import { renderFailureReport } from 'jsails/internal';

import type { DeploymentCredentials } from './credentials-delivery.js';

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  JamalConfigError,
  loadJamalConfig,
  type JamalConfig,
  type JamalSshConfig,
} from './config/index.js';
import type { LocalPlanOptions } from './compose.js';
import {
  composeProjectDirs,
  defaultDockerCommandRunner,
  type DockerCommandRunner,
} from './docker.js';
import type { GitState } from './production/build.js';
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
   * The environment a failure report reads `JSAILS_DEBUG` from; defaults to
   * `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
   * Read the commit the checkout in `cwd` is at and whether its tree is
   * dirty, for `deploy`; defaults to git (`build.ts` `readGitState`).
   */
  readGitState?(cwd: string): Promise<GitState>;
  /** The clock a release id and the recorded times are read from; defaults to now. */
  now?(): Date;
  /**
   * Load the deploy secrets files. Injected so tests never read the real
   * `.jamal/secrets`; defaults to {@link loadJamalSecrets}.
   */
  loadSecrets?(options: LoadJamalSecretsOptions): JamalSecrets;
  /**
   * Ask the operator one question on the terminal and resolve their answer,
   * or `undefined` when no one can answer (stdin is not a terminal). Absent,
   * nothing is asked, so a confirmation must come from a flag.
   */
  prompt?(question: string): Promise<string | undefined>;
  /**
   * The project directories of the containers Docker labels with the local
   * Compose project `project`, or `undefined` when Docker cannot be asked.
   * Every local verb refuses a project whose containers another directory
   * created, so two apps that share a `service` never drive, replace, or
   * delete each other's containers and data. Defaults to
   * {@link composeProjectDirs}; absent in a test seam, nothing is checked.
   */
  composeProjectDirs?(project: string): Promise<readonly string[] | undefined>;
  /**
   * What the bin's resolution of a server verb's environment found of its
   * sealed credentials, the key ring included when it opened them. A deploy
   * or rollback delivers that ring to the app container
   * (`credentials-delivery.ts`) and `jamal secrets print` lists it. The bin
   * sets it for every server verb; absent, nothing is delivered.
   */
  readonly deploymentCredentials?: DeploymentCredentials | undefined;
}

/**
 * {@link JamalDeps.prompt} on the process's terminal; asks nothing when stdin
 * is not one. Ctrl-C or Ctrl-D at the prompt answers with an empty line, a
 * refusal: readline only pauses on an unhandled SIGINT, which would leave the
 * question pending and the operator unable to back out.
 */
async function promptOnTerminal(question: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const cancel = new AbortController();
  const abort = (): void => cancel.abort();
  terminal.once('SIGINT', abort);
  terminal.once('close', abort);
  try {
    return await terminal.question(question, { signal: cancel.signal });
  } catch (error) {
    if (!cancel.signal.aborted) throw error;
    process.stderr.write('\n');
    return '';
  } finally {
    terminal.close();
  }
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

  loadSecrets: (options) => loadJamalSecrets(options),
  prompt: (question) => promptOnTerminal(question),
  composeProjectDirs: (project) => composeProjectDirs(project, defaultProcessRunner),
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
    await reportFailure(deps, error, 'could not create node_modules');
    return false;
  }
}

/**
 * Report a failure on stderr in the `jamal: ...` form, as the `jsails` CLI
 * reports one: a framework error's message (after `label`, what the verb was
 * doing) with its `hint:` line, a fixed line for anything else (a driver's or
 * a library's error, whose message may hold a value), then the value-free
 * cause chain, with full detail only when `JSAILS_DEBUG=1` is set in
 * {@link JamalDeps.env}. Never rejects: if the report cannot be rendered, a
 * fixed line still says the verb failed.
 */
export async function reportFailure(
  deps: JamalDeps,
  error: unknown,
  label?: string,
): Promise<void> {
  let lines: readonly string[];
  try {
    lines = await renderFailureReport(error, {
      program: 'jamal',
      env: deps.env ?? process.env,
      cwd: deps.cwd,
      ...(label === undefined ? {} : { label }),
    });
  } catch {
    // The renderer could not load from this install; the error's message is
    // not printed, because whether it may be is the renderer's decision.
    lines = [`jamal: ${label ?? 'the command failed'}`];
  }
  for (const line of lines) deps.stderr(line);
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
    await reportFailure(deps, error);
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
