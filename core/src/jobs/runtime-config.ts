/**
 * Runtime configuration for the jobs CLI (`work` / `schedule`).
 *
 * The runtime config is a plain ESM module (`.js` or `.mjs`) that
 * default-exports an object describing the job registry, the Valkey/Redis
 * connection (or a custom adapter), and optional schedules:
 *
 *     export default {
 *       registry: createJobRegistry({ ... }),
 *       valkeyUrl: 'redis://...',
 *       schedules: [{ id, job, cron }],
 *       queueName: 'default',
 *       prefix: 'bull',
 *       concurrency: 1,
 *       // optional: automatic schedule overlap (caller-owned)
 *       overlapMutex: new ValkeyMutexStore({ valkeyUrl: 'redis://...' }),
 *       // alternative to valkeyUrl: a custom JobsRuntimeAdapter (no URL needed)
 *       adapter: { name, createProducer, createWorker, upsertSchedules? },
 *     };
 *
 * Valkey is the default vocabulary: `valkeyUrl` is the config key and
 * `VALKEY_URL` the environment variable. The internal library APIs keep their
 * `redisUrl` name; only this config boundary maps the preferred name to the
 * single resolved `redis://`/`rediss://` URL handed to the built-in BullMQ
 * adapter. URL validation is explicit about the scheme and never echoes the
 * value (a URL may embed a password).
 *
 * When `adapter` is supplied, it is selected verbatim: the custom adapter owns
 * its transport, so no Valkey/Redis URL is required, read, or validated, and
 * the built-in BullMQ adapter is never constructed. A malformed adapter
 * (missing non-empty `name`, `createProducer`, or `createWorker`, or a
 * non-function `upsertSchedules`) is rejected without invoking any factory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMutexStore, type MutexStore } from '../cache/mutex.js';
import { formatError } from '../internal/errors.js';
import { isTypeScriptConfig } from '../internal/config-module.js';
import { BullMQAdapter } from './bullmq-adapter.js';
import { DEFAULT_PREFIX, DEFAULT_QUEUE_NAME } from './connection.js';
import type { JsailsExtension } from '../extensions/extension.js';
import { createJobRegistry, type JobDefinition, type JobRegistry } from './registry.js';
import { loadJobRegistryFromDirectory } from './discovery.js';
import { validateJobsRuntimeAdapter, type JobsRuntimeAdapter } from './runtime.js';
import type { ScheduleDefinition } from './scheduler.js';
import type { ServiceRegistry } from '../extensions/services.js';
import { validateExtensionEntries } from '../extensions/validation.js';
import { assertConnectionUrl } from '../internal/valkey-connection.js';

/** Default runtime config path for the `work` / `schedule` commands. */
export const DEFAULT_RUNTIME_CONFIG_PATH = 'jsails.runtime.js';

/** Conventional schedule file auto-loaded next to the runtime config. */
export const DEFAULT_SCHEDULES_PATH = 'jsails.schedules.json';

/** Error raised for any invalid runtime config or connection URL. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
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
   * identity is preserved) and no Valkey/Redis URL is required, read, or
   * validated. When absent, the built-in BullMQ adapter is constructed from the
   * resolved Valkey/Redis URL.
   */
  readonly adapter?: JobsRuntimeAdapter;
  /** Valkey/Redis URL. */
  readonly valkeyUrl?: string;
  /** Schedules to register. Defaults to `[]`. */
  readonly schedules?: readonly ScheduleDefinition[];
  /** Queue name. Defaults to `"default"`. */
  readonly queueName?: string;
  /** Redis key prefix. Defaults to `"bull"`. */
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
      `config "${configPath}" is a TypeScript module; compile it to JavaScript first ` +
        `(e.g. tsc) and point --config at the compiled output`,
    );
  }
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new RuntimeConfigError(
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
  return validateRuntimeConfig(withJobs, env);
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
    throw new RuntimeConfigError('config.jobsDir must be a non-empty string');
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
    throw new RuntimeConfigError(`${DEFAULT_SCHEDULES_PATH} is not valid JSON`);
  }
  if (!Array.isArray(schedules)) {
    throw new RuntimeConfigError(
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
  return assertConnectionUrl(value, (message) => new RuntimeConfigError(message));
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
      'no Valkey/Redis URL configured: set `valkeyUrl` in the runtime config, or set ' +
        'VALKEY_URL in the environment',
    );
  }
  return assertRedisUrl(candidate);
}

/** Validate the registry shape without executing any job handler. */
function validateRegistry(value: unknown): JobRegistry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeConfigError(
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
    throw new RuntimeConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateConcurrency(value: unknown): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RuntimeConfigError('config.concurrency must be a positive integer');
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
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeConfigError(`config.adapter is invalid: ${detail}`);
  }
  return value;
}

/** Validate the optional automatic-overlap store without touching it. */
function validateOverlapMutex(value: unknown): MutexStore | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMutexStore(value)) {
    throw new RuntimeConfigError('config.overlapMutex must implement acquire/release/close');
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
 * validates the whole list before any registration.
 */
export function validateRuntimeConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRuntimeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RuntimeConfigError('the runtime config must default-export an object');
  }
  const config = raw as Record<string, unknown>;

  const registry = validateRegistry(config.registry);

  let adapter: JobsRuntimeAdapter;
  let redisUrl: string | undefined;
  if (config.adapter !== undefined) {
    adapter = validateAdapter(config.adapter);
    redisUrl = undefined;
  } else {
    redisUrl = resolveRuntimeValkeyUrl({ valkeyUrl: config.valkeyUrl }, env);
    adapter = new BullMQAdapter({ redisUrl });
  }

  let schedules: readonly ScheduleDefinition[];
  if (config.schedules === undefined) {
    schedules = [];
  } else if (!Array.isArray(config.schedules)) {
    throw new RuntimeConfigError('config.schedules must be an array of schedule specs');
  } else {
    schedules = config.schedules as readonly ScheduleDefinition[];
  }

  let extensions: readonly JsailsExtension[];
  if (config.extensions !== undefined) {
    if (!Array.isArray(config.extensions)) {
      throw new RuntimeConfigError('config.extensions must be an array of extension objects');
    }
    const extError = validateExtensionEntries(config.extensions as readonly unknown[]);
    if (extError !== undefined) {
      // Map the shared validation error to a value-free RuntimeConfigError.
      // Do not echo extension internals — only the code identifies the problem.
      throw new RuntimeConfigError(`config.extensions is invalid: ${extError.code}`);
    }
    extensions = config.extensions as readonly JsailsExtension[];
  } else {
    extensions = [];
  }

  const overlapMutex = validateOverlapMutex(config.overlapMutex);

  return {
    registry,
    adapter,
    valkeyUrl: redisUrl,
    schedules,
    queueName: validateString(config.queueName, 'config.queueName') ?? DEFAULT_QUEUE_NAME,
    prefix: validateString(config.prefix, 'config.prefix') ?? DEFAULT_PREFIX,
    concurrency: validateConcurrency(config.concurrency),
    extensions,
    ...(overlapMutex !== undefined ? { overlapMutex } : {}),
  };
}
