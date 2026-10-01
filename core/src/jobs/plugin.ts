/**
 * First-party `jobs` plugin: a producer-only, lazily-built dispatch surface
 * exposed as a {@link JsailsPlugin} named `jobs`.
 *
 * `jobsPlugin({ registry, adapter?, queueName?, prefix?, concurrency? })` builds
 * a plugin whose `setup` registers a {@link JobsService} under {@link jobsToken}.
 * The service carries a single `dispatch(name, payload, opts?)` method that is
 * resolved against the provided {@link JobRegistry} and, on first use, the
 * underlying {@link JobsRuntime} over the selected transport:
 *
 * - with an explicit `adapter`, that neutral {@link JobsRuntimeAdapter} is used
 *   verbatim (identity preserved) and no Valkey/Redis URL is read or validated;
 * - without an `adapter`, the built-in BullMQ adapter is used, resolving the
 *   connection URL lazily from `VALKEY_URL` (a missing URL fails
 *   the first dispatch with a value-free {@link RuntimeConfigError}).
 *
 * Construction is fully lazy: nothing connects and no handle is created at
 * import, plugin construction, or `setup` — the runtime (and, in the built-in
 * path, the adapter) is created on the first `dispatch` and reused thereafter.
 * The cleanup closes the runtime (which closes the worker then producer,
 * idempotently) and is a no-op when dispatch was never called.
 *
 * This is the dispatch side only: it never starts a worker. A worker is started
 * separately (e.g. via the `jsails work` CLI), so this plugin is safe to mount
 * in a web process that only enqueues jobs.
 */

import { resolve } from 'node:path';

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import { signalsToken } from '../signals/index.js';
import { BullMQAdapter } from './bullmq-adapter.js';
import { validateJobsDashboardSource, type JobsDashboardSource } from './dashboard-source.js';
import type { JobRegistry } from './registry.js';
import { loadJobRegistryFromDirectory } from './discovery.js';
import { JobsRuntimeImpl, type JobsRuntimeAdapter, type JobsRuntime } from './runtime.js';
import { resolveRuntimeValkeyUrl } from './runtime-config.js';

/** The service the `jobs` plugin provides: a producer-only dispatch surface. */
export interface JobsService {
  /** Validate and enqueue a job named in the registry. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
}

/**
 * Opaque token for the {@link JobsService}. Defined once here and shared by the
 * provider (`jobsPlugin`) and any consumer (e.g. an extension's `requires`).
 */
export const jobsToken: ServiceToken<JobsService> = createServiceToken<JobsService>('jobs');

/** Options accepted by {@link jobsPlugin}. */
export interface JobsPluginOptions {
  /** Explicit registry. Omit to autoload `*.job.js` modules from `jobsDir`. */
  readonly registry?: JobRegistry;
  /** Job module directory. Defaults to `dist/jobs`. */
  readonly jobsDir?: string;
  /**
   * Optional neutral transport adapter. When present it is used as-is and no
   * Valkey/Redis URL is read or validated. When absent, the built-in BullMQ
   * adapter is used, resolving `VALKEY_URL` lazily on first use.
   */
  readonly adapter?: JobsRuntimeAdapter;
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Key prefix. Defaults to `"bull"`. */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1 (unused by the dispatch-only service). */
  readonly concurrency?: number;
  /**
   * Optional worker-owned read surface consumed by the jobs admin dashboard.
   *
   * Metrics and the failed-job store are accumulated in the *worker* process, so
   * there is no process-global registry this dispatch plugin can read them from.
   * When the application wires a dashboard, it passes the same
   * {@link JobsDashboardSource} here (validated eagerly, fail-closed at boot) and
   * to `jobsDashboard(source)` in `jsails/jobs` for the admin read surface. The
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

  const resolveAdapter = (): JobsRuntimeAdapter =>
    options.adapter ?? new BullMQAdapter({ redisUrl: resolveRuntimeValkeyUrl({}) });

  return definePlugin({
    name: 'jobs',
    describe: () => ({ needsLive: true }),
    setup({ services }) {
      let runtime: JobsRuntime | undefined;
      let registryPromise: Promise<JobRegistry> | undefined;

      function resolveRegistry(): Promise<JobRegistry> {
        if (options.registry !== undefined) {
          return Promise.resolve(options.registry);
        }
        registryPromise ??= loadJobRegistryFromDirectory(resolve(options.jobsDir ?? 'dist/jobs'));
        return registryPromise;
      }

      async function ensureRuntime(): Promise<JobsRuntime> {
        if (runtime === undefined) {
          const registry = await resolveRegistry();
          runtime = new JobsRuntimeImpl({
            registry,
            adapter: resolveAdapter(),
            queueName: options.queueName,
            prefix: options.prefix,
            concurrency: options.concurrency,
            // Emit the job lifecycle events (pushed/completed/failed/retried) on
            // the shared signals bus when the `signals` plugin is present — a
            // web process that only dispatches still publishes `jobPushed`.
            signals: services.tryGet(signalsToken),
          });
        }
        return runtime;
      }

      services.provide(jobsToken, {
        dispatch: async (name, payload, opts) =>
          (await ensureRuntime()).dispatch(name, payload, opts),
      });

      return () => (runtime === undefined ? Promise.resolve() : runtime.close());
    },
  });
}
