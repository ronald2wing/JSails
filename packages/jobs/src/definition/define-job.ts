/**
 * `defineJob`: the one way to declare a job.
 *
 * A definition binds a name to a Zod schema and a handler. Its only public
 * operation is `with(payload, options?)`, which returns an inert
 * {@link JobCall}: a value that names the job, carries a payload typed by the
 * schema's input, and does nothing until a {@link Jobs} service dispatches it.
 * Typing comes from the definition itself, so there is no generated register,
 * no ambient dispatcher, and nothing on `globalThis`.
 *
 * The handler receives the schema's output, because the worker parses the
 * stored payload (the schema's input) once before it runs. Everything else on
 * the definition (schema, handler, policy) is held privately and read by the
 * producer and the runtime through {@link jobSpec}, which this package does
 * not export.
 */

import type { z } from 'jsails/zod';

import type {
  DispatchOptions,
  JobBackoff,
  JobEnvelopeMeta,
  JobOptions,
} from '../contract/index.js';
import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_KEY_WINDOW_MS,
  validAttempts,
  validBackoff,
  validDuration,
  validPriority,
} from '../envelope/job-options.js';
import { DEFAULT_QUEUE, isQueueName } from '../queues/queue-set.js';
import { JobDefinitionError } from './definition-error.js';
import type { Jobs } from './jobs-service.js';

/** What a handler and its middleware see for one attempt. */
export interface JobContext {
  readonly name: string;
  /** The transport's id for the job; the same across its attempts. */
  readonly jobId: string;
  /** One-based. A released attempt is not counted. */
  readonly attempt: number;
  /** Aborted when the attempt times out or the worker shuts down. Pass it to I/O. */
  readonly signal: AbortSignal;
  /** Dispatch further jobs; works while the worker drains. */
  readonly jobs: Jobs;
  /** The framework metadata of the job, read-only. */
  readonly meta: JobEnvelopeMeta;
}

/** Definition middleware: wraps the handler, the first entry outermost. */
export type JobMiddleware = (context: JobContext, next: () => Promise<void>) => Promise<void>;

/**
 * A job's error policy, consulted when its handler throws. `'discard'` ends
 * the job without a failure record or a retry; returning nothing leaves the
 * decision to the error's kind (retryable or not).
 */
export type JobErrorHandler = (error: unknown, context: JobContext) => 'discard' | undefined;

/** The handler of a job: receives the parsed payload. */
export type JobHandler<TPayload> = (payload: TPayload, context: JobContext) => Promise<void> | void;

/** What `defineJob` takes. */
export interface JobDefinitionInput<N extends string, S extends z.ZodType, Q extends string> {
  /**
   * Unique within the app: letters and digits in segments joined by `.`, `:`,
   * `_` or `-`, starting with a letter, at most 128 characters.
   */
  readonly name: N;
  /** Validates the payload at dispatch and again in the worker. */
  readonly schema: S;
  /** A declared queue. Defaults to `default`. */
  readonly queue?: Q;
  /** Total attempts, the first run included (1 to 25). Defaults to 3. */
  readonly attempts?: number;
  /** Defaults to exponential from 1 s. */
  readonly backoff?: JobBackoff;
  /** Per-attempt deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** Lower runs first among waiting jobs of one queue. Defaults to 0. */
  readonly priority?: number;
  /** An idempotency key computed from the parsed payload; a dispatch `key` overrides it. */
  readonly key?: (payload: z.output<S>) => string;
  /** How long a key deduplicates, in milliseconds. Defaults to one day. */
  readonly keyWindowMs?: number;
  readonly middleware?: readonly JobMiddleware[];
  readonly onError?: JobErrorHandler;
  /** Whether a chain continues past this step when overlap skipped it. Defaults to `'stop'`. */
  readonly onSkip?: 'stop' | 'continue';
  /**
   * `'drop'` removes the job from the transport after its final failure is
   * signalled, for a job whose payload must not linger. Defaults to `'keep'`.
   */
  readonly onFinalFailure?: 'keep' | 'drop';
  handle(payload: z.output<S>, context: JobContext): Promise<void> | void;
}

/** A declared job. */
export interface JobDefinition<
  N extends string = string,
  S extends z.ZodType = z.ZodType,
  Q extends string = string,
> {
  readonly name: N;
  readonly queue: Q;
  /** An inert call of this job, for a {@link Jobs} service to dispatch. */
  with(payload: z.input<S>, options?: DispatchOptions): JobCall<N, S>;
}

/** An inert, typed call of one job. Nothing happens until it is dispatched. */
export interface JobCall<N extends string = string, S extends z.ZodType = z.ZodType> {
  readonly name: N;
  readonly payload: z.input<S>;
  readonly options: DispatchOptions | undefined;
  readonly definition: JobDefinition<N, S>;
}

/** Everything about a definition the producer and the runtime read. */
export interface JobSpec {
  readonly name: string;
  readonly queue: string;
  readonly schema: z.ZodType;
  /** Resolved defaults: `attempts` and `backoff` always present. */
  readonly options: JobOptions;
  readonly key: ((payload: unknown) => string) | undefined;
  readonly keyWindowMs: number;
  readonly middleware: readonly JobMiddleware[];
  readonly onError: JobErrorHandler | undefined;
  readonly onSkip: 'stop' | 'continue';
  readonly onFinalFailure: 'keep' | 'drop';
  readonly handle: JobHandler<unknown>;
}

const JOB_NAME = /^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/;
const MAX_JOB_NAME_LENGTH = 128;

const INPUT_KEYS: ReadonlySet<string> = new Set([
  'name',
  'schema',
  'queue',
  'attempts',
  'backoff',
  'timeoutMs',
  'priority',
  'key',
  'keyWindowMs',
  'middleware',
  'onError',
  'onSkip',
  'onFinalFailure',
  'handle',
]);

const specs = new WeakMap<object, JobSpec>();

function invalid(message: string): JobDefinitionError {
  return new JobDefinitionError('invalid_definition', message);
}

function invalidOption(option: string, rule: string): JobDefinitionError {
  return new JobDefinitionError('invalid_option', `job option "${option}" ${rule}`);
}

/** Whether `name` is a valid job name. */
export function isJobName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MAX_JOB_NAME_LENGTH && JOB_NAME.test(name);
}

function isSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParseAsync?: unknown }).safeParseAsync === 'function'
  );
}

function resolveOptions(input: Record<string, unknown>): JobOptions {
  const options: { -readonly [K in keyof JobOptions]: JobOptions[K] } = {
    attempts: DEFAULT_JOB_OPTIONS.attempts,
    backoff: DEFAULT_JOB_OPTIONS.backoff,
  };
  if (input.attempts !== undefined) {
    const attempts = validAttempts(input.attempts);
    if (attempts === undefined) throw invalidOption('attempts', 'must be an integer from 1 to 25');
    options.attempts = attempts;
  }
  if (input.backoff !== undefined) {
    const backoff = validBackoff(input.backoff);
    if (backoff === undefined) {
      throw invalidOption(
        'backoff',
        'must be { type: "fixed" | "exponential", delayMs } with delayMs from 0 to one year',
      );
    }
    options.backoff = backoff;
  }
  if (input.timeoutMs !== undefined) {
    const timeoutMs = validDuration(input.timeoutMs);
    if (timeoutMs === undefined)
      throw invalidOption('timeoutMs', 'must be an integer from 1 ms to one year');
    options.timeoutMs = timeoutMs;
  }
  if (input.priority !== undefined) {
    const priority = validPriority(input.priority);
    if (priority === undefined)
      throw invalidOption('priority', 'must be an integer from 0 to 2097152');
    options.priority = priority;
  }
  return Object.freeze(options);
}

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  option: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  throw invalidOption(option, `must be one of ${allowed.map((entry) => `"${entry}"`).join(', ')}`);
}

function optionalFunction<T>(value: unknown, option: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw invalidOption(option, 'must be a function');
  return value as T;
}

/**
 * A call's own copy of its options, so changing the caller's object after
 * `with` cannot change what a later dispatch of the call enqueues. A value
 * that is not a plain record is kept as given for dispatch to refuse.
 */
function frozenOptions(options: DispatchOptions | undefined): DispatchOptions | undefined {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return options;
  const copy: { -readonly [K in keyof DispatchOptions]: DispatchOptions[K] } = { ...options };
  if (Array.isArray(options.tags)) copy.tags = Object.freeze([...options.tags]);
  if (options.runAt instanceof Date) copy.runAt = new Date(options.runAt.getTime());
  return Object.freeze(copy);
}

/**
 * Declare a job.
 *
 * @throws {JobDefinitionError} `unknown_option` for a field that is not part of
 *   a definition, `invalid_definition` for a bad name, schema, queue or
 *   handler, `invalid_option` for an option out of bounds.
 */
export function defineJob<
  const N extends string,
  S extends z.ZodType,
  const Q extends string = typeof DEFAULT_QUEUE,
>(input: JobDefinitionInput<N, S, Q>): JobDefinition<N, S, Q> {
  if (typeof input !== 'object' || input === null)
    throw invalid('a job definition must be an object');
  const record = input as unknown as Record<string, unknown>;
  if (!Object.keys(record).every((key) => INPUT_KEYS.has(key))) {
    throw new JobDefinitionError(
      'unknown_option',
      'a job definition has a field that is not a definition option',
    );
  }
  if (!isJobName(record.name)) {
    throw invalid(
      'a job name must be letters and digits in segments joined by ".", ":", "_" or "-", starting with a letter, at most 128 characters',
    );
  }
  if (!isSchema(record.schema)) throw invalid('a job definition needs a Zod schema');
  const queue = record.queue ?? DEFAULT_QUEUE;
  if (!isQueueName(queue)) {
    throw invalid('a job queue must be a queue name: lower-case letters, digits and hyphens');
  }
  if (typeof record.handle !== 'function')
    throw invalid('a job definition needs a handle function');
  let keyWindowMs = DEFAULT_KEY_WINDOW_MS;
  if (record.keyWindowMs !== undefined) {
    const window = validDuration(record.keyWindowMs);
    if (window === undefined)
      throw invalidOption('keyWindowMs', 'must be an integer from 1 ms to one year');
    keyWindowMs = window;
  }
  let middleware: readonly JobMiddleware[] = Object.freeze([]);
  if (record.middleware !== undefined) {
    if (
      !Array.isArray(record.middleware) ||
      !(record.middleware as unknown[]).every((entry) => typeof entry === 'function')
    ) {
      throw invalidOption('middleware', 'must be an array of functions');
    }
    middleware = Object.freeze([...(record.middleware as JobMiddleware[])]);
  }
  const handle = record.handle as JobHandler<unknown>;
  const spec: JobSpec = Object.freeze<JobSpec>({
    name: record.name,
    queue,
    schema: record.schema,
    options: resolveOptions(record),
    key: optionalFunction<(payload: unknown) => string>(record.key, 'key'),
    keyWindowMs,
    middleware,
    onError: optionalFunction<JobErrorHandler>(record.onError, 'onError'),
    onSkip: choice(record.onSkip, ['stop', 'continue'] as const, 'stop', 'onSkip'),
    onFinalFailure: choice(
      record.onFinalFailure,
      ['keep', 'drop'] as const,
      'keep',
      'onFinalFailure',
    ),
    handle: (payload, context) => handle.call(input, payload, context),
  });
  const definition: JobDefinition<N, S, Q> = Object.freeze({
    name: input.name,
    queue: queue as Q,
    with(payload: z.input<S>, options?: DispatchOptions): JobCall<N, S> {
      return Object.freeze({
        name: input.name,
        payload,
        options: frozenOptions(options),
        definition,
      });
    },
  });
  specs.set(definition, spec);
  return definition;
}

/** Whether `value` is a definition built by {@link defineJob}. */
export function isJobDefinition(value: unknown): value is JobDefinition {
  return typeof value === 'object' && value !== null && specs.has(value);
}

/**
 * The private spec of a definition. Not exported from the package: the
 * producer and the runtime read it, apps cannot.
 *
 * @throws {JobDefinitionError} `invalid_definition` for a value `defineJob` did not build.
 */
export function jobSpec(definition: JobDefinition): JobSpec {
  const spec = specs.get(definition);
  if (spec === undefined) throw invalid('the value is not a job definition built by defineJob');
  return spec;
}
