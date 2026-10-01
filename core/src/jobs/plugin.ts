/**
 * First-party `jobs` plugin: the dispatch surface and the worker of the old
 * jobs runtime, as a {@link JsailsPlugin} named `jobs`.
 *
 * `jobsPlugin({ registry, adapter?, queueName?, prefix?, concurrency?, ... })`
 * builds a plugin whose `setup` registers a {@link JobsService} under
 * {@link jobsToken} and two lifecycle units on the `jobs` transport:
 *
 * - `jobs.producer` (web and worker roles): the dispatch side. The service's
 *   `dispatch(name, payload, opts?)` is resolved against the
 *   {@link JobRegistry} and, on first use, a {@link JobsRuntime} over the
 *   selected transport. Draining the unit closes that runtime, after the HTTP
 *   server stopped taking requests that could dispatch.
 * - `jobs.worker` (worker role, after the producer): the old runtime's worker
 *   wrapped as one unit. Starting it builds a runtime over the same adapter
 *   instance, registers the declared `schedules` (else the app root's
 *   `jsails.schedules.json`; never pruning: removing a schedule is `jsails
 *   schedule`'s job) and starts processing; draining it
 *   lets in-flight jobs finish within `shutdownTimeoutMs`; aborting it puts
 *   them back in their queue.
 *
 * The transport is chosen once per setup:
 *
 * - with an explicit `adapter`, that neutral {@link JobsRuntimeAdapter} is
 *   used verbatim (identity preserved) and no Valkey URL is read or validated;
 * - without an `adapter`, the built-in BullMQ adapter is used over the app's
 *   Valkey connections (`valkeyToken`, or one created from `VALKEY_URL`); an
 *   app with neither fails the first dispatch, or the worker's start, with a
 *   value-free {@link RuntimeConfigError}.
 *
 * Every process that runs the worker role starts `jobs.worker`: `jsails
 * work`, `jsails serve --with worker`, `jsails dev`, and an application
 * created without `roles` (both roles, one process doing everything). A
 * process that should only dispatch runs the web role alone.
 *
 * Both units declare the adapter's `reach`: over the in-memory adapter
 * (`process`) the kernel refuses a process that runs only the web or only the
 * worker role, because a job dispatched there would never reach a worker;
 * `jsails serve --with worker` runs both. A custom adapter that declares no
 * reach is not checked.
 *
 * Setup connects nothing: the dispatch runtime is created on the first
 * `dispatch` (concurrent first dispatches share one) and the worker's on its
 * start. The cleanup closes both, idempotently, and releases a Valkey provider
 * the plugin created.
 */

import { resolve } from 'node:path';

import { isLeaseStore, type LeaseStore } from '../cache/lease.js';
import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { jobsToken, type JobsService } from '../contracts/jobs-service.js';
import type { LifecycleRegisterOptions } from '../plugins/contract/lifecycle.js';
import { signalsToken } from '../signals/index.js';
import { useValkeyConnections, type ValkeyConnectionsUse } from '../valkey/provider.js';
import { BullMQAdapter } from './bullmq-adapter.js';
import { defaultQueuePrefix } from './connection.js';
import { validateJobsDashboardSource, type JobsDashboardSource } from './dashboard-source.js';
import type { JobRegistry } from './registry.js';
import { loadJobRegistryFromDirectory } from './discovery.js';
import { isFailedJobHistory, type FailedJobHistory } from './failed-job-history.js';
import { MAX_JOB_TIMEOUT_MS } from './registry.js';
import { JobsRuntimeImpl, type JobsRuntimeAdapter, type JobsRuntime } from './runtime.js';
import { readConventionalSchedules, RuntimeConfigError } from './runtime-config.js';
import { validateJobRetention, type JobRetention } from './queue.js';
import type { ScheduleDefinition } from './scheduler.js';

export { jobsToken, type JobsService };

/** Options accepted by {@link jobsPlugin}. */
export interface JobsPluginOptions {
  /** Explicit registry. Omit to autoload `*.job.js` modules from `jobsDir`. */
  readonly registry?: JobRegistry;
  /**
   * Job module directory, relative to the app root (`ExtensionContext.rootDir`)
   * unless absolute. Defaults to `dist/jobs`.
   */
  readonly jobsDir?: string;
  /**
   * Optional neutral transport adapter. When present it is used as-is and no
   * Valkey connection is used. When absent, the built-in BullMQ adapter runs
   * over the app's Valkey connections.
   */
  readonly adapter?: JobsRuntimeAdapter;
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /**
   * Key prefix. Defaults to `<package.json name>:<NODE_ENV>`
   * ({@link defaultQueuePrefix}) of the app root. The producer and the worker
   * both come from this plugin, so they meet on one queue whatever it is; the
   * inspection commands that read `jsails.runtime.js` (`jsails queue`,
   * `schedule`, `queue:failed`) need the same prefix there. It does not follow
   * a `valkeyPlugin({ appPrefix })`.
   */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1. */
  readonly concurrency?: number;
  /**
   * Schedules the worker registers when it starts (never pruning). Defaults to
   * the conventional `jsails.schedules.json` in the app root, read when the
   * worker starts, or none.
   */
  readonly schedules?: readonly ScheduleDefinition[];
  /**
   * A lease store the worker uses to enforce a schedule's `overlap`. The
   * caller owns it; the plugin never closes it.
   */
  readonly overlapLeases?: LeaseStore;
  /**
   * Where the worker records finally failed jobs (read by `jsails
   * queue:failed`). The caller owns it; the plugin never closes it.
   */
  readonly failedJobs?: FailedJobHistory;
  /** The worker's default per-attempt timeout (ms) for jobs that declare none. */
  readonly jobTimeoutMs?: number;
  /**
   * How long the worker's drain lets in-flight jobs finish (ms). Defaults to
   * 30 s; the application's `shutdownTimeoutMs` still bounds the whole
   * shutdown.
   */
  readonly shutdownTimeoutMs?: number;
  /**
   * Completed-job retention for the built-in BullMQ adapter (ignored with a
   * custom `adapter`). Defaults to one hour / 1000 jobs.
   */
  readonly removeOnComplete?: JobRetention;
  /**
   * Failed-job retention for the built-in BullMQ adapter (ignored with a
   * custom `adapter`). Defaults to seven days / 5000 jobs.
   */
  readonly removeOnFail?: JobRetention;
  /**
   * Optional worker-owned read surface consumed by the jobs admin dashboard.
   *
   * Metrics and the failed-job store are accumulated in the *worker* process, so
   * there is no process-global registry this dispatch plugin can read them from.
   * When the application wires a dashboard, it passes the same
   * {@link JobsDashboardSource} here (validated eagerly, fail-closed at boot) and
   * to `jobsAdmin(source)` from `@jsails/admin` for the admin read surface. The
   * plugin itself never reads metrics or starts a worker — this option only
   * declares and validates the shared source so a miswired store fails as early
   * as possible.
   */
  readonly dashboard?: JobsDashboardSource;
}

/**
 * Build the first-party `jobs` plugin. The returned plugin is inert: nothing is
 * constructed or connected until the first `dispatch` through the service.
 */
export function jobsPlugin(options: JobsPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('jobsPlugin requires an options object');
  }
  if (
    options.registry !== undefined &&
    (options.registry === null || typeof options.registry !== 'object')
  ) {
    throw new TypeError('jobsPlugin requires a job registry');
  }
  if (
    options.jobsDir !== undefined &&
    (typeof options.jobsDir !== 'string' || options.jobsDir.trim() === '')
  ) {
    throw new TypeError('jobsPlugin jobsDir must be a non-empty string');
  }
  if (options.dashboard !== undefined) {
    validateJobsDashboardSource(options.dashboard);
  }

  if (options.schedules !== undefined && !Array.isArray(options.schedules)) {
    throw new TypeError('jobsPlugin schedules must be an array of schedule definitions');
  }
  if (options.overlapLeases !== undefined && !isLeaseStore(options.overlapLeases)) {
    throw new TypeError('jobsPlugin overlapLeases must implement acquire/renew/release/close');
  }
  if (options.failedJobs !== undefined && !isFailedJobHistory(options.failedJobs)) {
    throw new TypeError('jobsPlugin failedJobs must implement record/list/get/remove/clear');
  }
  checkMilliseconds(options.jobTimeoutMs, 'jobTimeoutMs', 1);
  checkMilliseconds(options.shutdownTimeoutMs, 'shutdownTimeoutMs', 0);

  const removeOnComplete =
    options.removeOnComplete === undefined
      ? undefined
      : validateJobRetention(options.removeOnComplete, 'removeOnComplete');
  const removeOnFail =
    options.removeOnFail === undefined
      ? undefined
      : validateJobRetention(options.removeOnFail, 'removeOnFail');

  const resolveAdapter = (valkey: ValkeyConnectionsUse | undefined): JobsRuntimeAdapter => {
    if (options.adapter !== undefined) return options.adapter;
    if (valkey === undefined) {
      throw new RuntimeConfigError(
        'missing_connection_url',
        'no Valkey connections: add the valkey plugin or set VALKEY_URL in the environment',
      );
    }
    return new BullMQAdapter({
      connections: valkey.connections,
      ...(removeOnComplete !== undefined ? { removeOnComplete } : {}),
      ...(removeOnFail !== undefined ? { removeOnFail } : {}),
    });
  };

  return definePlugin({
    name: 'jobs',
    describe: () => ({ needsLive: true }),
    setup({ services, rootDir, mode, lifecycle }) {
      const valkey =
        options.adapter === undefined
          ? useValkeyConnections({ services, rootDir, mode })
          : undefined;
      // One adapter for both sides: the in-memory adapter carries jobs only
      // between runtimes built on the same instance.
      let adapter: JobsRuntimeAdapter | undefined;
      const sharedAdapter = (): JobsRuntimeAdapter => (adapter ??= resolveAdapter(valkey));
      let registryPromise: Promise<JobRegistry> | undefined;
      const resolveRegistry = (): Promise<JobRegistry> => {
        if (options.registry !== undefined) return Promise.resolve(options.registry);
        registryPromise ??= loadJobRegistryFromDirectory(
          resolve(rootDir, options.jobsDir ?? 'dist/jobs'),
        );
        return registryPromise;
      };
      const prefix = options.prefix ?? defaultQueuePrefix(rootDir, { NODE_ENV: mode });
      // Emit the job lifecycle events (pushed/completed/failed/retried) on the
      // shared signals bus when the `signals` plugin is present: a web process
      // that only dispatches still publishes `jobPushed`.
      const signals = services.tryGet(signalsToken);

      // The pending runtime, not the built one, is memoized: two dispatches
      // arriving before construction finishes must share a single runtime, or
      // the first one's connection would leak past teardown.
      let producer: Promise<JobsRuntime> | undefined;
      const ensureProducer = (): Promise<JobsRuntime> => {
        if (producer === undefined) {
          const pending = resolveRegistry().then(
            (registry) =>
              new JobsRuntimeImpl({
                registry,
                adapter: sharedAdapter(),
                queueName: options.queueName,
                prefix,
                concurrency: options.concurrency,
                signals,
              }),
          );
          producer = pending;
          // A failed construction (a missing URL, a bad registry) must not
          // wedge the service: clear it so a later dispatch retries.
          pending.catch(() => {
            if (producer === pending) producer = undefined;
          });
        }
        return producer;
      };

      let worker: JobsRuntime | undefined;
      const startWorker = async (): Promise<void> => {
        const runtime = new JobsRuntimeImpl({
          registry: await resolveRegistry(),
          adapter: sharedAdapter(),
          queueName: options.queueName,
          prefix,
          concurrency: options.concurrency,
          signals,
          serviceRegistry: services,
          ...(options.overlapLeases === undefined ? {} : { overlapLeases: options.overlapLeases }),
          ...(options.failedJobs === undefined ? {} : { failedJobs: options.failedJobs }),
          ...(options.jobTimeoutMs === undefined ? {} : { jobTimeoutMs: options.jobTimeoutMs }),
          ...(options.shutdownTimeoutMs === undefined
            ? {}
            : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
        });
        worker = runtime;
        const schedules =
          options.schedules ??
          ((readConventionalSchedules(rootDir) ?? []) as readonly ScheduleDefinition[]);
        if (schedules.length > 0) {
          await runtime.upsertSchedules(schedules, { prune: false });
        }
        await runtime.startWorker();
      };

      services.provide(jobsToken, {
        dispatch: async (name, payload, opts) =>
          (await ensureProducer()).dispatch(name, payload, opts),
      });

      const reach = options.adapter === undefined ? 'shared' : options.adapter.reach;
      const transport: LifecycleRegisterOptions =
        reach === undefined ? {} : { transport: { name: 'jobs', reach } };
      lifecycle.register(
        ['web', 'worker'],
        {
          name: 'jobs.producer',
          start: () => undefined,
          drain: () => closeRuntime(producer),
          abort: () => abortRuntime(producer),
        },
        transport,
      );
      lifecycle.register(
        ['worker'],
        {
          name: 'jobs.worker',
          start: startWorker,
          drain: () => worker?.close(),
          abort: () => worker?.abort(),
        },
        { ...transport, after: ['jobs.producer'] },
      );

      return async () => {
        try {
          await worker?.close();
          await closeRuntime(producer);
        } finally {
          await valkey?.release();
        }
      };
    },
  });
}

/** Refuse a millisecond option outside `[min, MAX_JOB_TIMEOUT_MS]`. */
function checkMilliseconds(value: number | undefined, label: string, min: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < min || value > MAX_JOB_TIMEOUT_MS) {
    throw new TypeError(
      `jobsPlugin ${label} must be an integer between ${min} and ${MAX_JOB_TIMEOUT_MS}`,
    );
  }
}

/** The runtime a dispatch built, or `undefined` when none was (or its construction failed). */
async function builtRuntime(
  pending: Promise<JobsRuntime> | undefined,
): Promise<JobsRuntime | undefined> {
  if (pending === undefined) return undefined;
  try {
    return await pending;
  } catch {
    // Construction failed: there is no runtime to close.
    return undefined;
  }
}

/** Close the runtime a dispatch built, if one was built. */
async function closeRuntime(pending: Promise<JobsRuntime> | undefined): Promise<void> {
  await (await builtRuntime(pending))?.close();
}

/** Abort the runtime a dispatch built, if one was built. */
async function abortRuntime(pending: Promise<JobsRuntime> | undefined): Promise<void> {
  await (await builtRuntime(pending))?.abort();
}
