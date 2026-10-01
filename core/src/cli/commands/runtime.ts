/**
 * Runtime commands: `work` (the app's worker role) and `schedule` (one-shot
 * schedule registration).
 *
 * `work` takes the app the dispatcher loaded (`--config`, default
 * `jsails.app.js`), creates the application for the `worker` role and starts
 * its lifecycle units: the job
 * workers its plugins register (`jobsPlugin`'s `jobs.worker`, which registers
 * the declared schedules without pruning and then processes jobs). Nothing
 * listens. The first SIGINT/SIGTERM drains the units under the app's
 * `shutdownTimeoutMs`, a second aborts what is still draining. An app whose
 * worker role has no dedicated unit (one registered for the worker role
 * alone, not also for the web role a serving process runs) fails with
 * `kernel.no_units` before anything starts: a Valkey connection unit, which
 * every role registers, does no work of its own.
 *
 * `schedule` reads the runtime config (`jsails.runtime.js`, see
 * `jobs/runtime-config.ts`) and reconciles the provider's schedules with it,
 * pruning the ones it no longer declares. It opens no plugin: registering
 * schedules runs no job.
 */

import type { Application, CreateApplicationOptions } from '../../app/application.js';
import type { ResolvedAppConfig } from '../../app/config/index.js';
import { JobsRuntimeImpl, type JobsRuntime, type JobsRuntimeOptions } from '../../jobs/runtime.js';
import {
  loadResolvedRuntimeConfig,
  type ResolvedRuntimeConfig,
} from '../../jobs/runtime-config.js';
import { DEFAULT_RUNTIME_CONFIG_PATH } from '../../config-modules.js';
import { KernelStageErrors } from '../../kernel/errors.js';
import type { LoadedApp } from '../../kernel/load-app.js';

import type { CommandModule } from '../descriptor.js';
import type { APP_CONFIG_OPTIONS, RUNTIME_CONFIG_OPTIONS } from '../manifest.js';
import { waitForShutdownSignal, type ShutdownSignal } from '../shutdown.js';
import { prepareConfigModule } from '../stages.js';

/**
 * Dependency seam for the runtime commands. Tests inject fakes so no live
 * Valkey is contacted and no config module is imported; the defaults are the
 * real factories.
 */
export interface RuntimeDeps {
  /** Build the neutral runtime controller for a resolved runtime config (`schedule`). */
  createRuntime(config: ResolvedRuntimeConfig): JobsRuntime;
  /** Create the application `work` starts. */
  createApplication?(
    source: LoadedApp | ResolvedAppConfig,
    options?: CreateApplicationOptions,
  ): Promise<Application>;
  /** Install SIGINT/SIGTERM handlers: the first resolves, the second aborts the drain. */
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
    overlapLeases: config.overlapLeases,
    jobTimeoutMs: config.jobTimeoutMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    ...(config.failedJobs === undefined ? {} : { failedJobs: config.failedJobs }),
  };
}

/**
 * Close what the runtime only borrows, after the runtime: the failed-job
 * history (a lazily connected database history would otherwise keep its pool
 * open) and the built-in adapter's Valkey connections. Both are closed even
 * when one fails; the first failure is rethrown.
 */
async function closeRuntimeResources(config: ResolvedRuntimeConfig): Promise<void> {
  try {
    await config.failedJobs?.close?.();
  } finally {
    await config.valkey?.close();
  }
}

async function createWorkerApplication(
  source: LoadedApp | ResolvedAppConfig,
  options?: CreateApplicationOptions,
): Promise<Application> {
  const { createApplication } = await import('../../app/application.js');
  return createApplication(source, options);
}

const defaultRuntimeDeps: RuntimeDeps = {
  createRuntime: (config) => new JobsRuntimeImpl(jobsRuntimeOptions(config)),
  createApplication: createWorkerApplication,
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
 * One-shot `schedule`: reconcile the configured schedules, then exit. The
 * runtime is created, used, and closed; no worker or signal handler is
 * involved. An empty schedule list still connects, to prune schedules that
 * were removed from config.
 */
export async function runScheduleCommand(
  configPath: string,
  deps: RuntimeDeps = defaultRuntimeDeps,
): Promise<number> {
  const config = await loadResolvedRuntimeConfig(configPath);
  const runtime = deps.createRuntime(config);
  try {
    await reconcileSchedules(runtime, config);
    console.log(
      `Registered ${config.schedules.length} schedule(s) for queue "${config.queueName}".`,
    );
  } finally {
    try {
      await runtime.close();
    } finally {
      await closeRuntimeResources(config);
    }
  }
  return 0;
}

/**
 * `work`: create the application for the worker role, start its units, and
 * wait for a shutdown signal. The signal handlers are installed before the
 * application is created, so a signal during setup or a unit's start (a
 * worker still connecting) leads to a clean shutdown; they stay installed
 * while it drains, so a second signal aborts the drain. The application is
 * closed exactly once on every path.
 */
export async function runWorkCommand(
  source: LoadedApp | ResolvedAppConfig,
  deps: RuntimeDeps = defaultRuntimeDeps,
): Promise<number> {
  const create = deps.createApplication ?? createWorkerApplication;
  const signal = (deps.waitForShutdown ?? waitForShutdownSignal)();
  let app: Application | undefined;
  try {
    app = await create(source, { roles: ['worker'], purpose: 'worker' });
    if (app.dedicatedUnits.length === 0) {
      throw new KernelStageErrors.Error('no_units', { role: 'worker' });
    }
    await app.start();
    console.log(`Worker started (${app.units.join(', ')}). Waiting for shutdown signal.`);
    await signal.promise;
  } finally {
    try {
      await app?.close({ signal: signal.abort });
    } finally {
      signal.dispose();
    }
  }
  return 0;
}

/** `jsails work`. */
export const workCommand: CommandModule<typeof APP_CONFIG_OPTIONS, 'app'> = {
  run: (context) => runWorkCommand(context.app),
};

/** `jsails schedule`. */
export const scheduleCommand: CommandModule<typeof RUNTIME_CONFIG_OPTIONS, 'environment'> = {
  async run(context) {
    return runScheduleCommand(
      await prepareConfigModule(context.cwd, context.values.config ?? DEFAULT_RUNTIME_CONFIG_PATH),
    );
  },
};
