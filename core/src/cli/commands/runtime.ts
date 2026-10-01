/**
 * Runtime commands: `work` (run the job worker) and `schedule` (one-shot
 * schedule registration). Their config module defaults to `jsails.runtime.js`
 * and default-exports a runtime object (registry, Valkey URL, schedules, ...);
 * see `jobs/runtime-config.ts`. The CLI owns SIGINT/SIGTERM only while `work`
 * is running, and never leaks clients or listeners on startup failure.
 */

import { JobsRuntimeImpl, type JobsRuntime, type JobsRuntimeOptions } from '../../jobs/runtime.js';
import {
  loadResolvedRuntimeConfig,
  type ResolvedRuntimeConfig,
} from '../../jobs/runtime-config.js';
import { runExtensions } from '../../extensions/extension.js';

import { waitForShutdownSignal, type ShutdownSignal } from '../shutdown.js';

/**
 * Dependency seam for the runtime commands. Tests inject a fake controller so
 * no live Valkey is contacted; the default builds the neutral runtime
 * from the resolved config's selected adapter (built-in or custom, through the
 * same contract).
 */
export interface RuntimeDeps {
  /** Build the neutral runtime controller for a resolved runtime config. */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Install SIGINT/SIGTERM handlers and resolve on the first signal. */
  waitForShutdown?(): ShutdownSignal;
}

/** The {@link JobsRuntimeImpl} options a resolved runtime config maps to. */
export function jobsRuntimeOptions(config: ResolvedRuntimeConfig): JobsRuntimeOptions {
  return {
    registry: config.registry,
    adapter: config.adapter,
    queueName: config.queueName,
    prefix: config.prefix,
    concurrency: config.concurrency,
    serviceRegistry: config.serviceRegistry,
    overlapMutex: config.overlapMutex,
    jobTimeoutMs: config.jobTimeoutMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    ...(config.failedJobs === undefined ? {} : { failedJobs: config.failedJobs }),
  };
}

/**
 * Close the configured failed-job history after the runtime: the runtime only
 * borrows it, so a lazily connected database history would otherwise keep its
 * pool open after the command returns.
 */
async function closeFailedJobs(config: ResolvedRuntimeConfig): Promise<void> {
  await config.failedJobs?.close?.();
}

const defaultRuntimeDeps: RuntimeDeps = {
  createRuntime: (config) => new JobsRuntimeImpl(jobsRuntimeOptions(config)),
  waitForShutdown: waitForShutdownSignal,
};

/**
 * Reconcile the provider's schedules with the config (`schedule`). An empty
 * list is still sent when the adapter can schedule: the runtime prunes
 * undeclared provider schedules, so deleting the last schedule from config
 * removes it from the queue. An adapter without scheduling is only asked when
 * schedules exist, which surfaces its `unsupported_operation` error instead of
 * hiding it.
 */
async function reconcileSchedules(
  runtime: JobsRuntime,
  config: ResolvedRuntimeConfig,
): Promise<void> {
  if (config.schedules.length > 0 || config.adapter.upsertSchedules !== undefined) {
    await runtime.upsertSchedules(config.schedules);
  }
}

/**
 * Register the configured schedules without pruning (`work`). During a rolling
 * deploy a worker of the previous release can start after the new release ran
 * `jsails schedule`; pruning here would delete every schedule the new release
 * added. Removing a schedule is therefore only done by `jsails schedule`.
 * The upsert still writes this release's definitions, so an old worker that
 * starts mid-rollout can restore or overwrite the new release's schedules until
 * `jsails schedule` runs again after the rollout; release-scoped ownership of
 * schedules is what would close that window.
 */
async function upsertDeclaredSchedules(
  runtime: JobsRuntime,
  config: ResolvedRuntimeConfig,
): Promise<void> {
  if (config.schedules.length > 0) {
    await runtime.upsertSchedules(config.schedules, { prune: false });
  }
}

/**
 * One-shot `schedule`: reconcile the configured schedules, then exit. The
 * runtime is created, used, and closed; no worker or signal handler is
 * involved. An empty schedule list still connects, to prune schedules that
 * were removed from config.
 */
async function runScheduleCommand(configPath: string, deps: RuntimeDeps): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);
  const ext = config.extensions.length > 0 ? await runExtensions(config.extensions) : undefined;
  const runtime = deps.createRuntime({ ...config, serviceRegistry: ext?.services });
  try {
    await reconcileSchedules(runtime, config);
    console.log(
      `Registered ${config.schedules.length} schedule(s) for queue "${config.queueName}".`,
    );
  } finally {
    try {
      await runtime.close();
    } finally {
      await closeFailedJobs(config);
      if (ext !== undefined) {
        await ext.close();
      }
    }
  }
  return 0;
}

/**
 * `work`: register (never prune) any schedules, start the worker, and wait for a shutdown
 * signal. The CLI owns SIGINT/SIGTERM only while `work` is running. Every
 * owned resource (the runtime controller, its producer/worker handles, and the
 * signal listeners) is closed/disposed on both the shutdown path and the
 * startup-failure path.
 */
async function runWorkCommand(configPath: string, deps: RuntimeDeps): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);

  // Build extensions before installing signal listeners so any setup
  // error surfaces immediately, before the worker loop starts.
  const ext = config.extensions.length > 0 ? await runExtensions(config.extensions) : undefined;

  // Install signal listeners before starting the worker so a signal can
  // interrupt the worker's startup connection retries.
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();

  let runtime: JobsRuntime | undefined;
  const errors: unknown[] = [];
  try {
    runtime = deps.createRuntime({ ...config, serviceRegistry: ext?.services });
    await upsertDeclaredSchedules(runtime, config);
    await runtime.startWorker();
    console.log(`Worker started for queue "${config.queueName}". Waiting for shutdown signal.`);
    await signal.promise;
  } finally {
    signal.dispose();
    if (runtime !== undefined) {
      await runtime.close().catch((e) => errors.push(e));
    }
    await closeFailedJobs(config).catch((e) => errors.push(e));
    if (ext !== undefined) {
      await ext.close().catch((e) => errors.push(e));
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
  return 0;
}

/**
 * Dispatch a runtime command (`work` / `schedule`) with the given dependencies.
 * Exported for tests: inject a fake controller to exercise lifecycle, close
 * ordering, and registration without a live Valkey.
 */
export async function runRuntimeCommand(
  command: 'work' | 'schedule',
  configPath: string,
  deps: RuntimeDeps = defaultRuntimeDeps,
): Promise<number> {
  if (command === 'schedule') {
    return runScheduleCommand(configPath, deps);
  }
  return runWorkCommand(configPath, deps);
}
