/**
 * The `Jobs` service and the producer that implements it.
 *
 * `dispatch(Job.with(payload), options?)` is the one typed dispatch verb;
 * `dispatchByName(name, payload, options?)` is the untyped escape hatch for a
 * CLI or an admin action, validated at runtime the same way. A dispatch:
 *
 * 1. refuses a call whose definition is not the one the catalog registered
 *    under its name (a stale or foreign definition would enqueue a job no
 *    worker runs);
 * 2. validates the dispatch options, refusing an unknown key;
 * 3. takes a plain-JSON snapshot of the payload, validates the snapshot with
 *    the job's schema, and stores that snapshot (the schema's input), so the
 *    worker's parse runs transforms once and a caller that mutates its object
 *    while an async schema runs cannot enqueue a payload that was never
 *    validated;
 * 4. builds the envelope with the framework's metadata (key and window, tags,
 *    serialized execution context, run time, dispatch time), which a caller
 *    can never supply, and enqueues it on the job's declared queue.
 *
 * Every refusal is a value-free {@link JobDispatchError} and enqueues nothing.
 */

import type {
  DispatchOptions,
  JobEnvelope,
  JobHandle,
  JobOptions,
  JobsAdapter,
} from '../contract/index.js';
import { buildEnvelope, JobEnvelopeError, type EnvelopeParts } from '../envelope/codec.js';
import {
  JOB_OPTION_KEYS,
  MAX_JOB_DELAY_MS,
  validDelay,
  validDuration,
  validJobOptions,
  validKey,
  validTags,
} from '../envelope/job-options.js';
import { isPlainJson } from '../envelope/plain-json.js';
import { systemClock, type JobsClock } from '../timing/long-timer.js';
import type { JobCatalog } from './catalog.js';
import { jobSpec, type JobCall, type JobSpec } from './define-job.js';
import { JobDispatchError } from './definition-error.js';

/** Dispatches jobs. */
export interface Jobs {
  /** Enqueue a typed call; options here override the call's own. */
  dispatch(call: JobCall, options?: DispatchOptions): Promise<JobHandle>;
  /** Enqueue a job by name with an unchecked payload, validated at runtime. */
  dispatchByName(name: string, payload: unknown, options?: DispatchOptions): Promise<JobHandle>;
}

/** A {@link Jobs} service with a lifecycle. */
export interface JobProducer extends Jobs {
  /** Refuse further dispatches with `producer_closed`. Idempotent. */
  close(): void;
  readonly closed: boolean;
}

export interface ProducerOptions {
  readonly catalog: JobCatalog;
  readonly adapter: JobsAdapter;
  readonly clock?: JobsClock;
  /**
   * The serialized execution context to carry into the job (trace, request
   * id, locale, tenant), read at each dispatch. It must be plain JSON.
   */
  readonly context?: () => unknown;
}

const DISPATCH_OPTION_KEYS: ReadonlySet<string> = new Set([
  ...JOB_OPTION_KEYS,
  'delayMs',
  'runAt',
  'key',
  'keyWindowMs',
  'tags',
]);

function refuse(option: string, rule: string): JobDispatchError {
  return new JobDispatchError('invalid_option', `dispatch option "${option}" ${rule}`);
}

/** Check one options record: an object of known keys, or absent. */
function checkedOptions(value: unknown): DispatchOptions {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JobDispatchError('invalid_option', 'dispatch options must be an object');
  }
  if (!Object.keys(value).every((key) => DISPATCH_OPTION_KEYS.has(key))) {
    throw new JobDispatchError(
      'unknown_option',
      'dispatch options have a field that is not a dispatch option',
    );
  }
  return value;
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/** The epoch milliseconds a job may run from, or `undefined` for at once. */
function runAtOf(options: DispatchOptions, now: number): number | undefined {
  if (options.delayMs !== undefined && options.runAt !== undefined) {
    throw new JobDispatchError(
      'invalid_option',
      'dispatch options "delayMs" and "runAt" are exclusive',
    );
  }
  if (options.delayMs !== undefined) {
    const delayMs = validDelay(options.delayMs);
    if (delayMs === undefined) throw refuse('delayMs', 'must be an integer from 0 to one year');
    return delayMs === 0 ? undefined : now + delayMs;
  }
  if (options.runAt !== undefined) {
    const at: unknown = options.runAt;
    if (!(at instanceof Date) || Number.isNaN(at.getTime()))
      throw refuse('runAt', 'must be a valid Date');
    const runAt = at.getTime();
    if (runAt - now > MAX_JOB_DELAY_MS) throw refuse('runAt', 'must be at most one year ahead');
    return runAt <= now ? undefined : runAt;
  }
  return undefined;
}

function resolvedOptions(spec: JobSpec, options: DispatchOptions): JobOptions {
  const overrides: Record<string, unknown> = {};
  for (const key of JOB_OPTION_KEYS) {
    if (options[key] !== undefined) overrides[key] = options[key];
  }
  const checked = validJobOptions(overrides);
  if (!checked.ok) {
    throw refuse(checked.problem, 'is out of bounds');
  }
  return { ...spec.options, ...checked.options };
}

function keyOf(
  spec: JobSpec,
  options: DispatchOptions,
  parsed: unknown,
): { readonly value: string; readonly windowMs: number } | undefined {
  let raw: unknown = options.key;
  if (raw === undefined && spec.key !== undefined) {
    try {
      raw = spec.key(parsed);
    } catch (error) {
      throw new JobDispatchError('invalid_option', 'the job definition key function threw', {
        cause: error,
      });
    }
  }
  if (raw === undefined) {
    if (options.keyWindowMs !== undefined) throw refuse('keyWindowMs', 'needs a key');
    return undefined;
  }
  const value = validKey(raw);
  if (value === undefined) throw refuse('key', 'must be a string of 1 to 512 characters');
  let windowMs = spec.keyWindowMs;
  if (options.keyWindowMs !== undefined) {
    const window = validDuration(options.keyWindowMs);
    if (window === undefined)
      throw refuse('keyWindowMs', 'must be an integer from 1 ms to one year');
    windowMs = window;
  }
  return { value, windowMs };
}

/** {@link buildEnvelope}, with a value that cannot be serialized reported as a dispatch error. */
function envelopeOf(parts: EnvelopeParts): JobEnvelope {
  try {
    return buildEnvelope(parts);
  } catch (error) {
    if (error instanceof JobEnvelopeError && error.code !== 'invalid_envelope') {
      throw new JobDispatchError(error.code, error.message, { cause: error });
    }
    throw error;
  }
}

class Producer implements JobProducer {
  readonly #catalog: JobCatalog;
  readonly #adapter: JobsAdapter;
  readonly #clock: JobsClock;
  readonly #context: (() => unknown) | undefined;
  #closed = false;

  constructor(options: ProducerOptions) {
    this.#catalog = options.catalog;
    this.#adapter = options.adapter;
    this.#clock = options.clock ?? systemClock;
    this.#context = options.context;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }

  dispatch(call: JobCall, options?: DispatchOptions): Promise<JobHandle> {
    return this.#run(() => {
      const registered =
        typeof call === 'object' && call !== null ? this.#catalog.get(call.name) : undefined;
      if (registered === undefined || registered !== call.definition) {
        throw new JobDispatchError(
          'unknown_job',
          'the job call is not of a job registered in the catalog',
        );
      }
      return [jobSpec(registered), call.payload, [call.options, options]];
    });
  }

  dispatchByName(name: string, payload: unknown, options?: DispatchOptions): Promise<JobHandle> {
    return this.#run(() => {
      const registered = typeof name === 'string' ? this.#catalog.get(name) : undefined;
      if (registered === undefined) {
        throw new JobDispatchError(
          'unknown_job',
          'no job of that name is registered in the catalog',
        );
      }
      return [jobSpec(registered), payload, [options]];
    });
  }

  async #run(
    resolve: () => readonly [JobSpec, unknown, readonly (DispatchOptions | undefined)[]],
  ): Promise<JobHandle> {
    if (this.#closed) throw new JobDispatchError('producer_closed', 'the job producer is closed');
    const [spec, payload, layers] = resolve();
    const options: DispatchOptions = Object.assign(
      {},
      ...layers.map((layer) => definedEntries(checkedOptions(layer))),
    ) as DispatchOptions;
    const jobOptions = resolvedOptions(spec, options);
    const tags = options.tags === undefined ? undefined : validTags(options.tags);
    if (options.tags !== undefined && tags === undefined) {
      throw refuse('tags', 'must be at most 32 strings of 1 to 128 characters');
    }
    if (!isPlainJson(payload)) {
      throw new JobDispatchError(
        'payload_not_json',
        'a job payload must be plain JSON: objects, arrays, strings, finite numbers, booleans and null',
      );
    }
    const snapshot = JSON.parse(JSON.stringify(payload)) as unknown;
    const parsed = await spec.schema.safeParseAsync(snapshot);
    if (!parsed.success) {
      throw new JobDispatchError(
        'invalid_payload',
        'the job payload does not match the job schema',
      );
    }
    const key = keyOf(spec, options, parsed.data);
    const now = this.#clock.now();
    const runAt = runAtOf(options, now);
    const context = this.#context?.();
    if (this.#closed) throw new JobDispatchError('producer_closed', 'the job producer is closed');
    const envelope = envelopeOf({
      name: spec.name,
      payload: snapshot,
      options: jobOptions,
      ...(key === undefined ? {} : { key }),
      ...(tags === undefined ? {} : { tags }),
      ...(context === undefined ? {} : { context }),
      ...(runAt === undefined ? {} : { runAt }),
      dispatchedAt: now,
    });
    return this.#adapter.enqueue(spec.queue, envelope);
  }
}

/** A producer over `adapter` for the jobs of `catalog`. */
export function createProducer(options: ProducerOptions): JobProducer {
  return new Producer(options);
}
