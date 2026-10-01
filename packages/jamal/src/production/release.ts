/**
 * Production release executor for jamal.
 *
 * {@link executeReleaseSteps} drives a {@link ProductionPlan} to completion, one step at
 * a time, through injected seams so it never spawns a process, opens an ssh
 * connection, or performs a real HTTP probe in tests:
 *
 * - `build` and `push` run locally via {@link runBuild}/{@link runPush}, with
 *   their output streamed to the operator's terminal.
 * - `network`, `pull`, `run`, `stop`, and (when requested) `rollback` run
 *   remotely through the {@link RemoteRunner}, which assembles the `ssh` argv
 *   via {@link sshArgv}. A remote step whose plan argv is absent has nothing to
 *   do (a first deploy has no previous container to stop) and is skipped.
 * - `health` makes one bounded attempt at a time and is retried up to the
 *   configured budget. By default an attempt runs the plan's probe inside the
 *   new container over ssh, so it checks the release being deployed rather
 *   than whatever the proxy currently routes; an injected `healthCheck(url,
 *   { timeoutMs, intervalMs })` replaces it and must resolve on success and
 *   throw on failure.
 * - `switch` executes its argv — the `kamal-proxy deploy` command the plan
 *   supplies when a production domain is set — over ssh via the same remote
 *   executor; otherwise the proxy container switch is deferred and recorded as
 *   a warning.
 *
 * The release stops on the first failure and returns a {@link ReleaseSummary}
 * whose `failedStep` names only the step kind and exit code — the image
 * reference, server, health URL, and any command output are never echoed in
 * it. The tail of a failed remote command's stderr goes to the logger (the
 * operator's own terminal). When a step marked `cleanupOnFailure` fails, the
 * new container is removed so it does not linger next to the live release.
 * Rollback is opt-in via `rollback: true`; it is never performed automatically.
 */

import { JsailsError, Async } from 'jsails/support';
import { BuildError, runBuild, runPush } from './build.js';
import type { ResolvedEnv } from '../env-resolve.js';
import type { ProductionPlan, ProductionStep, ProductionStepKind } from './plan.js';
import { ProcessRunnerError, type CommandResult, type ProcessRunner } from './process-runner.js';
import type { RemoteRunner } from './transport.js';
import { RemoteFileError, writeRemoteFile } from './remote-file.js';

/** Why the release executor refused its setup or a step. */
type ReleaseErrorCode = 'invalid_step' | 'missing_runner' | 'unsupported_step';

/** Raised for a malformed release setup, not for a step failure. Value-free. */
class ReleaseError extends JsailsError {
  constructor(
    readonly code: ReleaseErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The health poll timings a {@link HealthCheck} receives. */
interface HealthPollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

/**
 * One bounded health attempt against a URL: resolve when healthy, throw when
 * not. The executor owns the retry budget, so an implementation must not loop.
 */
export type HealthCheck = (url: string, options: HealthPollOptions) => Promise<void>;

/** Delay seam; injected so tests avoid real timers. */
type Sleep = (ms: number) => Promise<void>;

/**
 * Retry policy for the health step. A failed health check is retried — a
 * container that is not ready yet should not fail a release — with a fixed
 * delay between attempts, bounded by a hard attempt cap.
 */
interface HealthRetryOptions {
  /** Number of retries after the first attempt. Defaults to {@link DEFAULT_HEALTH_RETRIES}. */
  readonly retries?: number;
  /** Delay between attempts, in milliseconds. Defaults to {@link DEFAULT_HEALTH_RETRY_DELAY_MS}. */
  readonly delayMs?: number;
  /** Hard cap on total attempts. Defaults to {@link DEFAULT_HEALTH_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

/** Default retries after the first health-check attempt. */
const DEFAULT_HEALTH_RETRIES = 5;

/** Default delay between health-check attempts, in milliseconds. */
const DEFAULT_HEALTH_RETRY_DELAY_MS = 10_000;

/** Default hard cap on total health-check attempts. */
const DEFAULT_HEALTH_MAX_ATTEMPTS = 15;

/** Optional progress/warning sink; a silent default is used when omitted. */
export interface ReleaseLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Options for {@link executeReleaseSteps}. */
interface RunReleaseOptions {
  readonly commandRunner: ProcessRunner;
  readonly remoteRunner: RemoteRunner;
  /**
   * Replaces the default in-container probe with a URL check. Absent, each
   * health attempt runs the plan's health argv over ssh.
   */
  readonly healthCheck?: HealthCheck;
  readonly logger?: ReleaseLogger;
  /**
   * The resolved env split. The `env-file` step writes {@link ResolvedEnv.envFile}
   * to the host; without it an env-file step has no contents and fails.
   */
  readonly env?: ResolvedEnv;
  /** Execute the rollback step; it is skipped unless exactly `true`. */
  readonly rollback?: boolean;
  /** Retry policy for the health step; defaults applied when omitted. */
  readonly healthRetry?: HealthRetryOptions;
  /** Delay seam for the health retry loop; defaults to `setTimeout`. */
  readonly sleep?: Sleep;
}

/** A failed step: its kind, exit code, and a value-free message. */
interface ReleaseFailure {
  readonly kind: ProductionStepKind;
  readonly exitCode: number;
  readonly message: string;
}

/** The outcome of a release: completed step kinds, an optional failure, warnings. */
export interface ReleaseSummary {
  readonly completed: readonly ProductionStepKind[];
  readonly failedStep?: ReleaseFailure;
  readonly warnings: readonly string[];
}

/** The result of executing one step: completed, skipped, or failed. */
type StepResult =
  | { readonly status: 'completed' }
  | { readonly status: 'skipped' }
  | { readonly status: 'failed'; readonly failure: ReleaseFailure };

const SILENT_LOGGER: ReleaseLogger = { info: () => {}, warn: () => {} };

/** How many trailing stderr lines of a failed remote command reach the logger. */
const STDERR_TAIL_LINES = 20;

/** Slack added to the per-probe timeout for the ssh round trip of one health attempt. */
const HEALTH_SSH_SLACK_MS = 15_000;

/** Report the tail of a failed command's stderr to the operator's terminal. */
function logStderrTail(logger: ReleaseLogger, kind: ProductionStepKind, stderr: string): void {
  const lines = stderr.trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') return;
  logger.warn(`${kind} stderr (last lines):\n${lines.slice(-STDERR_TAIL_LINES).join('\n')}`);
}

const EXIT_CODE_PATTERN = /exited with code (\d+)/;

/** Extract the exit code embedded in a value-free {@link BuildError} message. */
function parseExitCode(message: string): number | undefined {
  const match = EXIT_CODE_PATTERN.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/** Map a thrown step error to a value-free {@link ReleaseFailure}. */
function failureFromError(kind: ProductionStepKind, error: unknown): ReleaseFailure {
  if (error instanceof BuildError) {
    return { kind, exitCode: parseExitCode(error.message) ?? 1, message: error.message };
  }
  if (error instanceof ProcessRunnerError) {
    return { kind, exitCode: 1, message: error.message };
  }
  return { kind, exitCode: 1, message: `${kind} failed` };
}

/**
 * Execute a remote (`ssh`-prefixed) or local plan argv and convert a non-zero
 * exit into a value-free failure. An absent argv is a skip for `stop` (nothing
 * to stop) and an error for every other kind.
 */
async function executePlanArgv(
  step: ProductionStep,
  options: RunReleaseOptions,
  logger: ReleaseLogger = SILENT_LOGGER,
): Promise<StepResult> {
  const argv = step.argv;
  if (argv === undefined) {
    if (step.kind === 'stop') return { status: 'skipped' };
    throw new ReleaseError('invalid_step', 'a production step has no argv to execute');
  }

  let result: CommandResult;
  if (argv[0] === 'ssh') {
    const server = argv[1];
    if (server === undefined) {
      throw new ReleaseError('invalid_step', 'a remote production step has a malformed ssh argv');
    }
    result = await options.remoteRunner.run(server, argv.slice(2));
  } else {
    result = await options.commandRunner(argv);
  }

  if (result.exitCode !== 0) {
    logStderrTail(logger, step.kind, result.stderr);
    return {
      status: 'failed',
      failure: {
        kind: step.kind,
        exitCode: result.exitCode,
        message: `${step.kind} exited with code ${result.exitCode}`,
      },
    };
  }
  return { status: 'completed' };
}

/** Run the local build/push step through {@link runBuild}/{@link runPush}. */
async function runLocalStep(
  step: ProductionStep,
  imageRef: string,
  commandRunner: ProcessRunner,
): Promise<StepResult> {
  try {
    if (step.kind === 'build') {
      await runBuild(imageRef, commandRunner);
    } else {
      await runPush(imageRef, commandRunner);
    }
    return { status: 'completed' };
  } catch (error) {
    return { status: 'failed', failure: failureFromError(step.kind, error) };
  }
}

/**
 * Write the env file to the host through {@link writeRemoteFile}. The contents
 * (the resolved secret channel) travel on stdin, never in an argv, so a secret
 * value cannot appear in the remote `ps` output; the file is created mode 0600
 * with its parent directory.
 */
async function runEnvFileStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
): Promise<StepResult> {
  const path = step.envFilePath;
  const contents = options.env?.envFile;
  if (path === undefined || contents === undefined) {
    return {
      status: 'failed',
      failure: {
        kind: 'env-file',
        exitCode: 1,
        message: 'the env-file step has no contents or destination path',
      },
    };
  }

  try {
    await writeRemoteFile(options.remoteRunner, plan.server, path, contents);
    return { status: 'completed' };
  } catch (error) {
    if (error instanceof RemoteFileError) {
      const exitCode = error.exitCode ?? 1;
      return {
        status: 'failed',
        failure: { kind: 'env-file', exitCode, message: `env-file exited with code ${exitCode}` },
      };
    }
    return { status: 'failed', failure: failureFromError('env-file', error) };
  }
}

/** Resolve the health-step retry policy with defaults applied. */
function resolveRetryPolicy(options?: HealthRetryOptions): Required<HealthRetryOptions> {
  return {
    retries: options?.retries ?? DEFAULT_HEALTH_RETRIES,
    delayMs: options?.delayMs ?? DEFAULT_HEALTH_RETRY_DELAY_MS,
    maxAttempts: options?.maxAttempts ?? DEFAULT_HEALTH_MAX_ATTEMPTS,
  };
}

/**
 * One health attempt: the injected {@link HealthCheck} when present, else the
 * step's in-container probe over ssh with a timeout covering the probe plus
 * the ssh round trip. Throws when the attempt is not healthy.
 */
async function healthAttempt(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
  pollOptions: HealthPollOptions,
): Promise<void> {
  if (options.healthCheck !== undefined) {
    await options.healthCheck(plan.healthUrl, pollOptions);
    return;
  }
  const argv = step.argv;
  if (argv === undefined || argv[0] !== 'ssh' || argv[1] === undefined) {
    throw new ReleaseError('invalid_step', 'the health step has no probe to run');
  }
  const result = await options.remoteRunner.run(argv[1], argv.slice(2), {
    timeoutMs: plan.healthTimeoutMs + HEALTH_SSH_SLACK_MS,
  });
  if (result.exitCode !== 0) {
    throw new ReleaseError('invalid_step', 'the health probe failed');
  }
}

/**
 * Run the health step, retrying a failed attempt up to the configured policy
 * before declaring the step failed. The budget is `1 + retries` attempts
 * capped by `maxAttempts`; a delay separates attempts so a not-yet-ready
 * container has time to come up. Every attempt is bounded, so the step always
 * ends and the deploy lock is released.
 */
async function runHealthStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
): Promise<StepResult> {
  const retry = resolveRetryPolicy(options.healthRetry);
  const sleep = options.sleep ?? Async.sleep;

  const effectiveRetries = plan.healthRetries !== undefined ? plan.healthRetries : retry.retries;
  const effectiveDelayMs =
    plan.healthRetryDelayMs !== undefined ? plan.healthRetryDelayMs : retry.delayMs;
  const maxAttempts = Math.max(1, Math.min(retry.maxAttempts, effectiveRetries + 1));
  const pollOptions: HealthPollOptions = {
    timeoutMs: plan.healthTimeoutMs,
    intervalMs: plan.healthIntervalMs,
  };

  if (plan.healthReadinessDelayMs !== undefined && plan.healthReadinessDelayMs > 0) {
    await sleep(plan.healthReadinessDelayMs);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await healthAttempt(step, plan, options, pollOptions);
      return { status: 'completed' };
    } catch {
      if (attempt < maxAttempts) {
        await sleep(effectiveDelayMs);
      }
    }
  }

  return {
    status: 'failed',
    failure: { kind: 'health', exitCode: 1, message: 'the health check timed out' },
  };
}

/**
 * Execute `plan.steps` in order and return a summary. The first failing step
 * ends the release immediately; completed steps and any warnings (the plan's
 * reminders plus a deferred proxy switch) are reported value-free.
 */
export async function executeReleaseSteps(
  plan: ProductionPlan,
  options: RunReleaseOptions,
): Promise<ReleaseSummary> {
  const { commandRunner, remoteRunner } = options;
  if (commandRunner === undefined || remoteRunner === undefined) {
    throw new ReleaseError(
      'missing_runner',
      'executeReleaseSteps requires a command runner and a remote runner',
    );
  }
  const logger = options.logger ?? SILENT_LOGGER;

  const completed: ProductionStepKind[] = [];
  const warnings: string[] = [...plan.warnings];
  for (const warning of plan.warnings) {
    logger.warn(warning);
  }

  for (const step of plan.steps) {
    logger.info(step.description);
    const result = await runStep(step, plan, options, warnings, logger);
    if (result.status === 'failed') {
      if (step.cleanupOnFailure === true) {
        await removeNewContainer(plan, options, logger);
      }
      return { completed, failedStep: result.failure, warnings };
    }
    if (result.status === 'completed') {
      completed.push(step.kind);
    }
  }

  return { completed, warnings };
}

/**
 * Remove the container a failed release started. Best effort: the release has
 * already failed, so a cleanup failure is reported as a warning, not raised.
 */
async function removeNewContainer(
  plan: ProductionPlan,
  options: RunReleaseOptions,
  logger: ReleaseLogger,
): Promise<void> {
  const argv = plan.cleanupArgv;
  const server = argv[1];
  if (argv[0] !== 'ssh' || server === undefined) return;
  logger.info(`Remove the failed release container ${plan.containerName}.`);
  try {
    const result = await options.remoteRunner.run(server, argv.slice(2));
    if (result.exitCode !== 0) {
      logger.warn('the failed release container could not be removed');
    }
  } catch {
    logger.warn('the failed release container could not be removed');
  }
}

/** Dispatch one step to its executor, mutating `warnings` for a deferred switch. */
async function runStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
  warnings: string[],
  logger: ReleaseLogger,
): Promise<StepResult> {
  switch (step.kind) {
    case 'build':
    case 'push':
      return runLocalStep(step, plan.imageRef, options.commandRunner);
    case 'network':
    case 'pull':
    case 'run':
    case 'stop':
      return executePlanArgv(step, options, logger);
    case 'env-file':
      return runEnvFileStep(step, plan, options);
    case 'health':
      return runHealthStep(step, plan, options);
    case 'switch':
      if (step.argv === undefined) {
        const warning = 'the proxy switch is deferred: no explicit switch argv was provided';
        warnings.push(warning);
        logger.warn(warning);
        return { status: 'skipped' };
      }
      return executePlanArgv(step, options, logger);
    case 'rollback':
      if (options.rollback !== true) {
        return { status: 'skipped' };
      }
      return executePlanArgv(step, options, logger);
    // Cache-proxy steps run remotely — write the VCL file, boot the
    // container, then health-check it — using the same ssh executor as
    // every other remote step.
    case 'cache-proxy:write-vcl':
    case 'cache-proxy:boot':
    case 'cache-proxy:health':
      return executePlanArgv(step, options, logger);
    default:
      throw new ReleaseError('unsupported_step', 'unknown production step kind');
  }
}
