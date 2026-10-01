/**
 * Jamal local Docker Compose verbs: `up`/`down`/`ps`/`logs`/`exec` against the
 * managed `.jamal/compose.yml` materialized from the jamal config, plus the
 * Sail-style shortcuts (`jsails`, `npm`, `npx`, `node`, `test`, `shell`) that
 * run a command in the dev app container. These verbs are always local: the
 * production server is reached only through the explicit `jamal app` and
 * `jamal status` verbs. Compose runs through the `runCommand` seam and the
 * `docker volume` calls of `down --volumes` through `processRunner`, so tests
 * avoid Docker. Before any Compose call a verb checks, through
 * `composeProjectDirs`, that no other directory's containers hold the
 * project. Every child inherits the environment the `jamal` bin
 * assembled from the project's `.env` files and credentials, which Compose
 * interpolates into the managed file; no value is written to it.
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { isErrno } from './thrown-value.js';
import {
  hostUserOption,
  loadConfigOrReport,
  prepareDevMountPoints,
  reportFailure,
  type JamalDeps,
} from './deps.js';
import type { JamalConfig } from './config/index.js';
import { JamalError } from './error.js';
import { createProcessRunner } from './production/process-runner.js';
import { LOCAL_APP_SERVICE, LOCAL_COMPOSE_PATH, planLocal } from './compose.js';
import {
  COMPOSE_PROJECT_LABEL,
  DOCKER_QUERY_TIMEOUT_MS,
  composeArgv,
  execArgv,
  runArgv,
  type DockerCommandResult,
  type DockerVerb,
} from './docker.js';
import { usageFailure } from './usage-failure.js';

/** Absolute path of the managed `.jamal/compose.yml` inside a project root. */
function managedComposePath(targetDir: string): string {
  return join(targetDir, ...LOCAL_COMPOSE_PATH.split('/'));
}

/**
 * `path` in the form two spellings of one directory share: its real path
 * when it exists here (a symlinked checkout, macOS's `/var` alias), and on
 * Windows, where paths are case-insensitive, lowercased.
 */
function comparableDir(path: string, platform: NodeJS.Platform): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path); // A directory since moved or deleted keeps its recorded spelling.
  }
  return platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Whether the local Compose project `project` is this app's to drive: no
 * container labelled with it was created from another directory's
 * `.jamal/compose.yml`. Two apps whose configs share a `service` would
 * otherwise share one project: one app's `up` would replace the other's
 * running containers, its `down` would remove them, and `down --volumes` would
 * delete their data. Reports `project_in_use` and returns `false` on a
 * conflict. Volumes carry no directory, so once the other app's containers
 * are gone this check cannot see it; a unique `service` is what keeps two
 * apps apart.
 */
async function projectOwnedOrReport(
  deps: JamalDeps,
  project: string,
  targetDir: string,
): Promise<boolean> {
  const dirs = await deps.composeProjectDirs?.(project);
  if (dirs === undefined) return true;
  const platform = deps.platform ?? process.platform;
  const own = comparableDir(dirname(managedComposePath(targetDir)), platform);
  if (dirs.every((dir) => comparableDir(dir, platform) === own)) return true;
  await reportFailure(
    deps,
    new JamalError(
      'project_in_use',
      "another directory's containers already use this app's Compose project (config.service)",
      {
        suggestion:
          'Give this app a service name of its own in jamal.config, or run "jamal down" in the app that owns the containers',
      },
    ),
  );
  return false;
}

/**
 * Materialize the local plan for `config` into `targetDir`: the Compose file
 * and, for a dev app, its image definition. A file is
 * written only when its content differs from the deterministic plan, so repeat
 * runs leave unchanged files untouched. Returns `true`, or `false` after
 * reporting an error.
 */
async function materializeManagedCompose(
  deps: JamalDeps,
  targetDir: string,
  config: JamalConfig,
): Promise<boolean> {
  let plan: ReturnType<typeof planLocal>;
  try {
    plan = planLocal(config, hostUserOption());
  } catch (error) {
    await reportFailure(deps, error);
    return false;
  }
  if (!(await prepareDevMountPoints(deps, targetDir, config))) {
    return false;
  }
  for (const file of plan.files) {
    const dest = join(targetDir, ...file.path.split('/'));
    let current: string | undefined;
    try {
      current = await readFile(dest, 'utf8');
    } catch {
      current = undefined; // Missing or unreadable: (re)write the canonical plan.
    }
    if (current === file.contents) {
      continue;
    }
    try {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.contents);
    } catch (error) {
      await reportFailure(deps, error, `could not write ${file.path}`);
      return false;
    }
  }
  return true;
}

/**
 * Spawn one fixed compose argv and forward its output/exit code through the
 * `runCommand` seam, which lets tests avoid Docker. A
 * missing seam reports "unavailable", an `ENOENT` spawn reports the install
 * hint, and any other failure is sanitized into a single line.
 */
async function executeCompose(
  argv: readonly string[],
  cwd: string,
  label: string,
  deps: JamalDeps,
): Promise<number> {
  if (deps.runCommand === undefined) {
    deps.stderr('jamal: docker compose is not available in this environment');
    return 127;
  }

  let result: DockerCommandResult;
  try {
    result = await deps.runCommand(argv, { cwd });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      deps.stderr(
        'jamal: docker compose is not available; install Docker with the compose plugin and ensure "docker" is on PATH',
      );
      return 127;
    }
    await reportFailure(deps, error, `failed to run docker compose ${label}`);
    return 1;
  }

  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jamal: docker compose ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}

/** The flags an execution verb reads. */
export interface DockerVerbValues {
  /** `logs --follow`. */
  readonly follow: boolean;
  /** `down --volumes`: also delete the project's volumes. */
  readonly volumes: boolean;
  /** `down --volumes --yes`: confirmed without a prompt. */
  readonly yes: boolean;
}

/**
 * Run one execution verb (`up`/`down`/`ps`/`logs`) against the local project.
 * Every verb drives the managed `.jamal/compose.yml` materialized from
 * the jamal config: `up` materializes it first, while the read/teardown verbs
 * require it to already exist (created by `jamal up`). `down` keeps the
 * project's named volumes, so the next `up` finds its data; only
 * `down --volumes` deletes them. It never starts other services.
 */
export async function runDockerVerb(
  verb: DockerVerb,
  rest: readonly string[],
  values: DockerVerbValues,
  deps: JamalDeps,
): Promise<number> {
  if (verb !== 'logs' && rest.length > 0) {
    return usageFailure(deps, `"jamal ${verb}" takes no arguments`);
  }
  if (verb === 'logs' && rest.length > 1) {
    return usageFailure(
      deps,
      `"jamal logs" takes at most one service name; got: ${rest.join(' ')}`,
    );
  }

  const targetDir = deps.cwd;

  const service = verb === 'logs' ? rest[0] : undefined;

  if (verb === 'up') {
    const config = await loadConfigOrReport(deps, targetDir);
    if (config === undefined) {
      return 1;
    }
    if (!(await projectOwnedOrReport(deps, config.service, targetDir))) {
      return 1;
    }
    if (!(await materializeManagedCompose(deps, targetDir, config))) {
      return 1;
    }
    const argv = composeArgv('up', {
      file: LOCAL_COMPOSE_PATH,
      project: config.service,
      wait: true,
    });
    return executeCompose(argv, targetDir, 'up', deps);
  }

  if (!existsSync(managedComposePath(targetDir))) {
    deps.stderr(
      `jamal: no ${LOCAL_COMPOSE_PATH} found in ${targetDir}; run "jamal up" to generate it first`,
    );
    return 1;
  }

  const config = await loadConfigOrReport(deps, targetDir);
  if (config === undefined) {
    return 1;
  }
  if (!(await projectOwnedOrReport(deps, config.service, targetDir))) {
    return 1;
  }
  if (verb === 'down' && values.volumes) {
    return downWithVolumes(config.service, values.yes, targetDir, deps);
  }
  const argv = composeArgv(verb, {
    follow: values.follow,
    service,
    file: LOCAL_COMPOSE_PATH,
    project: config.service,
  });
  return executeCompose(argv, targetDir, verb, deps);
}

/**
 * Whether the developer confirmed deleting `project`'s volumes: `--yes`, or
 * the project name typed back at the terminal. Throws `confirmation_required`
 * when no terminal can ask.
 */
async function volumesRemovalConfirmed(
  deps: JamalDeps,
  project: string,
  yes: boolean,
): Promise<boolean> {
  if (yes) return true;
  const answer = await deps.prompt?.(
    `This deletes every data volume of the local Compose project "${project}": ` +
      `its databases, caches, and stored files.\nType the project name to continue: `,
  );
  if (answer === undefined) {
    throw new JamalError(
      'confirmation_required',
      '"jamal down --volumes" deletes the local data and needs confirmation',
      { suggestion: 'Pass --yes, or run it at a terminal and type the project name' },
    );
  }
  return answer.trim() === project;
}

/**
 * `jamal down --volumes`: after confirmation, take the project down, then
 * delete every volume labelled as `project`'s and name each one removed.
 * Selecting by Compose's project label, rather than by the volumes the config
 * declares today, also removes the volume of a service since dropped from the
 * config, and never touches another project's. A volume name is a Docker
 * object name, never a value, so the report prints it.
 */
async function downWithVolumes(
  project: string,
  yes: boolean,
  targetDir: string,
  deps: JamalDeps,
): Promise<number> {
  try {
    if (!(await volumesRemovalConfirmed(deps, project, yes))) {
      deps.stderr('jamal: down cancelled: the project name was not typed back');
      return 1;
    }
  } catch (error) {
    await reportFailure(deps, error);
    return 1;
  }
  const down = composeArgv('down', { file: LOCAL_COMPOSE_PATH, project });
  const code = await executeCompose(down, targetDir, 'down', deps);
  if (code !== 0) return code;

  const run = deps.processRunner ?? createProcessRunner();
  try {
    const listed = await run(
      [
        'docker',
        'volume',
        'ls',
        '--quiet',
        '--filter',
        `label=${COMPOSE_PROJECT_LABEL}=${project}`,
      ],
      { timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
    );
    if (listed.exitCode !== 0) {
      deps.stderr(`jamal: docker volume ls exited with code ${listed.exitCode}`);
      return listed.exitCode;
    }
    const volumes = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .sort();
    if (volumes.length === 0) {
      deps.stdout(`jamal: the project "${project}" has no volumes to remove`);
      return 0;
    }
    const removed = await run(['docker', 'volume', 'rm', ...volumes], {
      timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
    });
    if (removed.exitCode !== 0) {
      if (removed.stderr !== '') deps.stderr(removed.stderr.replace(/\n$/, ''));
      deps.stderr(`jamal: docker volume rm exited with code ${removed.exitCode}`);
      return removed.exitCode;
    }
    for (const volume of volumes) {
      deps.stdout(`jamal: removed volume ${volume}`);
    }
    return 0;
  } catch (error) {
    await reportFailure(deps, error);
    return 1;
  }
}

/**
 * Run `jamal exec <service> -- <cmd...>` against the managed
 * `.jamal/compose.yml`. The `--` separator is required so the command's own
 * flags are never interpreted by jamal or `docker compose`; the managed file
 * must already exist (created by `jamal up`).
 */
export async function runDockerExec(
  tokens: readonly string[],
  hasTerminator: boolean,
  deps: JamalDeps,
): Promise<number> {
  if (!hasTerminator) {
    return usageFailure(
      deps,
      '"jamal exec" requires "--" before the command: jamal exec <service> -- <cmd...>',
    );
  }
  const service = tokens[0];
  const command = tokens.slice(1);
  if (service === undefined || service === '') {
    return usageFailure(
      deps,
      '"jamal exec" requires a service name: jamal exec <service> -- <cmd...>',
    );
  }
  if (command.length === 0) {
    return usageFailure(deps, '"jamal exec" requires a command after "--"');
  }

  const targetDir = deps.cwd;

  if (!existsSync(managedComposePath(targetDir))) {
    deps.stderr(
      `jamal: no ${LOCAL_COMPOSE_PATH} found in ${targetDir}; run "jamal up" to generate it first`,
    );
    return 1;
  }

  const config = await loadConfigOrReport(deps, targetDir);
  if (config === undefined) {
    return 1;
  }
  if (!(await projectOwnedOrReport(deps, config.service, targetDir))) {
    return 1;
  }

  const argv = execArgv(service, command, {
    file: LOCAL_COMPOSE_PATH,
    project: config.service,
  });
  return executeCompose(argv, targetDir, 'exec', deps);
}

/** A Sail-style shortcut verb. */
export type ShortcutVerb = 'jsails' | 'npm' | 'npx' | 'node' | 'test' | 'shell';

/** The Sail-style shortcuts and the command each one runs in the dev app container. */
const SHORTCUTS: Readonly<Record<ShortcutVerb, readonly string[]>> = {
  jsails: ['node_modules/.bin/jsails'],
  npm: ['npm'],
  npx: ['npx'],
  node: ['node'],
  test: ['npm', 'test'],
  shell: ['bash'],
};

/** `true` when `value` names a shortcut verb. */
export function isShortcutVerb(value: string | undefined): value is ShortcutVerb {
  return value !== undefined && Object.hasOwn(SHORTCUTS, value);
}

/**
 * Run a shortcut in a fresh dev app container: `jamal npm install`,
 * `jamal jsails db:push`, `jamal test`, `jamal shell`. The arguments pass
 * through verbatim, flags included. `docker compose run --rm` starts the
 * services the app depends on and works whether or not `jamal up` is running;
 * it publishes no ports, so it never collides with the running app. A leading
 * `--` is dropped, so `jamal npm -- --version` reaches npm as `--version`.
 */
export async function runShortcut(
  verb: ShortcutVerb,
  rest: readonly string[],
  deps: JamalDeps,
): Promise<number> {
  const args = rest[0] === '--' ? rest.slice(1) : rest;
  if (verb === 'shell' && args.length > 0) {
    return usageFailure(deps, '"jamal shell" takes no arguments');
  }

  const targetDir = deps.cwd;
  const config = await loadConfigOrReport(deps, targetDir);
  if (config === undefined) {
    return 1;
  }
  if (config.local.app !== 'dev') {
    deps.stderr(
      `jamal: "jamal ${verb}" runs in the dev app container; set local.app to "dev" in the jamal config`,
    );
    return 1;
  }
  if (!(await projectOwnedOrReport(deps, config.service, targetDir))) {
    return 1;
  }
  if (!(await materializeManagedCompose(deps, targetDir, config))) {
    return 1;
  }

  const command: string[] = [...SHORTCUTS[verb]];
  if (verb === 'test' && args.length > 0) {
    command.push('--');
  }
  command.push(...args);
  const argv = runArgv(LOCAL_APP_SERVICE, command, {
    file: LOCAL_COMPOSE_PATH,
    project: config.service,
  });
  return executeCompose(argv, targetDir, 'run', deps);
}
