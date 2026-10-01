/**
 * Jamal local Docker Compose verbs: `up`/`down`/`ps`/`logs`/`exec` against the
 * managed `.jamal/compose.yml` materialized from `jamal.config.js`. This is the
 * one place jamal spawns a local process; the `runCommand` seam lets tests
 * avoid Docker.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { formatError, isErrno } from '../errors/inspect.js';
import { loadConfigOrReport, reportFailure, type JamalDeps } from './deps.js';
import type { JamalConfig } from './config/index.js';
import { LOCAL_COMPOSE_PATH, planLocal } from './compose.js';
import { composeArgv, execArgv, type DockerCommandResult, type DockerVerb } from './docker.js';
import { resolveTargetDir, usageFailure } from './plan-command.js';

/** Absolute path of the managed `.jamal/compose.yml` inside a project root. */
function managedComposePath(targetDir: string): string {
  return join(targetDir, ...LOCAL_COMPOSE_PATH.split('/'));
}

/**
 * Materialize `.jamal/compose.yml` for `config` into `targetDir`. The file is
 * written only when its content differs from the deterministic plan, so repeat
 * runs leave an unchanged file untouched. Returns the absolute destination, or
 * `undefined` after reporting an error.
 */
async function materializeManagedCompose(
  deps: JamalDeps,
  targetDir: string,
  config: JamalConfig,
): Promise<string | undefined> {
  let plan: ReturnType<typeof planLocal>;
  try {
    plan = planLocal(config);
  } catch (error) {
    reportFailure(deps, error);
    return undefined;
  }
  const dest = join(targetDir, ...plan.path.split('/'));
  let current: string | undefined;
  try {
    current = await readFile(dest, 'utf8');
  } catch {
    current = undefined; // Missing or unreadable: (re)write the canonical plan.
  }
  if (current === plan.contents) {
    return dest;
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, plan.contents);
  } catch (error) {
    deps.stderr(`jsails: could not write ${plan.path}: ${formatError(error)}`);
    return undefined;
  }
  return dest;
}

/**
 * Spawn one fixed compose argv and forward its output/exit code. The one place
 * jamal spawns a process; the `runCommand` seam lets tests avoid Docker. A
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
    deps.stderr('jsails: docker compose is not available in this environment');
    return 127;
  }

  let result: DockerCommandResult;
  try {
    result = await deps.runCommand(argv, { cwd });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      deps.stderr(
        'jsails: docker compose is not available; install Docker with the compose plugin and ensure "docker" is on PATH',
      );
      return 127;
    }
    deps.stderr(`jsails: failed to run docker compose ${label}: ${formatError(error)}`);
    return 1;
  }

  if (result.stdout !== '') {
    deps.stdout(result.stdout.replace(/\n$/, ''));
  }
  if (result.stderr !== '') {
    deps.stderr(result.stderr.replace(/\n$/, ''));
  }
  if (result.exitCode !== 0) {
    deps.stderr(`jsails: docker compose ${label} exited with code ${result.exitCode}`);
  }
  return result.exitCode;
}

/**
 * Run one execution verb (`up`/`down`/`ps`/`logs`) against the local project.
 * Every verb drives the managed `.jamal/compose.yml` materialized from
 * `jamal.config.js`: `up` materializes it first, while the read/teardown verbs
 * require it to already exist (created by `jamal up` or `jamal dev --write`).
 * This is the one place jamal spawns a process; it never builds the registry,
 * runs a generator, or starts other services.
 */
export async function runDockerVerb(
  verb: DockerVerb,
  rest: readonly string[],
  values: { readonly dir?: string; readonly follow: boolean },
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

  let targetDir: string;
  try {
    targetDir = resolveTargetDir(deps.cwd, values.dir);
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }

  const service = verb === 'logs' ? rest[0] : undefined;

  if (verb === 'up') {
    const config = await loadConfigOrReport(deps, targetDir);
    if (config === undefined) {
      return 1;
    }
    if ((await materializeManagedCompose(deps, targetDir, config)) === undefined) {
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
      `jsails: no ${LOCAL_COMPOSE_PATH} found in ${targetDir}; run "jsails jamal up" to generate it first`,
    );
    return 1;
  }

  const config = await loadConfigOrReport(deps, targetDir);
  if (config === undefined) {
    return 1;
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
 * Run `jamal exec <service> -- <cmd...>` against the managed
 * `.jamal/compose.yml`. The `--` separator is required so the command's own
 * flags are never interpreted by jamal or `docker compose`; the managed file
 * must already exist (created by `jamal up`).
 */
export async function runDockerExec(
  tokens: readonly string[],
  hasTerminator: boolean,
  values: { readonly dir?: string },
  deps: JamalDeps,
): Promise<number> {
  if (!hasTerminator) {
    return usageFailure(
      deps,
      '"jamal exec" requires "--" before the command: jsails jamal exec <service> -- <cmd...>',
    );
  }
  const service = tokens[0];
  const command = tokens.slice(1);
  if (service === undefined || service === '') {
    return usageFailure(
      deps,
      '"jamal exec" requires a service name: jsails jamal exec <service> -- <cmd...>',
    );
  }
  if (command.length === 0) {
    return usageFailure(deps, '"jamal exec" requires a command after "--"');
  }

  let targetDir: string;
  try {
    targetDir = resolveTargetDir(deps.cwd, values.dir);
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }

  if (!existsSync(managedComposePath(targetDir))) {
    deps.stderr(
      `jsails: no ${LOCAL_COMPOSE_PATH} found in ${targetDir}; run "jsails jamal up" to generate it first`,
    );
    return 1;
  }

  const config = await loadConfigOrReport(deps, targetDir);
  if (config === undefined) {
    return 1;
  }

  const argv = execArgv(service, command, {
    file: LOCAL_COMPOSE_PATH,
    project: config.service,
  });
  return executeCompose(argv, targetDir, 'exec', deps);
}
