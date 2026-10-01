/**
 * Runtime configuration for the jobs CLI (`work` / `schedule`).
 *
 * The runtime config is a plain ESM module (`.js` or `.mjs`) that
 * default-exports an object describing the job registry, the Valkey
 * connection (or a custom adapter), and optional schedules:
 *
 *     export default {
 *       registry: createJobRegistry({ ... }),
 *       valkeyUrl: 'redis://...',
 *       schedules: [{ id, job, cron }],
 *       queueName: 'default',
 *       prefix: 'my-app:production', // default: <package.json name>:<NODE_ENV>
 *       concurrency: 1,
 *       // optional: finished-job retention for the built-in adapter
 *       removeOnComplete: { age: 3600, count: 1000 },
 *       removeOnFail: { age: 604800, count: 5000 },
 *       // optional: per-attempt timeout default and the shutdown drain deadline
 *       jobTimeoutMs: 600_000,
 *       shutdownTimeoutMs: 30_000,
 *       // optional: automatic schedule overlap (caller-owned)
 *       overlapMutex: new ValkeyMutexStore({ valkeyUrl: 'redis://...' }),
 *       // optional: record finally failed jobs (read by `jsails queue:failed`)
 *       failedJobs: createDatabaseFailedJobHistory({ getDataSource: () => dataSource }),
 *       // alternative to valkeyUrl: a custom JobsRuntimeAdapter (no URL needed)
 *       adapter: { name, createProducer, createWorker, upsertSchedules? },
 *     };
 *
 * `valkeyUrl` is the config key and `VALKEY_URL` the environment variable; the
 * config value wins, and the single resolved `redis://`/`rediss://` URL is
 * handed to the built-in BullMQ adapter. URL validation is explicit about the scheme and never echoes the
 * value (a URL may embed a password).
 *
 * When `adapter` is supplied, it is selected verbatim: the custom adapter owns
 * its transport, so no Valkey URL is required, read, or validated, and
 * the built-in BullMQ adapter is never constructed. A malformed adapter
 * (missing non-empty `name`, `createProducer`, or `createWorker`, or a
 * non-function `upsertSchedules`) is rejected without invoking any factory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { isMutexStore, type MutexStore } from '../cache/mutex.js';
import { formatError } from '../errors/inspect.js';
import { isTypeScriptConfig } from '../config-modules.js';
import { BullMQAdapter } from './bullmq-adapter.js';
import { DEFAULT_QUEUE_NAME, defaultQueuePrefix } from './connection.js';
import type { JsailsExtension } from '../extensions/extension.js';
import {
  createJobRegistry,
  MAX_JOB_TIMEOUT_MS,
  type JobDefinition,
  type JobRegistry,
} from './registry.js';
import { validateJobRetention, type JobRetention } from './queue.js';
import { loadJobRegistryFromDirectory } from './discovery.js';
import {
  validateConcurrency,
  validateJobsRuntimeAdapter,
  type JobsRuntimeAdapter,
} from './runtime.js';
import type { ScheduleDefinition } from './scheduler.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { validateExtensionEntries } from '../extensions/validation.js';
import { isFailedJobHistory, type FailedJobHistory } from './failed-job-history.js';
import { assertConnectionUrl } from '../valkey/connection.js';
import { JsailsError } from '../errors/jsails-error.js';
import { importFile } from '../support/project-paths.server.js';

export { DEFAULT_RUNTIME_CONFIG_PATH } from '../config-modules.js';

/** Conventional schedule file auto-loaded next to the runtime config. */
export const DEFAULT_SCHEDULES_PATH = 'jsails.schedules.json';

/** Stable failure code carried by {@link RuntimeConfigError}. */
export type RuntimeConfigErrorCode =
  | 'unsupported_config'
  | 'load_failed'
  | 'invalid_config'
  | 'unparseable'
  | 'missing_connection_url';

/** Raised for any invalid runtime config or connection URL. */
export class RuntimeConfigError extends JsailsError {
  constructor(
    readonly code: RuntimeConfigErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The shape a runtime config module default-exports. */
export interface RuntimeConfig {
  /**
   * Job name -> class/object definition. Omit to autoload `*.job.js` modules
   * from `jobsDir` (compiled `.js`/`.mjs`; no directory scan beyond it).
   */
  readonly registry?: JobRegistry;
  /** Job module directory. Defaults to `dist/jobs` relative to the config. */
  readonly jobsDir?: string;
  /**
   * Optional custom job runtime adapter. When present, it is used as-is (its
   * identity is preserved) and no Valkey URL is required, read, or
   * validated. When absent, the built-in BullMQ adapter is constructed from the
   * resolved Valkey URL.
   */
  readonly adapter?: JobsRuntimeAdapter;
  /** Valkey URL. */
  readonly valkeyUrl?: string;
  /** Schedules to register. Defaults to `[]`. */
  readonly schedules?: readonly ScheduleDefinition[];
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /**
   * Valkey key prefix. Defaults to `<package.json name>:<NODE_ENV>`
   * ({@link defaultQueuePrefix}), so two apps or environments sharing a
   * Valkey never consume each other's jobs.
   */
  readonly prefix?: string;
  /** Worker concurrency. Defaults to 1. */
  readonly concurrency?: number;
  /** Extensions to run (via `runExtensions`) before processing jobs. Defaults to `[]`. */
  readonly extensions?: readonly JsailsExtension[];
  /**
   * Optional mutex store used to enforce scheduled-job overlap automatically.
   * The caller owns the store; the runtime never closes it.
   */
  readonly overlapMutex?: MutexStore;
  /** Completed-job retention for the built-in adapter. Defaults to 1 h / 1000 jobs. */
  readonly removeOnComplete?: JobRetention;
  /** Failed-job retention for the built-in adapter. Defaults to 7 days / 5000 jobs. */
  readonly removeOnFail?: JobRetention;
  /** Default per-attempt timeout (ms) for jobs that declare none. No default. */
  readonly jobTimeoutMs?: number;
  /** How long `work` lets in-flight jobs drain on shutdown (ms). Defaults to 30 s. */
  readonly shutdownTimeoutMs?: number;
  /**
   * Where finally failed jobs are recorded and where `jsails queue:failed`,
   * `queue:retry`, and `queue:forget` read them. Absent means no history is
   * kept. Use the database history for anything the CLI should see: a memory
   * history lives only inside the process that built it.
   */
  readonly failedJobs?: FailedJobHistory;
}

/** A fully validated runtime config with the selected adapter bound. */
export interface ResolvedRuntimeConfig {
  readonly registry: JobRegistry;
  /**
   * The adapter the runtime must run against: the custom `config.adapter` when
   * provided (identity preserved), otherwise the built-in BullMQ adapter built
   * from the resolved URL. The CLI drives this adapter through the same neutral
   * job-runtime contract, not a separate built-in path.
   */
  readonly adapter: JobsRuntimeAdapter;
  /**
   * The resolved `redis://`/`rediss://` URL. Present only when the built-in BullMQ adapter was selected; absent (`undefined`) for a custom adapter.
   * Absent (`undefined`) when a custom adapter was supplied: that adapter owns
   * its transport and needs no URL.
   */
  readonly valkeyUrl?: string;
  readonly schedules: readonly ScheduleDefinition[];
  readonly queueName: string;
  readonly prefix: string;
  readonly concurrency: number;
  /** Extensions declared in the runtime config. Defaults to `[]`. */
  readonly extensions: readonly JsailsExtension[];
  /** Optional automatic-overlap mutex store. Caller-owned. */
  readonly overlapMutex?: MutexStore;
  /** Default per-attempt timeout (ms), when configured. */
  readonly jobTimeoutMs?: number;
  /** Shutdown drain deadline (ms), when configured. */
  readonly shutdownTimeoutMs?: number;
  /** The failed-job history, when configured. Caller-owned. */
  readonly failedJobs?: FailedJobHistory;
  /**
   * The ambient service registry built from `extensions`, when any are
   * declared. Populated by the CLI (never by `validateRuntimeConfig`), which
   * runs `runExtensions` and passes the result through. `undefined` means no
   * scope is opened around job handlers.
   */
  readonly serviceRegistry?: ServiceRegistry;
}

/**
 * Import the runtime config module and return its default export. Rejects
 * TypeScript paths (compile first) and wraps import failures without echoing
 * module internals beyond the author's own error message.
 */
export async function loadRuntimeConfigModule(configPath: string): Promise<unknown> {
  const absolute = resolve(configPath);
  if (isTypeScriptConfig(absolute)) {
    throw new RuntimeConfigError(
      'unsupported_config',
      `config "${configPath}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point --config at the compiled output`,
    );
  }
  let module: unknown;
  try {
    module = await importFile(absolute);
  } catch (error) {
    throw new RuntimeConfigError(
      'load_failed',
      `failed to load runtime config "${configPath}": ${formatError(error)}`,
    );
  }
  return (module as { default?: unknown }).default;
}

/**
 * Load the runtime config and, when it omits `schedules`, auto-load the
 * conventional `jsails.schedules.json` next to it. Schedules are pure data, so
 * the file is plain JSON — no module import, no code execution. An explicit
 * `schedules` array always wins; there is no directory scan and no second
 * convention.
 */
export async function loadResolvedRuntimeConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedRuntimeConfig> {
  const raw = await loadRuntimeConfigModule(configPath);
  const withSchedules = await loadConventionalSchedules(raw, configPath);
  const withJobs = await loadConventionalJobs(withSchedules, configPath);
  return validateRuntimeConfig(withJobs, env, dirname(resolve(configPath)));
}

async function loadConventionalJobs(raw: unknown, configPath: string): Promise<unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const config = raw as Record<string, unknown>;
  if (config.registry !== undefined) {
    return raw;
  }
  const rawJobsDir = config.jobsDir;
  if (rawJobsDir !== undefined && (typeof rawJobsDir !== 'string' || rawJobsDir.trim() === '')) {
    throw new RuntimeConfigError('invalid_config', 'config.jobsDir must be a non-empty string');
  }
  const jobsDir = resolve(
    dirname(resolve(configPath)),
    typeof rawJobsDir === 'string' ? rawJobsDir : 'dist/jobs',
  );
  const registry = await loadJobRegistryFromDirectory(jobsDir);
  return { ...config, registry };
}

async function loadConventionalSchedules(raw: unknown, configPath: string): Promise<unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const config = raw as Record<string, unknown>;
  if (config.schedules !== undefined) {
    return raw;
  }
  const schedulesPath = join(dirname(resolve(configPath)), DEFAULT_SCHEDULES_PATH);
  if (!existsSync(schedulesPath)) {
    return raw;
  }
  let schedules: unknown;
  try {
    schedules = JSON.parse(readFileSync(schedulesPath, 'utf8')) as unknown;
  } catch {
    throw new RuntimeConfigError('unparseable', `${DEFAULT_SCHEDULES_PATH} is not valid JSON`);
  }
  if (!Array.isArray(schedules)) {
    throw new RuntimeConfigError(
      'invalid_config',
      `${DEFAULT_SCHEDULES_PATH} must contain a JSON array of schedule definitions`,
    );
  }
  return { ...config, schedules };
}

/**
 * Validate a connection URL is an explicit `redis://` or `rediss://` URL. The
 * value is never included in the error message: a URL may embed a password.
 */
export function assertRedisUrl(value: unknown): string {
  return assertConnectionUrl(value, (message) => new RuntimeConfigError('invalid_config', message));
}

/**
 * Resolve the connection URL with the documented precedence:
 * `config.valkeyUrl` -> `env.VALKEY_URL`.
 * The resolved value is validated as an explicit `redis://`/`rediss://` URL.
 */
export function resolveRuntimeValkeyUrl(
  config: { valkeyUrl?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = config.valkeyUrl ?? env.VALKEY_URL;
  if (candidate === undefined || candidate === null) {
    throw new RuntimeConfigError(
      'missing_connection_url',
      'no Valkey URL configured: set `valkeyUrl` in the runtime config, or set ' +
        'VALKEY_URL in the environment',
    );
  }
  return assertRedisUrl(candidate);
}

/** Validate the registry shape without executing any job handler. */
function validateRegistry(value: unknown): JobRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeConfigError(
      'invalid_config',
      'config.registry must be an object mapping job names to { schema, handler }',
    );
  }
  // createJobRegistry checks that every entry has a schema and a function handler;
  // it never invokes a handler.
  return createJobRegistry(value as Record<string, JobDefinition>);
}

function validateString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '') {
    throw new RuntimeConfigError('invalid_config', `${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate a user-supplied adapter's shape (non-empty `name`, `createProducer`,
 * `createWorker`, optional `upsertSchedules`) without invoking any factory, and
 * return it unchanged so its identity is preserved. Reuses the runtime's own
 * contract check so config validation and {@link JobsRuntimeImpl} never disagree;
 * its value-free messages are wrapped in a `RuntimeConfigError`.
 */
function validateAdapter(value: unknown): JobsRuntimeAdapter {
  try {
    validateJobsRuntimeAdapter(value);
  } catch (error) {
    throw new RuntimeConfigError(
      'invalid_config',
      `config.adapter is invalid: ${formatError(error)}`,
    );
  }
  return value;
}

/** Validate the optional automatic-overlap store without touching it. */
function validateOverlapMutex(value: unknown): MutexStore | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMutexStore(value)) {
    throw new RuntimeConfigError(
      'invalid_config',
      'config.overlapMutex must implement acquire/release/close',
    );
  }
  return value;
}

/**
 * Validate the runtime config default export: the registry structure (without
 * executing handlers), the selected adapter, and the queue/prefix/concurrency/
 * schedules shape. With a custom `adapter` no URL is required or read; without
 * one, the URL is resolved (valkeyUrl -> env) and the built-in
 * BullMQ adapter is constructed from it (lazily — no connection yet).
 * Schedules are checked to be an array here; the per-schedule validation
 * (known jobs, exclusivity, payload) is left to `upsertSchedules`, which
 * validates the whole list before any registration. `rootDir` is where the
 * default prefix's app name is looked up (the nearest `package.json` at or
 * above it); the loader passes the config file's directory.
 */
export function validateRuntimeConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = process.cwd(),
): ResolvedRuntimeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeConfigError(
      'invalid_config',
      'the runtime config must default-export an object',
    );
  }
  const config = raw as Record<string, unknown>;

  const registry = validateRegistry(config.registry);

  const removeOnComplete = validateRetention(config.removeOnComplete, 'removeOnComplete');
  const removeOnFail = validateRetention(config.removeOnFail, 'removeOnFail');

  let adapter: JobsRuntimeAdapter;
  let valkeyUrl: string | undefined;
  if (config.adapter !== undefined) {
    adapter = validateAdapter(config.adapter);
    valkeyUrl = undefined;
  } else {
    valkeyUrl = resolveRuntimeValkeyUrl({ valkeyUrl: config.valkeyUrl }, env);
    adapter = new BullMQAdapter({
      valkeyUrl,
      ...(removeOnComplete !== undefined ? { removeOnComplete } : {}),
      ...(removeOnFail !== undefined ? { removeOnFail } : {}),
    });
  }
  const jobTimeoutMs = validateMilliseconds(config.jobTimeoutMs, 'config.jobTimeoutMs', 1);
  const shutdownTimeoutMs = validateMilliseconds(
    config.shutdownTimeoutMs,
    'config.shutdownTimeoutMs',
    0,
  );

  let schedules: readonly ScheduleDefinition[];
  if (config.schedules === undefined) {
    schedules = [];
  } else if (!Array.isArray(config.schedules)) {
    throw new RuntimeConfigError(
      'invalid_config',
      'config.schedules must be an array of schedule specs',
    );
  } else {
    schedules = config.schedules as readonly ScheduleDefinition[];
  }

  let extensions: readonly JsailsExtension[];
  if (config.extensions !== undefined) {
    if (!Array.isArray(config.extensions)) {
      throw new RuntimeConfigError(
        'invalid_config',
        'config.extensions must be an array of extension objects',
      );
    }
    const extError = validateExtensionEntries(config.extensions as readonly unknown[]);
    if (extError !== undefined) {
      // Map the shared validation error to a value-free RuntimeConfigError.
      // Do not echo extension internals — only the code identifies the problem.
      throw new RuntimeConfigError(
        'invalid_config',
        `config.extensions is invalid: ${extError.code}`,
      );
    }
    extensions = config.extensions as readonly JsailsExtension[];
  } else {
    extensions = [];
  }

  const overlapMutex = validateOverlapMutex(config.overlapMutex);
  const failedJobs = validateFailedJobs(config.failedJobs);

  return {
    registry,
    adapter,
    valkeyUrl,
    schedules,
    queueName: validateString(config.queueName, 'config.queueName') ?? DEFAULT_QUEUE_NAME,
    prefix: validateString(config.prefix, 'config.prefix') ?? defaultQueuePrefix(rootDir, env),
    concurrency: validateConcurrency(
      config.concurrency,
      () =>
        new RuntimeConfigError('invalid_config', 'config.concurrency must be a positive integer'),
    ),
    extensions,
    ...(overlapMutex !== undefined ? { overlapMutex } : {}),
    ...(jobTimeoutMs !== undefined ? { jobTimeoutMs } : {}),
    ...(shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs } : {}),
    ...(failedJobs !== undefined ? { failedJobs } : {}),
  };
}

/** Validate the optional failed-job history's shape without calling it. */
function validateFailedJobs(value: unknown): FailedJobHistory | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isFailedJobHistory(value)) {
    throw new RuntimeConfigError(
      'invalid_config',
      'config.failedJobs must implement record/list/get/remove/clear',
    );
  }
  return value;
}

/** Validate an optional retention value, mapping failures to a config error. */
function validateRetention(value: unknown, label: string): JobRetention | undefined {
  if (value === undefined) return undefined;
  try {
    return validateJobRetention(value, `config.${label}`);
  } catch (error) {
    throw new RuntimeConfigError('invalid_config', formatError(error));
  }
}

/** Validate an optional millisecond bound in `[min, MAX_JOB_TIMEOUT_MS]`. */
function validateMilliseconds(value: unknown, label: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > MAX_JOB_TIMEOUT_MS
  ) {
    throw new RuntimeConfigError(
      'invalid_config',
      `${label} must be an integer between ${min} and ${MAX_JOB_TIMEOUT_MS}`,
    );
  }
  return value;
}
