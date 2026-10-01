/**
 * Jamal production release verbs: `deploy` and `rollback` on the default
 * Docker/SSH (kamal) engine. Both **execute by default** and print the pure
 * {@link planProduction} plan with `--dry-run`. These are the only paths that
 * drive the remote release engine.
 */

import { formatError } from '../errors/inspect.js';
import {
  loadProductionConfigOrReport,
  readHistoryOrReport,
  reportFailure,
  type JamalDeps,
} from './deps.js';
import { resolveJamalEnv, type ResolvedEnv } from './env-resolve.js';
import type { JamalConfig } from './config/index.js';
import { DEFAULT_JAMAL_SECRETS_PATH, JamalSecretsError, loadJamalSecrets } from './secrets.js';
import { resolveSecretValueInline, splitCommandLine } from './secrets-command.js';
import { appendDeployEntry, type DeployHistoryEntry } from './production/history.js';
import type { HookRunner, HooksFilesystem } from './production/hooks.js';
import { createProcessRunner, type ProcessRunner } from './production/process-runner.js';
import { createRemoteRunner, type RemoteRunner } from './production/transport.js';
import type { HealthCheck, ReleaseLogger } from './production/release.js';
import { formatProductionPlan, planProduction } from './production/plan.js';
import {
  createFetchHealthCheck,
  createHooksFilesystem,
  createProcessHookRunner,
  defaultImageTag,
  runDeployExecution,
  runRollbackExecution,
} from './production/execute.js';
import { usageFailure } from './plan-command.js';
import { flagValue } from '../cli/global-flags.js';

/** The parsed values the `deploy`/`rollback` verbs read. */
interface ExecuteValues {
  readonly tag?: string;
  readonly write: boolean;
  readonly dir?: string;
  readonly target?: string;
  readonly 'dry-run': boolean;
}

/** The production seams a deploy/rollback injects; every one has a real default. */
interface ExecutionSeams {
  readonly commandRunner: ProcessRunner;
  readonly remoteRunner: RemoteRunner;
  readonly healthCheck: HealthCheck;
  readonly hooksFs: HooksFilesystem;
  readonly hookRunner: HookRunner;
}

/** Resolve the production seams from the injected deps, defaulting to real ones. */
function resolveExecutionSeams(deps: JamalDeps): ExecutionSeams {
  const processRunner = deps.processRunner ?? createProcessRunner();
  return {
    commandRunner: processRunner,
    remoteRunner: deps.remoteRunner ?? createRemoteRunner({ processRunner }),
    healthCheck: deps.healthCheck ?? createFetchHealthCheck(),
    hooksFs: deps.hooksFs ?? createHooksFilesystem(),
    hookRunner: deps.hookRunner ?? createProcessHookRunner(),
  };
}

/** A release logger that forwards step progress and warnings to the sinks. */
function releaseLogger(deps: JamalDeps): ReleaseLogger {
  return {
    info: (message) => deps.stdout(message),
    warn: (message) => deps.stderr(message),
  };
}

/**
 * The host path the env file is written to, mirroring Kamal's
 * `.kamal/apps/<service>-<destination>/env`. The destination segment is
 * omitted when no destination is set.
 */
function hostEnvFilePath(service: string, destination: string | undefined): string {
  const app = destination === undefined ? service : `${service}-${destination}`;
  return `/root/.jamal/apps/${app}/env`;
}

/**
 * Load the secrets files and resolve `config.env` into the clear/secret split.
 * Reports a value-free failure and resolves `undefined` so the caller can
 * return a non-zero exit code.
 */
async function resolveEnvForRelease(
  deps: JamalDeps,
  config: JamalConfig,
): Promise<ResolvedEnv | undefined> {
  const production = config.production;
  const loadSecrets = deps.loadSecrets ?? loadJamalSecrets;
  const secretsPath = production?.secretsPath ?? DEFAULT_JAMAL_SECRETS_PATH;
  const destination = production?.destination;
  try {
    const secrets = loadSecrets({
      rootDir: deps.cwd,
      destination,
      secretsPath,
      inlineSecrets: makeInlineSecretsRunner(deps, secretsPath, destination),
    });
    return resolveJamalEnv(config, secrets);
  } catch (error) {
    reportFailure(deps, error);
    return undefined;
  }
}

/**
 * The in-process runner for `$(jsails jamal secrets ...)` commands inside the
 * secrets files, mirroring Kamal's inline `kamal secrets` dispatch. The verb
 * and name come from the command itself; the secrets path and destination come
 * from the command's flags when present, else from the deploy config.
 */
function makeInlineSecretsRunner(
  deps: JamalDeps,
  secretsPath: string,
  destination: string | undefined,
): (command: string) => string {
  return (command) => {
    const argv = splitCommandLine(command);
    const verb = argv[3];
    const name = argv[4];
    if ((verb !== 'fetch' && verb !== 'extract') || name === undefined) {
      throw new JamalSecretsError(
        'command_failed',
        'an inline secrets command must be `jsails jamal secrets <fetch|extract> <name>`',
      );
    }
    return resolveSecretValueInline({
      rootDir: deps.cwd,
      verb,
      name,
      secretsPath: flagValue(argv, '--secrets-path') ?? secretsPath,
      destination: flagValue(argv, '--destination') ?? destination,
    });
  };
}

/** Resolve the image tag: `--tag` wins, else the injected resolver. */
async function resolveImageTag(deps: JamalDeps, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  const resolver = deps.resolveTag ?? ((cwd: string) => defaultImageTag(cwd));
  return resolver(deps.cwd);
}

/** Record a deploy history entry; a write failure is a warning, never fatal. */
async function recordHistory(deps: JamalDeps, entry: DeployHistoryEntry): Promise<void> {
  const append =
    deps.appendHistory ??
    ((dir: string, value: DeployHistoryEntry) => appendDeployEntry(dir, value));
  try {
    await append(deps.cwd, entry);
  } catch (error) {
    deps.stderr(`jsails: warning: could not record deploy history: ${formatError(error)}`);
  }
}

/** `jamal deploy`: perform a real production deploy. */
async function runDeployExecute(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  const config = await loadProductionConfigOrReport(deps, 'deploy');
  if (config === undefined) {
    return 1;
  }

  let tag: string;
  try {
    tag = await resolveImageTag(deps, values.tag);
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }

  const history = await readHistoryOrReport(deps);
  if (history === undefined) {
    return 1;
  }
  const previousTag = history.entries[history.entries.length - 1]?.tag;
  const env = await resolveEnvForRelease(deps, config);
  if (env === undefined) {
    return 1;
  }
  const seams = resolveExecutionSeams(deps);

  let result;
  try {
    result = await runDeployExecution({
      config,
      imageTag: tag,
      previousTag,
      commandRunner: seams.commandRunner,
      remoteRunner: seams.remoteRunner,
      healthCheck: seams.healthCheck,
      hooksFs: seams.hooksFs,
      hookRunner: seams.hookRunner,
      cwd: deps.cwd,
      logger: releaseLogger(deps),
      env,
      envFilePath: hostEnvFilePath(config.service, config.production?.destination),
    });
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }

  await recordHistory(deps, result.entry);
  deps.stdout(`deployed ${config.image}:${tag}`);
  return 0;
}

/** `jamal rollback`: deploy the previous recorded tag. */
async function runRollbackExecute(deps: JamalDeps): Promise<number> {
  const config = await loadProductionConfigOrReport(deps, 'rollback');
  if (config === undefined) {
    return 1;
  }
  const resolved = await resolveRollbackTags(deps);
  if (resolved === undefined) {
    return 1;
  }
  const env = await resolveEnvForRelease(deps, config);
  if (env === undefined) {
    return 1;
  }
  const seams = resolveExecutionSeams(deps);

  let result;
  try {
    result = await runRollbackExecution({
      config,
      imageTag: resolved.target.tag,
      previousTag: resolved.current.tag,
      commandRunner: seams.commandRunner,
      remoteRunner: seams.remoteRunner,
      healthCheck: seams.healthCheck,
      hooksFs: seams.hooksFs,
      hookRunner: seams.hookRunner,
      cwd: deps.cwd,
      logger: releaseLogger(deps),
      env,
      envFilePath: hostEnvFilePath(config.service, config.production?.destination),
    });
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }

  await recordHistory(deps, result.entry);
  deps.stdout(`rolled back to ${config.image}:${resolved.target.tag}`);
  return 0;
}

/** The two history entries a rollback deploys between: target (prior) and current (latest). */
interface RollbackTags {
  readonly target: DeployHistoryEntry;
  readonly current: DeployHistoryEntry;
}

/** Derive the rollback tags from history, reporting a value-free failure otherwise. */
async function resolveRollbackTags(deps: JamalDeps): Promise<RollbackTags | undefined> {
  const history = await readHistoryOrReport(deps);
  if (history === undefined) {
    return undefined;
  }
  const entries = history.entries;
  if (entries.length === 0) {
    deps.stderr('jsails: no deploy history to roll back');
    return undefined;
  }
  if (entries.length < 2) {
    deps.stderr('jsails: no previous deploy to roll back to');
    return undefined;
  }
  const current = entries[entries.length - 1];
  const target = entries[entries.length - 2];
  if (current === undefined || target === undefined) {
    deps.stderr('jsails: no previous deploy to roll back to');
    return undefined;
  }
  return { target, current };
}

/** Render a production plan to stdout for `--dry-run`, or report a plan failure. */
function printPlanDryRun(
  deps: JamalDeps,
  config: JamalConfig,
  imageTag: string,
  env: ResolvedEnv,
  previousTag?: string,
): number {
  let plan;
  try {
    plan = planProduction(config, {
      imageTag,
      previousTag,
      env,
      envFilePath: hostEnvFilePath(config.service, config.production?.destination),
    });
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }
  deps.stdout(formatProductionPlan(plan));
  return 0;
}

/** `jamal deploy --dry-run`: print the production plan and execute nothing. */
async function runDeployDryRun(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  const config = await loadProductionConfigOrReport(deps, 'deploy');
  if (config === undefined) {
    return 1;
  }
  let tag: string;
  try {
    tag = await resolveImageTag(deps, values.tag);
  } catch (error) {
    reportFailure(deps, error);
    return 1;
  }
  const history = await readHistoryOrReport(deps);
  if (history === undefined) {
    return 1;
  }
  const previousTag = history.entries[history.entries.length - 1]?.tag;
  const env = await resolveEnvForRelease(deps, config);
  if (env === undefined) {
    return 1;
  }
  return printPlanDryRun(deps, config, tag, env, previousTag);
}

/** `jamal rollback --dry-run`: print the rollback plan and execute nothing. */
async function runRollbackDryRun(deps: JamalDeps): Promise<number> {
  const config = await loadProductionConfigOrReport(deps, 'rollback');
  if (config === undefined) {
    return 1;
  }
  const resolved = await resolveRollbackTags(deps);
  if (resolved === undefined) {
    return 1;
  }
  const env = await resolveEnvForRelease(deps, config);
  if (env === undefined) {
    return 1;
  }
  return printPlanDryRun(deps, config, resolved.target.tag, env, resolved.current.tag);
}

/**
 * `jamal deploy` on the kamal engine: execute by default, preview with
 * `--dry-run`. The YAML-planning flags (`--write`/`--dir`) never apply to the
 * engine, which generates no files.
 */
export async function runDeployCommand(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  if (values.write) {
    return usageFailure(deps, '--write is not valid for `deploy --target kamal`');
  }
  if (values.dir !== undefined) {
    return usageFailure(deps, '--dir is not valid for `deploy --target kamal`');
  }
  if (values['dry-run']) {
    return runDeployDryRun(deps, values);
  }
  return runDeployExecute(deps, values);
}

/**
 * `jamal rollback`: execute by default, preview with `--dry-run`.
 */
export async function runRollbackCommand(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  if (values['dry-run']) {
    return runRollbackDryRun(deps);
  }
  return runRollbackExecute(deps);
}
