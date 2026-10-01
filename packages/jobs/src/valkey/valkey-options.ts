/**
 * The options of `valkeyJobs`, checked when the factory is called so a bad
 * option fails at app assembly, before anything connects. Each refusal is a
 * value-free `jobs.invalid_option` naming the option.
 */

import type { ValkeyConnections } from 'jsails/plugin-sdk';

import { JobsErrors } from '../errors/jobs-errors.js';
import { systemClock, type JobsClock } from '../timing/long-timer.js';
import type { BullmqModule } from './bullmq-surface.js';

/**
 * Options of `valkeyJobs`.
 *
 * @public
 */
export interface ValkeyJobsOptions {
  /**
   * The app's Valkey connection provider (`valkeyToken`, or
   * `createValkeyConnections`). The adapter takes every client from it and
   * never closes it.
   */
  readonly connections: ValkeyConnections;
  /**
   * How long a worker's lock on a job lasts before it must be renewed:
   * 5 000 to 600 000 ms, default 30 000. A worker renews it at half that
   * while the job's code runs; a crashed worker's jobs come back after it.
   */
  readonly lockDurationMs?: number;
  /**
   * How often a job may lose its worker (a crash, a stalled event loop)
   * before it fails with `jobs.job_stalled`: 0 to 100, default 1.
   */
  readonly maxStalledCount?: number;
  /**
   * How often a worker process checks for schedule changes made elsewhere
   * (a reconcile, a pause): 1 000 to 300 000 ms, default 5 000.
   */
  readonly scheduleSyncMs?: number;
  /**
   * The time source of schedules (anchors, fire times and the ticker); a test
   * passes a virtual clock. BullMQ's delays and locks and the leases run on
   * real time.
   */
  readonly clock?: JobsClock;
  /**
   * Receives failures no caller awaits (a worker's connection error, a
   * schedule fire that failed and will be tried again), already value-free.
   * Defaults to `process.emitWarning`.
   */
  readonly onError?: (error: Error) => void;
  /** Test seam: where BullMQ comes from. */
  readonly dependencies?: { readonly loadBullmq?: () => Promise<BullmqModule> };
}

/** {@link ValkeyJobsOptions} with every default applied. */
export interface ResolvedValkeyJobsOptions {
  readonly connections: ValkeyConnections;
  readonly lockDurationMs: number;
  readonly maxStalledCount: number;
  readonly scheduleSyncMs: number;
  readonly clock: JobsClock;
  readonly onError: (error: Error) => void;
  readonly loadBullmq: (() => Promise<BullmqModule>) | undefined;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  'connections',
  'lockDurationMs',
  'maxStalledCount',
  'scheduleSyncMs',
  'clock',
  'onError',
  'dependencies',
]);

function refuse(option: string): Error {
  return new JobsErrors.Error('invalid_option', { option });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(
  value: unknown,
  option: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw refuse(option);
  }
  return value;
}

function isConnections(value: unknown): value is ValkeyConnections {
  if (!isRecord(value)) return false;
  return (
    typeof value.prefix === 'string' &&
    typeof value.shared === 'function' &&
    typeof value.dedicated === 'function' &&
    typeof value.script === 'function'
  );
}

function isClock(value: unknown): value is JobsClock {
  return isRecord(value) && typeof value.now === 'function' && typeof value.setTimer === 'function';
}

/** Report a failure no caller awaits as a process warning, value-free. */
function warn(error: Error): void {
  process.emitWarning(error.message, { code: 'JSAILS_JOBS_VALKEY' });
}

/**
 * The checked options.
 *
 * @throws `jobs.unknown_option` for a field that is not an option;
 *   `jobs.invalid_option` naming the option for a value out of bounds.
 */
export function resolveValkeyJobsOptions(options: unknown): ResolvedValkeyJobsOptions {
  if (!isRecord(options)) throw refuse('options');
  if (!Object.keys(options).every((key) => OPTION_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  if (!isConnections(options.connections)) throw refuse('connections');
  if (options.clock !== undefined && !isClock(options.clock)) throw refuse('clock');
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw refuse('onError');
  }
  const { dependencies } = options;
  if (
    dependencies !== undefined &&
    (!isRecord(dependencies) ||
      (dependencies.loadBullmq !== undefined && typeof dependencies.loadBullmq !== 'function'))
  ) {
    throw refuse('dependencies');
  }
  return Object.freeze({
    connections: options.connections,
    lockDurationMs: bounded(options.lockDurationMs, 'lockDurationMs', 5_000, 600_000, 30_000),
    maxStalledCount: bounded(options.maxStalledCount, 'maxStalledCount', 0, 100, 1),
    scheduleSyncMs: bounded(options.scheduleSyncMs, 'scheduleSyncMs', 1_000, 300_000, 5_000),
    clock: options.clock ?? systemClock,
    onError: (options.onError as ((error: Error) => void) | undefined) ?? warn,
    loadBullmq:
      (dependencies?.loadBullmq as (() => Promise<BullmqModule>) | undefined) ?? undefined,
  });
}
