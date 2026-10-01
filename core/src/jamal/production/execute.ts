/**
 * Jamal production deploy/rollback execution.
 *
 * {@link runDeployExecution} and {@link runRollbackExecution} are the one place
 * jamal actually performs a production release: they acquire the remote deploy
 * lock, run the opt-in pre-build/pre-deploy hooks, ensure the shared network,
 * start the accessories, drive {@link executeReleaseSteps} over a
 * {@link planProduction} plan, run the post-deploy hook on success, and always
 * release the lock — on success, on failure, and on SIGINT/SIGTERM, which
 * would otherwise end the process before any `finally` runs. A lock that
 * cannot be released is reported as a warning naming `jamal lock release`. A failed step surfaces as a value-free
 * {@link DeployExecuteError} (or {@link RollbackError}) naming only the step kind
 * — the image reference, server, health URL, and any command output are never
 * echoed. Recording the success in the local deploy history is the caller's job,
 * not this module's.
 *
 * The module also carries the pure defaults the CLI wires in: a single-attempt
 * {@link createFetchHealthCheck}, the git-derived {@link defaultImageTag}, the
 * {@link deployLockDir}, the process-spawning {@link createProcessHookRunner}
 * and {@link createHooksFilesystem}, and the remote inspection argv builders
 * (`status`/`logs`/`exec`) that reconstruct a container from a recorded tag.
 */

import { JsailsError } from '../../errors/jsails-error.js';
import { Async } from '../../support/index.js';
import { accessSync, constants, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, userInfo } from 'node:os';

import type { JamalConfig } from '../config/index.js';
import type { ResolvedEnv } from '../env-resolve.js';
import { acquireLock, type LockHandle } from './lock.js';
import { hostLockDir } from './host-layout.js';
import { planProduction, type ProductionPlan } from './plan.js';
import { runAccessories, AccessoryError } from './accessories.js';
import {
  executeReleaseSteps,
  type HealthCheck,
  type ReleaseLogger,
  type ReleaseSummary,
} from './release.js';
import { runHookPhase, type HookRunner, type HooksFilesystem } from './hooks.js';
import { type CommandResult, type ProcessRunner } from './process-runner.js';
import type { RemoteRunner } from './transport.js';
import type { DeployHistoryEntry } from './history.js';
import { CONTROL_CHARS } from '../../support/strings.js';

/** Why a deploy or rollback was refused or failed. */
export type DeployExecuteErrorCode = 'invalid_container' | 'missing_production' | 'step_failed';

/** Raised for a failed or malformed deploy; the message is value-free. */
export class DeployExecuteError extends JsailsError {
  constructor(
    readonly code: DeployExecuteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Raised for a failed rollback; the message is value-free. */
export class RollbackError extends DeployExecuteError {}

/** The seams {@link runDeployExecution} injects; never touched in tests. */
export interface DeployExecutionOptions {
  readonly config: JamalConfig;
  readonly imageTag: string;
  readonly previousTag?: string;
  /** The container the previous release runs in, from its history entry. */
  readonly previousContainer?: string;
  readonly commandRunner: ProcessRunner;
  readonly remoteRunner: RemoteRunner;
  /**
   * Replaces the default health probe (run inside the new container over ssh)
   * with a URL check; one call is one bounded attempt.
   */
  readonly healthCheck?: HealthCheck;
  readonly hooksFs: HooksFilesystem;
  readonly hookRunner: HookRunner;
  readonly hooksDir?: string;
  readonly cwd?: string;
  readonly logger?: ReleaseLogger;
  /**
   * The resolved env split. When present, `clear` entries become `-e` flags and
   * `secret` entries are written to {@link envFilePath} on the host. When
   * absent, `config.env` is planned as name-only references (preview behavior).
   */
  readonly env?: ResolvedEnv;
  /** Host path the env file is written to; required when `env` has secrets. */
  readonly envFilePath?: string;
  /** Delay seam for the accessory health retry loop; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Where SIGINT/SIGTERM are observed while the lock is held; defaults to
   * `process`. Injected so tests can simulate an interrupt.
   */
  readonly signals?: SignalSource;
  /**
   * Called after the lock was released for an interrupt; defaults to
   * re-raising the signal so the process ends the way it would have.
   */
  readonly onInterrupted?: (signal: InterruptSignal) => void;
  /** The owner line recorded in the lock; defaults to `user@host since <time>`. */
  readonly lockOwner?: string;
}

/** The signals that end a deploy early. */
export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/** The slice of `process` the interrupt handling needs. */
export interface SignalSource {
  once(signal: InterruptSignal, listener: () => void): unknown;
  removeListener(signal: InterruptSignal, listener: () => void): unknown;
}

/** The outcome of a successful release: the summary plus the history entry to record. */
export interface DeployExecutionResult {
  readonly summary: ReleaseSummary;
  readonly entry: DeployHistoryEntry;
}

/**
 * The deploy lock directory on the remote server for a service, relative to
 * the ssh user's home. Exported so the CLI's tests can assert where the lock
 * is created.
 */
export function deployLockDir(service: string): string {
  return hostLockDir(service);
}

/** Raised by {@link createFetchHealthCheck} for an unhealthy attempt. Value-free. */
export class HealthCheckError extends JsailsError {
  readonly code = 'unhealthy';
}

/**
 * A URL health check: one request bounded by `timeoutMs`, resolving on a 2xx
 * response and throwing otherwise. It never loops; the release executor owns
 * the retry budget, so an unhealthy release fails instead of hanging.
 */
export function createFetchHealthCheck(): HealthCheck {
  return async (url, options) => {
    const timeout = Async.timeout(options.timeoutMs);
    let healthy = false;
    try {
      const response = await fetch(url, { signal: timeout.signal });
      healthy = response.ok;
    } catch {
      healthy = false;
    } finally {
      timeout.clear();
    }
    if (!healthy) {
      throw new HealthCheckError('the health check did not succeed');
    }
  };
}

/** The default lock owner line: who is deploying, from where, since when. */
function defaultLockOwner(): string {
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    // A uid without a passwd entry (some containers) has no username.
    user = 'unknown';
  }
  return `${user}@${hostname()} since ${new Date().toISOString()}`;
}

/**
 * Derive the default image tag: `git rev-parse --short HEAD` in `cwd` when it
 * succeeds with a safe value, else a `YYYYMMDDHHmmss` timestamp. The git output
 * is captured (never streamed), so it can be read back.
 */
export async function defaultImageTag(cwd: string): Promise<string> {
  const hash = await gitShortHash(cwd);
  return hash ?? timestampTag();
}

/** Run `git rev-parse --short HEAD` in `cwd`, resolving `undefined` on any failure. */
function gitShortHash(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      const tag = stdout.trim();
      resolve(tag !== '' && !/\s/.test(tag) ? tag : undefined);
    });
  });
}

/** A `YYYYMMDDHHmmss` fallback tag, deterministic per second. */
function timestampTag(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** The real filesystem probe for hook scripts: `existsSync` plus an `X_OK` check. */
export function createHooksFilesystem(): HooksFilesystem {
  return {
    exists: (path) => existsSync(path),
    isExecutable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The default hook runner: spawn the fixed argv with the caller's `cwd` and an
 * environment extended with the hook variables, streaming stdio to the parent.
 */
export function createProcessHookRunner(): HookRunner {
  return (argv, options = {}) =>
    new Promise<CommandResult>((resolve, reject) => {
      const command = argv[0];
      if (command === undefined) {
        reject(new Error('empty hook argv'));
        return;
      }
      const child = spawn(command, argv.slice(1), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        resolve({ exitCode: code ?? (signal === null ? 0 : 1), stdout: '', stderr: '' });
      });
    });
}

/** Reject a container name that cannot be a safe `docker` argv token, value-free. */
function assertContainerName(container: string): void {
  if (typeof container !== 'string' || container.length === 0) {
    throw new DeployExecuteError(
      'invalid_container',
      'the container name must be a non-empty string',
    );
  }
  if (/\s/.test(container) || CONTROL_CHARS.test(container)) {
    throw new DeployExecuteError(
      'invalid_container',
      'the container name must not contain whitespace or control characters',
    );
  }
  if (container.startsWith('-')) {
    throw new DeployExecuteError('invalid_container', 'the container name must not start with "-"');
  }
}

/** The remote `status` argv: list every container on the server. */
export function remoteStatusArgv(): readonly string[] {
  return ['docker', 'ps'];
}

/** Options for {@link remoteLogsArgv}. */
export interface RemoteLogsOptions {
  /** Stream the log instead of printing the current buffer. */
  readonly follow: boolean;
}

/** The remote `logs` argv for a container, with an optional `--follow`. */
export function remoteLogsArgv(container: string, options: RemoteLogsOptions): readonly string[] {
  assertContainerName(container);
  return options.follow ? ['docker', 'logs', '--follow', container] : ['docker', 'logs', container];
}

/** The remote `exec` argv for a container and a fixed command. */
export function remoteExecArgv(container: string, command: readonly string[]): readonly string[] {
  assertContainerName(container);
  return ['docker', 'exec', container, ...command];
}

/** Shared release flow for deploy and rollback, differing only in the failure label. */
async function executeRelease(
  options: DeployExecutionOptions & { readonly kind: 'deploy' | 'rollback' },
): Promise<DeployExecutionResult> {
  const production = options.config.production;
  if (production === undefined) {
    throw new DeployExecuteError('missing_production', 'config.production is required to deploy');
  }
  const plan = planProduction(options.config, {
    imageTag: options.imageTag,
    previousTag: options.previousTag,
    previousContainer: options.previousContainer,
    env: options.env,
    envFilePath: options.envFilePath,
    skipBuild: options.kind === 'rollback',
  });
  // The network and accessory steps (backing services) run first and are the
  // app release's own concern; the app-only plan handed to `executeReleaseSteps`
  // must never carry an `accessory` step, which its executor rejects as an
  // unknown kind.
  const networkSteps = plan.steps.filter((step) => step.kind === 'network');
  const accessorySteps = plan.steps.filter((step) => step.kind === 'accessory');
  const appPlan: ProductionPlan = {
    ...plan,
    steps: plan.steps.filter((step) => step.kind !== 'accessory' && step.kind !== 'network'),
  };
  const server = production.server;
  const logger = options.logger;
  const lock = await acquireLock(options.remoteRunner, {
    server,
    lockDir: deployLockDir(options.config.service),
    owner: options.lockOwner ?? defaultLockOwner(),
  });
  const detachInterrupts = releaseOnInterrupt(lock, options);
  try {
    const hookOptions = {
      server,
      version: options.imageTag,
      fs: options.hooksFs,
      runner: options.hookRunner,
      hooksDir: options.hooksDir,
      cwd: options.cwd,
    };
    await runHookPhase({ ...hookOptions, phase: 'pre-build' });
    await runHookPhase({ ...hookOptions, phase: 'pre-deploy' });
    for (const step of networkSteps) {
      await runNetworkStep(step, options);
    }
    try {
      await runAccessories(accessorySteps, {
        remoteRunner: options.remoteRunner,
        logger,
        sleep: options.sleep,
        env: options.env,
        server,
      });
    } catch (error) {
      if (error instanceof AccessoryError) {
        const message = `${options.kind} failed at accessory step "${error.action}"`;
        throw options.kind === 'rollback'
          ? new RollbackError('step_failed', message)
          : new DeployExecuteError('step_failed', message);
      }
      throw error;
    }
    const summary = await executeReleaseSteps(appPlan, {
      commandRunner: options.commandRunner,
      remoteRunner: options.remoteRunner,
      healthCheck: options.healthCheck,
      logger: options.logger,
      env: options.env,
    });
    if (summary.failedStep !== undefined) {
      const message = `${options.kind} failed at step "${summary.failedStep.kind}"`;
      throw options.kind === 'rollback'
        ? new RollbackError('step_failed', message)
        : new DeployExecuteError('step_failed', message);
    }
    await runHookPhase({ ...hookOptions, phase: 'post-deploy' });
    return {
      summary,
      entry: {
        service: options.config.service,
        tag: options.imageTag,
        timestamp: new Date().toISOString(),
        container: plan.containerName,
      },
    };
  } finally {
    detachInterrupts();
    await releaseOrWarn(lock, options);
  }
}

/**
 * Release the lock, reporting a failure as a warning: a lock left on the
 * server surfaces as contention on the next deploy, never as a failure of
 * this one, and `jamal lock release` clears it.
 */
async function releaseOrWarn(lock: LockHandle, options: DeployExecutionOptions): Promise<void> {
  try {
    await lock.release();
  } catch {
    const message =
      'the deploy lock could not be released; run "jsails jamal lock release" once no deploy is running';
    if (options.logger !== undefined) {
      options.logger.warn(message);
    } else {
      process.stderr.write(`jsails: warning: ${message}\n`);
    }
  }
}

/**
 * While the lock is held, turn SIGINT/SIGTERM into "release the lock, then end
 * the process": a signal's default action would end it before any `finally`
 * runs and leave the lock on the server. Returns the detach function.
 */
function releaseOnInterrupt(lock: LockHandle, options: DeployExecutionOptions): () => void {
  const signals: SignalSource = options.signals ?? process;
  const onInterrupted =
    options.onInterrupted ??
    ((signal: InterruptSignal) => {
      process.kill(process.pid, signal);
    });
  const handlers = new Map<InterruptSignal, () => void>();
  const detach = (): void => {
    for (const [signal, handler] of handlers) {
      signals.removeListener(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      detach();
      void releaseOrWarn(lock, options).then(() => onInterrupted(signal));
    };
    handlers.set(signal, handler);
    signals.once(signal, handler);
  }
  return detach;
}

/** Run the shared-network step; a failure aborts the release value-free. */
async function runNetworkStep(
  step: ProductionPlan['steps'][number],
  options: DeployExecutionOptions & { readonly kind: 'deploy' | 'rollback' },
): Promise<void> {
  options.logger?.info(step.description);
  const argv = step.argv;
  const server = argv?.[1];
  const result =
    argv === undefined || server === undefined
      ? undefined
      : await options.remoteRunner.run(server, argv.slice(2));
  if (result === undefined || result.exitCode !== 0) {
    const message = `${options.kind} failed at step "network"`;
    throw options.kind === 'rollback'
      ? new RollbackError('step_failed', message)
      : new DeployExecuteError('step_failed', message);
  }
}

/**
 * Run a full production deploy for `options.imageTag` (stopping the container
 * at `options.previousTag` when given). Returns the release summary plus the
 * history entry to record; the caller owns writing it.
 */
export function runDeployExecution(
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  return executeRelease({ ...options, kind: 'deploy' });
}

/**
 * Run a production rollback: deploy `options.imageTag` (the prior release) and
 * stop the container at `options.previousTag` (the current release). The flow is
 * identical to a deploy — the caller derives the two tags from deploy history —
 * but a failed step raises a {@link RollbackError}.
 */
export function runRollbackExecution(
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  return executeRelease({ ...options, kind: 'rollback' });
}
