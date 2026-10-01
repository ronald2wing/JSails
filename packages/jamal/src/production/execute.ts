/**
 * Jamal production deploy/rollback execution.
 *
 * {@link runDeployExecution} and {@link runRollbackExecution} are the one place
 * jamal actually performs a production release. A deploy first prepares the
 * release on the operator's machine, before it touches the server: the
 * Dockerfile and git preflight (`build.ts`; a dirty tree is refused unless
 * `allowDirty`), the release id (`release-id.ts`), the build and push of
 * `<image>:<release id>`, and the registry digest of that push, which is
 * what the server will run. Then, holding the app's deploy lock, both read
 * the ssh user's home, {@link observe} the host, plan from what it holds
 * (`plan.ts`, which reconciles it first), and drive
 * {@link executeReleaseSteps} through the lock's fenced runner, so a run
 * whose lock was force-released cannot start another command on the host.
 *
 * The lock is always released: on success, on failure, and on
 * SIGINT/SIGTERM, which would otherwise end the process before any
 * `finally` runs. A lock that cannot be released is reported as a warning
 * naming `jamal lock release`. A failed step surfaces as a value-free
 * {@link DeployExecuteError} (or {@link RollbackError}) naming only the step
 * kind and the failure's code; the image, server, health URL, and command
 * output are never echoed. Nothing is recorded on the operator's machine:
 * the host's `state.json` and release manifests are the only record.
 *
 * {@link previewDeploy} and {@link previewRollback} are the `--dry-run`
 * plans: the same preflight and a read-only observation, without a build,
 * a push, or the lock. {@link withDeployLock} is the lock lifecycle on its
 * own, which `jamal backup` and `jamal restore` hold too, so a release never
 * swaps containers under a running dump or restore.
 */

import { createRequire } from 'node:module';
import { hostname, userInfo } from 'node:os';

import { Async, CONTROL_CHARS, detach, escalate } from 'jsails/support';
import { JsailsError } from 'jsails/errors';

import type { JamalConfig } from '../config/index.js';
import type { ResolvedEnv } from '../env-resolve.js';
import {
  assertDockerfile,
  BuildError,
  captureDigest,
  readGitState,
  ReleaseSourceErrors,
  runBuild,
  runPush,
  type GitState,
} from './build.js';
import { readHostHome } from './host-home.js';
import { hostLockDir } from './host-layout.js';
import { acquireLock, LockErrors, type LockHandle, type LockOwner } from './lock.js';
import { emptyObservation, observe } from './observe.js';
import {
  DIGEST_PLACEHOLDER,
  planRelease,
  planRollback,
  type PlannedRelease,
  type ProductionPlan,
} from './plan.js';
import { releaseIdFor } from './release-id.js';
import {
  executeReleaseSteps,
  type HealthCheck,
  type ReleaseLogger,
  type ReleaseSummary,
} from './release.js';
import { sha256Hex } from './remote-file.js';
import type { ProcessRunner } from './process-runner.js';
import type { RemoteRunner } from './transport.js';

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

/** The seams a release injects; every one has a real default. */
export interface DeployExecutionOptions {
  readonly config: JamalConfig;
  /** Runs the local build, push, and digest read. */
  readonly commandRunner: ProcessRunner;
  readonly remoteRunner: RemoteRunner;
  /**
   * Replaces the default health probe (run inside the new container over ssh)
   * with a URL check; one call is one bounded attempt.
   */
  readonly healthCheck?: HealthCheck;
  /** The project directory: the build context and the git checkout. */
  readonly cwd?: string;
  readonly logger?: ReleaseLogger;
  /**
   * The resolved env split: `clear` entries become `-e` flags and `secret`
   * entries the release's secrets file.
   */
  readonly env: ResolvedEnv;
  /** Deploy a tree with uncommitted changes, recording it as dirty. */
  readonly allowDirty?: boolean;
  /** Delay seam for the health and accessory retry loops; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The clock a release id and the recorded times are read from. */
  readonly now?: () => Date;
  /** Reads the checkout's commit and dirtiness; defaults to git. */
  readonly readGitState?: (cwd: string) => Promise<GitState>;
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
  /** Who takes the lock; defaults to {@link defaultLockOwner}. */
  readonly lockOwner?: LockOwner;
}

/** The signals that end a deploy early. */
export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/** The slice of `process` the interrupt handling needs. */
export interface SignalSource {
  once(signal: InterruptSignal, listener: () => void): unknown;
  removeListener(signal: InterruptSignal, listener: () => void): unknown;
}

/** The outcome of a successful release: the summary and the plan that ran. */
export interface DeployExecutionResult {
  readonly summary: ReleaseSummary;
  readonly plan: ProductionPlan;
}

/**
 * The deploy lock directory on the remote server for an app, relative to
 * the ssh user's home.
 */
export function deployLockDir(service: string, destination: string | undefined): string {
  return hostLockDir(service, destination);
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

/**
 * The default lock owner: who holds the lock, from where, since when, and,
 * when given, for what (`backup db`), which `jamal lock status` shows.
 */
export function defaultLockOwner(activity?: string, now: Date = new Date()): LockOwner {
  let who = 'unknown';
  try {
    who = userInfo().username;
  } catch {
    // A uid without a passwd entry (some containers) has no username.
    who = 'unknown';
  }
  const owner = { who, host: hostname(), since: now.toISOString() };
  return activity === undefined ? owner : { ...owner, for: activity };
}

/** `who@host`, as a manifest and `state.json` record the operator. */
function operatorOf(owner: LockOwner): string {
  return `${owner.who}@${owner.host}`;
}

/** The version of the jsails package this jamal runs with. */
function jsailsVersion(): string {
  const manifest = createRequire(import.meta.url)('jsails/package.json') as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
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

/** The value-free error a failed release step raises for `kind`. */
function stepFailure(kind: 'deploy' | 'rollback', step: string, detail?: string): Error {
  const message = `${kind} failed at step "${step}"${detail === undefined ? '' : `: ${detail}`}`;
  return kind === 'rollback'
    ? new RollbackError('step_failed', message)
    : new DeployExecuteError('step_failed', message);
}

/** The server of a config that has a production section. */
function productionServer(config: JamalConfig): string {
  const production = config.production;
  if (production === undefined) {
    throw new DeployExecuteError('missing_production', 'config.production is required to deploy');
  }
  return production.server;
}

/** The release a deploy of the checkout in `cwd` would make, before its image exists. */
interface PreparedSource {
  readonly id: string;
  readonly git: GitState;
  readonly at: Date;
}

/** The Dockerfile and git preflight, and the release id it yields. */
async function prepareSource(options: DeployExecutionOptions): Promise<PreparedSource> {
  const cwd = options.cwd ?? process.cwd();
  assertDockerfile(cwd);
  const git = await (options.readGitState ?? readGitState)(cwd);
  if (git.dirty && options.allowDirty !== true) {
    throw new ReleaseSourceErrors.Error('dirty_tree');
  }
  const at = (options.now ?? (() => new Date()))();
  return { id: releaseIdFor(at, git.sha), git, at };
}

/** The release to plan, once its image is `image`. */
function plannedRelease(source: PreparedSource, image: string, env: ResolvedEnv): PlannedRelease {
  return {
    id: source.id,
    image,
    git: source.git,
    secretsSha256: sha256Hex(env.secretsFile),
    secretNames: env.secret.map((entry) => entry.name).sort(),
    jsailsVersion: jsailsVersion(),
  };
}

/** Run the plan's steps under the lock and turn a failed step into the verb's error. */
async function executePlan(
  plan: ProductionPlan,
  lock: LockHandle,
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  const summary = await executeReleaseSteps(plan, {
    remoteRunner: lock.remote,
    healthCheck: options.healthCheck,
    logger: options.logger,
    env: options.env,
    fence: lock.fence,
    sleep: options.sleep,
  });
  if (summary.failedStep !== undefined) {
    // A step failure's message is value-free (an exit code or an error
    // code), and it is the only place an operator learns why the step
    // failed: a missing hasher, a lost lock.
    throw stepFailure(plan.kind, summary.failedStep.kind, summary.failedStep.message);
  }
  return { summary, plan };
}

/** The lock options of a release. */
function releaseLockOptions(options: DeployExecutionOptions, owner: LockOwner): DeployLockOptions {
  return {
    remoteRunner: options.remoteRunner,
    server: productionServer(options.config),
    service: options.config.service,
    destination: options.config.production?.destination,
    owner,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.signals === undefined ? {} : { signals: options.signals }),
    ...(options.onInterrupted === undefined ? {} : { onInterrupted: options.onInterrupted }),
  };
}

/** The local build and push of `ref`; a failure names the step and its exit code. */
async function buildAndPush(ref: string, runner: ProcessRunner): Promise<void> {
  for (const [step, run] of [
    ['build', () => runBuild(ref, runner)],
    ['push', () => runPush(ref, runner)],
  ] as const) {
    try {
      await run();
    } catch (error) {
      if (error instanceof BuildError) throw stepFailure('deploy', step, error.message);
      throw error;
    }
  }
}

/**
 * Run a full production deploy of the checkout in `options.cwd`. Resolves
 * with the release summary and the plan that ran.
 */
export async function runDeployExecution(
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  const { config } = options;
  const server = productionServer(config);
  const source = await prepareSource(options);
  const owner = options.lockOwner ?? defaultLockOwner(undefined, source.at);
  const context = { seq: 0, now: source.at.toISOString(), by: operatorOf(owner), env: options.env };
  // Planned once against an empty host before anything is built, so a config
  // the planner refuses never builds, pushes, or takes the lock.
  planRelease(config, {
    ...context,
    hostHome: '/',
    observed: emptyObservation(),
    preview: true,
    release: plannedRelease(source, `${config.image}@${DIGEST_PLACEHOLDER}`, options.env),
  });
  const ref = `${config.image}:${source.id}`;
  await buildAndPush(ref, options.commandRunner);
  const image = await captureDigest(ref, config.image, options.commandRunner);
  const release = plannedRelease(source, image, options.env);
  return withDeployLock(releaseLockOptions(options, owner), async (lock) => {
    const hostHome = await readHostHome(lock.remote, server);
    const observed = await observe(lock.remote, server, config);
    const plan = planRelease(config, { ...context, seq: lock.seq, hostHome, observed, release });
    return executePlan(plan, lock, options);
  });
}

/**
 * Run a production rollback to the previous release the host records: its
 * image by digest, its own secrets file. A failed step raises a
 * {@link RollbackError}.
 */
export async function runRollbackExecution(
  options: DeployExecutionOptions,
): Promise<DeployExecutionResult> {
  const { config } = options;
  const server = productionServer(config);
  const at = (options.now ?? (() => new Date()))();
  const owner = options.lockOwner ?? defaultLockOwner(undefined, at);
  return withDeployLock(releaseLockOptions(options, owner), async (lock) => {
    const hostHome = await readHostHome(lock.remote, server);
    const observed = await observe(lock.remote, server, config);
    const plan = planRollback(config, {
      seq: lock.seq,
      now: at.toISOString(),
      by: operatorOf(owner),
      env: options.env,
      hostHome,
      observed,
    });
    return executePlan(plan, lock, options);
  });
}

/** The seams a preview reads with; nothing is built and no lock is taken. */
export type PreviewOptions = Omit<
  DeployExecutionOptions,
  'healthCheck' | 'sleep' | 'signals' | 'onInterrupted'
>;

/**
 * The `jamal deploy --dry-run` plan: the preflight, then the host observed
 * read-only, with {@link DIGEST_PLACEHOLDER} for the digest a push would
 * produce. Nothing is built, pushed, or locked, so another run may change
 * the host before a real deploy.
 */
export async function previewDeploy(options: PreviewOptions): Promise<ProductionPlan> {
  const { config } = options;
  const server = productionServer(config);
  const source = await prepareSource(options);
  const owner = options.lockOwner ?? defaultLockOwner(undefined, source.at);
  const hostHome = await readHostHome(options.remoteRunner, server);
  const observed = await observe(options.remoteRunner, server, config);
  return planRelease(config, {
    seq: 0,
    now: source.at.toISOString(),
    by: operatorOf(owner),
    env: options.env,
    hostHome,
    observed,
    preview: true,
    release: plannedRelease(source, `${config.image}@${DIGEST_PLACEHOLDER}`, options.env),
  });
}

/** The `jamal rollback --dry-run` plan, from a read-only observation of the host. */
export async function previewRollback(options: PreviewOptions): Promise<ProductionPlan> {
  const { config } = options;
  const server = productionServer(config);
  const at = (options.now ?? (() => new Date()))();
  const owner = options.lockOwner ?? defaultLockOwner(undefined, at);
  const hostHome = await readHostHome(options.remoteRunner, server);
  const observed = await observe(options.remoteRunner, server, config);
  return planRollback(config, {
    seq: 0,
    now: at.toISOString(),
    by: operatorOf(owner),
    env: options.env,
    hostHome,
    observed,
    preview: true,
  });
}

/** Options for {@link withDeployLock}: the lock's target plus the interrupt seams. */
export interface DeployLockOptions {
  readonly remoteRunner: RemoteRunner;
  readonly server: string;
  /** The app whose deploy lock ({@link deployLockDir}) is held. */
  readonly service: string;
  readonly destination: string | undefined;
  /** Who takes the lock; defaults to {@link defaultLockOwner}. */
  readonly owner?: LockOwner;
  /** Receives the warning when the lock cannot be released; defaults to stderr. */
  readonly logger?: ReleaseLogger;
  /** Where SIGINT/SIGTERM are observed; defaults to `process`. */
  readonly signals?: SignalSource;
  /** Called after the lock was released for an interrupt; defaults to re-raising it. */
  readonly onInterrupted?: (signal: InterruptSignal) => void;
  /**
   * Runs synchronously as soon as an interrupt arrives, before the lock is
   * released: the place to remove local partial state (a half-written file)
   * that the interrupted body can no longer clean up itself.
   */
  readonly onInterrupt?: () => void;
}

/**
 * Run `body` while holding the app's deploy lock, so no deploy, rollback,
 * backup, or restore runs against the server at the same time. `body`
 * sends its commands through the handle's fenced runner. The lock is
 * released when `body` settles and on SIGINT/SIGTERM; a release failure is a
 * warning, never the result.
 */
export async function withDeployLock<T>(
  options: DeployLockOptions,
  body: (lock: LockHandle) => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(options.remoteRunner, {
    server: options.server,
    lockDir: deployLockDir(options.service, options.destination),
    owner: options.owner ?? defaultLockOwner(),
  });
  const detachInterrupts = releaseOnInterrupt(lock, options);
  try {
    return await body(lock);
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
async function releaseOrWarn(
  lock: LockHandle,
  options: Pick<DeployLockOptions, 'logger'>,
): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    // A lock now held under another token belongs to a later run: pointing
    // the operator at a forced release would remove that run's lock.
    const message = LockErrors.is(error, 'not_owner')
      ? error.message
      : 'the deploy lock could not be released; run "jamal lock release" once no deploy is running';
    if (options.logger !== undefined) {
      options.logger.warn(message);
    } else {
      process.stderr.write(`jamal: warning: ${message}\n`);
    }
  }
}

/**
 * While the lock is held, turn SIGINT/SIGTERM into "release the lock, then end
 * the process": a signal's default action would end it before any `finally`
 * runs and leave the lock on the server. Returns the detach function.
 */
function releaseOnInterrupt(lock: LockHandle, options: DeployLockOptions): () => void {
  const signals: SignalSource = options.signals ?? process;
  const onInterrupted =
    options.onInterrupted ??
    ((signal: InterruptSignal) => {
      process.kill(process.pid, signal);
    });
  const handlers = new Map<InterruptSignal, () => void>();
  const removeHandlers = (): void => {
    for (const [signal, handler] of handlers) {
      signals.removeListener(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => {
      removeHandlers();
      options.onInterrupt?.();
      detach(
        releaseOrWarn(lock, options).then(() => onInterrupted(signal)),
        escalate,
      );
    };
    handlers.set(signal, handler);
    signals.once(signal, handler);
  }
  return removeHandlers;
}
