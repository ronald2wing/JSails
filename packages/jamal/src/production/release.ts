/**
 * Production release executor for jamal.
 *
 * {@link executeReleaseSteps} drives the host steps of a {@link ProductionPlan}
 * to completion, one step at a time, through injected seams so it never opens
 * an ssh connection or performs a real HTTP probe in tests. The caller holds
 * the deploy lock and passes its fenced runner, so every command runs only
 * while the lock is still this run's:
 *
 * - `network`, `pull`, `check`, `run`, the cache-proxy boot and health, and
 *   `retire` run remotely through the {@link RemoteRunner}. A `retire` that
 *   fails is a warning: the release is live and recorded by then, and the
 *   next deploy retires what is left.
 * - `repair-state`, `secrets-file`, `manifest`, `cache-proxy:write-vcl`, and
 *   `state` write their file through {@link writeRemoteFile}, fenced by the
 *   deploy lock and with the plan's precondition: the secrets file from the
 *   resolved env's bytes (create only), the manifest create only, the state
 *   by compare-and-replace of the bytes the run observed.
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
 * A lost lock ends the release at once: the fenced runner throws
 * `jamal_lock.lock_lost`, which is reported as the failed step. A preview
 * plan (`--dry-run`) is refused before any step runs.
 */

import { Async } from 'jsails/support';
import { JsailsError } from 'jsails/errors';
import type { ResolvedEnv } from '../env-resolve.js';
import { AccessoryError, runAccessories } from './accessories.js';
import { LockErrors } from './lock.js';

import type { ProductionPlan, ProductionStep, ProductionStepKind } from './plan.js';
import { ProcessRunnerError, type CommandResult } from './process-runner.js';
import type { RemoteRunner } from './transport.js';
import { RemoteFileErrors, writeRemoteFile, type RemoteWriteFence } from './remote-file.js';

/** Why the release executor refused its setup or a step. */
type ReleaseErrorCode = 'invalid_step' | 'missing_runner' | 'unsupported_step' | 'preview';

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
  /** The deploy lock's fenced runner. */
  readonly remoteRunner: RemoteRunner;
  /**
   * Replaces the default in-container probe with a URL check. Absent, each
   * health attempt runs the plan's health argv over ssh.
   */
  readonly healthCheck?: HealthCheck;
  readonly logger?: ReleaseLogger;
  /**
   * The resolved env split. The `secrets-file` step writes
   * {@link ResolvedEnv.secretsFile} to the host; without it that step fails.
   */
  readonly env?: ResolvedEnv;
  /** The deploy lock the file writes are fenced by, when the caller holds one. */
  readonly fence?: RemoteWriteFence;
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

/** How many trailing lines of a failed remote command's output reach the logger. */
const OUTPUT_TAIL_LINES = 20;

/** Slack added to the per-probe timeout for the ssh round trip of one health attempt. */
const HEALTH_SSH_SLACK_MS = 15_000;

/**
 * Report the last lines of one output stream of a failed command to the
 * operator's terminal, when it wrote any.
 */
function logOutputTail(
  logger: ReleaseLogger,
  kind: ProductionStepKind,
  stream: 'stdout' | 'stderr',
  output: string,
): void {
  const lines = output.trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') return;
  logger.warn(`${kind} ${stream} (last lines):\n${lines.slice(-OUTPUT_TAIL_LINES).join('\n')}`);
}

/** Map a thrown step error to a value-free {@link ReleaseFailure}. */
function failureFromError(kind: ProductionStepKind, error: unknown): ReleaseFailure {
  if (LockErrors.is(error) || RemoteFileErrors.is(error)) {
    return { kind, exitCode: 1, message: `${kind} failed: ${error.code}` };
  }
  if (error instanceof ProcessRunnerError) {
    return { kind, exitCode: 1, message: error.message };
  }
  return { kind, exitCode: 1, message: `${kind} failed` };
}

/**
 * Send a remote (`ssh`-prefixed) plan argv: its result, or the value-free
 * failure of a lost lock.
 */
async function sendPlanArgv(
  step: ProductionStep,
  options: RunReleaseOptions,
): Promise<{ readonly result: CommandResult } | { readonly failure: ReleaseFailure }> {
  const argv = step.argv;
  const server = argv?.[1];
  if (argv === undefined || argv[0] !== 'ssh' || server === undefined) {
    throw new ReleaseError('invalid_step', 'a production step has no remote argv to execute');
  }
  try {
    return { result: await options.remoteRunner.run(server, argv.slice(2)) };
  } catch (error) {
    if (LockErrors.is(error)) return { failure: failureFromError(step.kind, error) };
    throw error;
  }
}

/**
 * Execute a remote plan argv and convert a non-zero exit, or a lost lock,
 * into a value-free failure.
 */
async function executePlanArgv(
  step: ProductionStep,
  options: RunReleaseOptions,
  logger: ReleaseLogger = SILENT_LOGGER,
): Promise<StepResult> {
  const sent = await sendPlanArgv(step, options);
  if ('failure' in sent) return { status: 'failed', failure: sent.failure };
  const { result } = sent;
  if (result.exitCode !== 0) {
    // `jsails check --deploy` reports its findings on stdout, value-free.
    if (step.kind === 'check') logOutputTail(logger, step.kind, 'stdout', result.stdout);
    logOutputTail(logger, step.kind, 'stderr', result.stderr);
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

/**
 * Write a step's file through {@link writeRemoteFile}: the secrets file from
 * the resolved env (its bytes travel on stdin, never in an argv or the plan),
 * or the text the plan carries (the VCL, a manifest, `state.json`), with the
 * plan's precondition. A failure names only the step and the error code.
 */
async function runFileStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
): Promise<StepResult> {
  const file = step.file;
  const bytes =
    file === undefined
      ? undefined
      : file.source === 'secrets'
        ? options.env?.secretsFile
        : file.contents === undefined
          ? undefined
          : Buffer.from(file.contents, 'utf8');
  if (file === undefined || bytes === undefined) {
    return {
      status: 'failed',
      failure: {
        kind: step.kind,
        exitCode: 1,
        message: `the ${step.kind} step has no contents or destination path`,
      },
    };
  }
  try {
    await writeRemoteFile(options.remoteRunner, plan.server, file.path, bytes, {
      mode: file.mode,
      directoryMode: file.directoryMode,
      ...(options.fence === undefined ? {} : { fence: options.fence }),
      ...(file.expect === undefined ? {} : { expect: file.expect }),
    });
    return { status: 'completed' };
  } catch (error) {
    return { status: 'failed', failure: failureFromError(step.kind, error) };
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
    } catch (error) {
      // A lost lock is no unhealthy attempt to retry.
      if (LockErrors.is(error)) {
        return { status: 'failed', failure: failureFromError(step.kind, error) };
      }
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
  if (options.remoteRunner === undefined) {
    throw new ReleaseError('missing_runner', 'executeReleaseSteps requires a remote runner');
  }
  // A preview was planned without a pushed digest and without the lock.
  if (plan.preview) {
    throw new ReleaseError('preview', 'a preview plan (--dry-run) is never executed');
  }
  const logger = options.logger ?? SILENT_LOGGER;

  const completed: ProductionStepKind[] = [];
  const warnings: string[] = [...plan.warnings];
  for (const warning of plan.warnings) {
    logger.warn(warning);
  }

  for (const step of plan.steps) {
    // An accessory step reports its own progress (`runAccessories`).
    if (step.kind !== 'accessory') logger.info(step.description);
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

/**
 * Run one backing-service step (`accessories.ts`): volume, credentials env
 * file, container, or health poll. A failure names only the action.
 */
async function runAccessoryStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
  logger: ReleaseLogger,
): Promise<StepResult> {
  try {
    await runAccessories([step], {
      remoteRunner: options.remoteRunner,
      logger,
      sleep: options.sleep,
      env: options.env,
      server: plan.server,
      fence: options.fence,
    });
    return { status: 'completed' };
  } catch (error) {
    if (error instanceof AccessoryError) {
      return {
        status: 'failed',
        failure: {
          kind: 'accessory',
          exitCode: 1,
          message: `the accessory ${error.action} step failed`,
        },
      };
    }
    return { status: 'failed', failure: failureFromError(step.kind, error) };
  }
}

/**
 * Retire a container of another release. The new release is live and
 * recorded by now, so a container that could not be removed is a warning,
 * not a failed release: the next deploy observes it and retires it. A lost
 * lock still ends the run.
 */
async function runRetireStep(
  step: ProductionStep,
  options: RunReleaseOptions,
  warnings: string[],
  logger: ReleaseLogger,
): Promise<StepResult> {
  const sent = await sendPlanArgv(step, options);
  if ('failure' in sent) return { status: 'failed', failure: sent.failure };
  if (sent.result.exitCode === 0) return { status: 'completed' };
  logOutputTail(logger, step.kind, 'stderr', sent.result.stderr);
  const warning =
    'a container of an earlier release could not be removed; the next deploy retires it';
  warnings.push(warning);
  logger.warn(warning);
  return { status: 'skipped' };
}

/** Dispatch one step to its executor, mutating `warnings` for a deferred switch or retire. */
async function runStep(
  step: ProductionStep,
  plan: ProductionPlan,
  options: RunReleaseOptions,
  warnings: string[],
  logger: ReleaseLogger,
): Promise<StepResult> {
  switch (step.kind) {
    case 'network':
    case 'pull':
    case 'check':
    case 'run':
      return executePlanArgv(step, options, logger);
    case 'retire':
      return runRetireStep(step, options, warnings, logger);
    case 'repair-state':
    case 'secrets-file':
    case 'manifest':
    case 'cache-proxy:write-vcl':
    case 'state':
      return runFileStep(step, plan, options);
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

    // The cache proxy boots (or reloads) and is health-checked through the
    // same ssh executor as every other remote step.
    case 'cache-proxy:boot':
    case 'cache-proxy:health':
      return executePlanArgv(step, options, logger);
    case 'accessory':
      return runAccessoryStep(step, plan, options, logger);
    default:
      throw new ReleaseError('unsupported_step', 'unknown production step kind');
  }
}
