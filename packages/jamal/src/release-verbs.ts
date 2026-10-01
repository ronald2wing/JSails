/**
 * Jamal production release verbs: `deploy` and `rollback` on the
 * Docker/SSH engine. Both **execute by default** and print the release plan
 * (`production/plan.ts`) with `--dry-run`, planned from a read-only look at
 * the server. These are the only paths that drive the remote release engine;
 * the server's `state.json` and release manifests are their only record.
 */

import {
  loadProductionConfigOrReport,
  remoteRunnerFor,
  reportFailure,
  type JamalDeps,
} from './deps.js';
import { withCredentialsKey } from './credentials-delivery.js';
import { resolveJamalEnv, type ResolvedEnv } from './env-resolve.js';
import type { JamalConfig } from './config/index.js';
import { DEFAULT_JAMAL_SECRETS_PATH, JamalSecretsError, loadJamalSecrets } from './secrets.js';
import { splitCommandLine } from './command-line.js';
import { resolveSecretValueInline } from './secrets-command.js';
import { createProcessRunner, type ProcessRunner } from './production/process-runner.js';
import type { RemoteRunner } from './production/transport.js';
import type { HealthCheck, ReleaseLogger } from './production/release.js';
import { formatProductionPlan } from './production/plan.js';
import {
  previewDeploy,
  previewRollback,
  runDeployExecution,
  runRollbackExecution,
  type DeployExecutionOptions,
} from './production/execute.js';

/** The parsed values the `deploy`/`rollback` verbs read. */
interface ExecuteValues {
  readonly 'allow-dirty'?: boolean;
  readonly 'dry-run': boolean;
}

/** The production seams a deploy/rollback injects; every one has a real default. */
interface ExecutionSeams {
  readonly commandRunner: ProcessRunner;
  readonly remoteRunner: RemoteRunner;
  /** Absent: the default in-container probe over ssh. */
  readonly healthCheck: HealthCheck | undefined;
}

/**
 * Resolve the production seams from the injected deps, defaulting to real
 * ones. The default remote runner applies `config.production.ssh`.
 */
function resolveExecutionSeams(deps: JamalDeps, config: JamalConfig): ExecutionSeams {
  const processRunner = deps.processRunner ?? createProcessRunner();
  return {
    commandRunner: processRunner,
    remoteRunner: remoteRunnerFor({ ...deps, processRunner }, config.production!),
    healthCheck: deps.healthCheck,
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
 * Load the secrets files and resolve `config.env` into the clear/secret split.
 * Reports a value-free failure and resolves `undefined` so the caller can
 * return a non-zero exit code. Shared with `jamal accessory boot`, which needs
 * the same credentials a deploy writes. It never carries the credentials key:
 * only {@link resolveAppEnvForRelease} adds it, for the app container.
 */
export async function resolveEnvForRelease(
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
    await reportFailure(deps, error);
    return undefined;
  }
}

/**
 * {@link resolveEnvForRelease} plus the credentials key the app container
 * decrypts its sealed credentials with, when the deployment's environment has
 * them (`credentials-delivery.ts`). The release that runs the app (`deploy`,
 * `rollback`, and their `--dry-run` plans) resolves its env here.
 */
async function resolveAppEnvForRelease(
  deps: JamalDeps,
  config: JamalConfig,
): Promise<ResolvedEnv | undefined> {
  const env = await resolveEnvForRelease(deps, config);
  if (env === undefined) return undefined;
  try {
    return withCredentialsKey(env, deps.deploymentCredentials);
  } catch (error) {
    await reportFailure(deps, error);
    return undefined;
  }
}

/**
 * The in-process runner for `$(jamal secrets ...)` commands inside the
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
    const verb = argv[2];
    const name = argv[3];
    if ((verb !== 'fetch' && verb !== 'extract') || name === undefined) {
      throw new JamalSecretsError(
        'command_failed',
        'an inline secrets command must be `jamal secrets <fetch|extract> <name>`',
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

/** The value after `flag` in `argv` (`--flag value` or `--flag=value`), if any. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === flag) return argv[index + 1];
    if (token !== undefined && token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

/** The release options every deploy, rollback, and preview shares. */
async function releaseOptions(
  deps: JamalDeps,
  verb: 'deploy' | 'rollback',
  values: ExecuteValues,
): Promise<DeployExecutionOptions | undefined> {
  const config = await loadProductionConfigOrReport(deps, verb);
  if (config === undefined) return undefined;
  const env = await resolveAppEnvForRelease(deps, config);
  if (env === undefined) return undefined;
  const seams = resolveExecutionSeams(deps, config);
  return {
    config,
    env,
    commandRunner: seams.commandRunner,
    remoteRunner: seams.remoteRunner,
    healthCheck: seams.healthCheck,
    cwd: deps.cwd,
    logger: releaseLogger(deps),
    allowDirty: values['allow-dirty'] === true,
    ...(deps.readGitState === undefined ? {} : { readGitState: deps.readGitState }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
}

/** `jamal deploy`: execute by default, preview with `--dry-run`. */
export async function runDeployCommand(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  const options = await releaseOptions(deps, 'deploy', values);
  if (options === undefined) return 1;
  try {
    if (values['dry-run']) {
      deps.stdout(formatProductionPlan(await previewDeploy(options)));
      return 0;
    }
    const { plan } = await runDeployExecution(options);
    deps.stdout(`deployed ${plan.releaseId} (${plan.imageRef})`);
    return 0;
  } catch (error) {
    await reportFailure(deps, error);
    return 1;
  }
}

/**
 * `jamal rollback`: run the previous release the server records again, with
 * its own image digest and secrets; preview with `--dry-run`.
 */
export async function runRollbackCommand(deps: JamalDeps, values: ExecuteValues): Promise<number> {
  const options = await releaseOptions(deps, 'rollback', values);
  if (options === undefined) return 1;
  try {
    if (values['dry-run']) {
      deps.stdout(formatProductionPlan(await previewRollback(options)));
      return 0;
    }
    const { plan } = await runRollbackExecution(options);
    deps.stdout(`rolled back to ${plan.releaseId} (${plan.imageRef})`);
    return 0;
  } catch (error) {
    await reportFailure(deps, error);
    return 1;
  }
}
