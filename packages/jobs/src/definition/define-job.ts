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

import type { TraceContext } from 'jsails/context';
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
  isJobName,
  validAttempts,
  validBackoff,
  validDuration,
  validPriority,
} from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { RESERVED_JOB_PREFIX } from '../flows/flow-limits.js';
import { resolveOverlapOption, type OverlapOption } from '../overlap/overlap-option.js';
import { DEFAULT_QUEUE, isQueueName } from '../queues/queue-set.js';
import type { Jobs } from './jobs-service.js';

/**
 * The actor a job runs as: always the system, named after the job, never the
 * dispatcher (the actor is not propagated into a job). Structurally the
 * `system` actor of the framework's actor model.
 */
export interface JobActor {
  readonly kind: 'system';
  readonly reason: `job:${string}`;
}

/**
 * Where a job sits in a flow, as its handler sees it: a chain step's
 * position (how many steps remain after it), never the stored steps, whose
 * payloads belong to other jobs.
 */
export type JobFlowPosition =
  | {
      readonly kind: 'chain';
      readonly id: string;
      readonly step: number;
      /** Steps after this one. */
      readonly remaining: number;
    }
  | { readonly kind: 'batch'; readonly id: string; readonly index: number }
  | {
      readonly kind: 'callback';
      readonly flow: 'chain' | 'batch';
      readonly id: string;
      readonly callback: 'then' | 'catch' | 'finally';
    };

/**
 * The framework metadata a handler may read: the envelope meta less the
 * serialized execution context, which the runtime has already restored
 * around the attempt (read it through `jsails/context`), with the flow
 * membership as a {@link JobFlowPosition}.
 */
export type JobMeta = Readonly<
  Omit<JobEnvelopeMeta, 'context' | 'flow'> & { readonly flow?: JobFlowPosition }
>;

/**
 * What a handler and its middleware see for one attempt. The attempt runs
 * inside the execution context its dispatch carried (request id, tenant,
 * locale), restored as a child span; the tenant is read where it is
 * enforced (`currentTenantId()` from `jsails/database`).
 */
export interface JobContext {
  /** Always the system: `{ kind: 'system', reason: 'job:<name>' }`. */
  readonly actor: JobActor;
  /** The id of the request that dispatched the job, when it was dispatched by one. */
  readonly requestId: string | undefined;
  /** The attempt's own span, a child of the dispatcher's. */
  readonly trace: TraceContext;
  readonly name: string;
  /** The transport's id for the job; the same across its attempts. */
  readonly jobId: string;
  /** One-based. A released attempt is not counted. */
  readonly attempt: number;
  /** Aborted when the attempt times out or the worker shuts down. Pass it to I/O. */
  readonly signal: AbortSignal;
  /** Dispatch further jobs; works while the worker drains. */
  readonly jobs: Jobs;
  /** The framework metadata of the job, frozen. */
  readonly meta: JobMeta;
}

/**
 * Definition middleware: wraps the handler, the first entry outermost.
 * `next()` runs the rest of the chain once, while the middleware has not
 * settled; await or return it. A failure of the rest fails the attempt even
 * when the middleware resolves (throw to replace it; `onError` decides
 * whether a failure ends the job).
 */
export type JobMiddleware = (context: JobContext, next: () => Promise<void>) => Promise<void>;

/**
 * A job's error policy, consulted when its handler or middleware throws or
 * its attempt times out or loses its overlap lease, with the thrown value as
 * is. `'discard'` ends the job without a failure record or a retry, and
 * counts as completed for chains (the next step runs) and batches; returning
 * anything else, or throwing, leaves the decision to the error's kind
 * (retryable or not).
 */
export type JobErrorHandler = (error: unknown, context: JobContext) => 'discard' | undefined;

/** The handler of a job: receives the parsed payload. */
export type JobHandler<TPayload> = (payload: TPayload, context: JobContext) => Promise<void> | void;

/** What `defineJob` takes. */
export interface JobDefinitionInput<N extends string, S extends z.ZodType, Q extends string> {
  /**
   * Unique within the app: letters and digits in segments joined by `.`, `:`,
   * `_` or `-`, starting with a letter, at most 128 characters. Names starting
   * with `jsails.` are reserved for the framework.
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
  /**
   * Never run alongside another run holding the same lease key: such a run
   * is `skipped`. The key defaults to the job name; a function computes it
   * from the parsed payload. The lease lasts `ttlMs` (1 s to 1 h, default
   * 5 min) and is renewed while the attempt runs. Needs an adapter with
   * leases.
   */
  readonly overlap?:
    | true
    | {
        readonly key?: string | ((payload: z.output<S>) => string);
        readonly ttlMs?: number;
      };
  /** Whether a chain continues past this step when overlap skipped it. Defaults to `'stop'`. */
  readonly onSkip?: 'stop' | 'continue';
  /**
   * `'drop'` keeps no failed record of the job after its final failure: the
   * transport deletes it in the same operation that settles it, for a job
   * whose payload must not linger. Defaults to `'keep'`.
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
  readonly overlap: OverlapOption | undefined;
  readonly middleware: readonly JobMiddleware[];
  readonly onError: JobErrorHandler | undefined;
  readonly onSkip: 'stop' | 'continue';
  readonly onFinalFailure: 'keep' | 'drop';
  readonly handle: JobHandler<unknown>;
}

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
  'overlap',
  'middleware',
  'onError',
  'onSkip',
  'onFinalFailure',
  'handle',
]);

const specs = new WeakMap<object, JobSpec>();

type DefinitionRule = 'shape' | 'name' | 'schema' | 'queue' | 'handle' | 'not_built' | 'reserved';

function invalid(rule: DefinitionRule): Error {
  return new JobsErrors.Error('invalid_definition', { rule });
}

function invalidOption(option: string): Error {
  return new JobsErrors.Error('invalid_option', { option });
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
    if (attempts === undefined) throw invalidOption('attempts');
    options.attempts = attempts;
  }
  if (input.backoff !== undefined) {
    const backoff = validBackoff(input.backoff);
    if (backoff === undefined) {
      throw invalidOption('backoff');
    }
    options.backoff = backoff;
  }
  if (input.timeoutMs !== undefined) {
    const timeoutMs = validDuration(input.timeoutMs);
    if (timeoutMs === undefined) throw invalidOption('timeoutMs');
    options.timeoutMs = timeoutMs;
  }
  if (input.priority !== undefined) {
    const priority = validPriority(input.priority);
    if (priority === undefined) throw invalidOption('priority');
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
  throw invalidOption(option);
}

function optionalFunction<T>(value: unknown, option: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') throw invalidOption(option);
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
 * @throws `jobs.unknown_option` for a field that is not part of a
 *   definition, `jobs.invalid_definition` for a bad or reserved name, schema,
 *   queue or handler, `jobs.invalid_option` for an option out of bounds.
 */
export function defineJob<
  const N extends string,
  S extends z.ZodType,
  const Q extends string = typeof DEFAULT_QUEUE,
>(input: JobDefinitionInput<N, S, Q>): JobDefinition<N, S, Q> {
  if (typeof input !== 'object' || input === null) throw invalid('shape');
  const record = input as unknown as Record<string, unknown>;
  if (!Object.keys(record).every((key) => INPUT_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  if (!isJobName(record.name)) {
    throw invalid('name');
  }
  if (record.name.startsWith(RESERVED_JOB_PREFIX)) throw invalid('reserved');
  if (!isSchema(record.schema)) throw invalid('schema');
  const queue = record.queue ?? DEFAULT_QUEUE;
  if (!isQueueName(queue)) {
    throw invalid('queue');
  }
  if (typeof record.handle !== 'function') throw invalid('handle');
  let keyWindowMs = DEFAULT_KEY_WINDOW_MS;
  if (record.keyWindowMs !== undefined) {
    const window = validDuration(record.keyWindowMs);
    if (window === undefined) throw invalidOption('keyWindowMs');
    keyWindowMs = window;
  }
  let middleware: readonly JobMiddleware[] = Object.freeze([]);
  if (record.middleware !== undefined) {
    if (
      !Array.isArray(record.middleware) ||
      !(record.middleware as unknown[]).every((entry) => typeof entry === 'function')
    ) {
      throw invalidOption('middleware');
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
    overlap: resolveOverlapOption(record.overlap),
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
 * @throws `jobs.invalid_definition` for a value `defineJob` did not build.
 */
export function jobSpec(definition: JobDefinition): JobSpec {
  const spec = specs.get(definition);
  if (spec === undefined) throw invalid('not_built');
  return spec;
}
