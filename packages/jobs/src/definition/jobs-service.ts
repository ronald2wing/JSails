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
 * 2. validates the dispatch options, refusing an unknown key and a key under
 *    the reserved `jsails:` prefix, where the flow and schedule keys live;
 * 3. takes a plain-JSON snapshot of the payload, validates the snapshot with
 *    the job's schema, and stores that snapshot (the schema's input), so the
 *    worker's parse runs transforms once and a caller that mutates its object
 *    while an async schema runs cannot enqueue a payload that was never
 *    validated;
 * 4. builds the envelope with the framework's metadata (key and window, tags,
 *    the ambient execution context serialized by `jsails/context`, the
 *    overlap lease key and TTL, run time, dispatch time), which a caller can never supply, and enqueues it on the
 *    job's declared queue.
 *
 * The execution context is always the one the dispatch runs in: a request's
 * request id, trace and tenant follow the job into the worker without any
 * wiring, so no producer can silently drop the tenant.
 *
 * Every refusal is a value-free `jobs.*` error and enqueues nothing.
 *
 * Flows are validated whole before anything is enqueued:
 *
 * - `chain(steps, { catch })` prepares every step (and the catch) as a
 *   dispatch does, then enqueues only the head, whose envelope carries the
 *   later steps and the catch (at most 100 steps and 256 KiB): the worker
 *   that settles a step hands the next to the transport, which stores it in
 *   the same operation as the settle, keyed so a redelivery never
 *   forks the chain;
 * - `batch(items, { then, catch, finally })` hands every child and the
 *   finalizer that holds the callbacks to the adapter's flows capability in
 *   one call (1 to 1,000 children, or up to 100,000 `chunked` under a
 *   caller id that makes a failed call safe to re-issue).
 *
 * A flow call takes its job options and tags only: its key is the flow's,
 * and a time cannot be computed for a step enqueued later. A refused item
 * rejects the whole flow with `jobs.flow_item_refused` naming its index (the
 * steps or children from 0, then the chain's catch, or the batch's then,
 * catch and finally), with the item's own refusal as the cause.
 */

import { randomUUID } from 'node:crypto';

import { serializeContext } from 'jsails/context';

import {
  requireCapability,
  type BatchChildFailure,
  type BatchStatus,
  type DispatchOptions,
  type JobFlowStep,
  type JobHandle,
  type JobOptions,
  type JobOverlap,
  type JobsAdapter,
} from '../contract/index.js';
import { buildEnvelope, encodedSize } from '../envelope/codec.js';
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
import { JobsErrors } from '../errors/jobs-errors.js';
import { finalizerEnvelope, type FinalizerPayload } from '../flows/batch-finalizer.js';
import { stepEnvelope } from '../flows/chain-advance.js';
import {
  batchChildKey,
  chainStepKey,
  isFlowId,
  isReservedKey,
  MAX_BATCH_ITEMS,
  MAX_CHAIN_STEPS,
  MAX_CHILD_FAILURES,
  MAX_CHUNKED_BATCH_ITEMS,
  MAX_FLOW_BYTES,
} from '../flows/flow-limits.js';
import { overlapFor } from '../overlap/overlap-option.js';
import { DEFAULT_QUEUE } from '../queues/queue-set.js';
import { systemClock, type JobsClock } from '../timing/long-timer.js';
import type { JobCatalog } from './catalog.js';
import { jobSpec, type JobCall, type JobSpec } from './define-job.js';

/** Options of {@link Jobs.chain}. */
export interface ChainOptions {
  /** Enqueued once, as a callback of the chain, when a step fails for good. */
  readonly catch?: JobCall;
  /** The chain id; a reused id deduplicates the head step for a day. Defaults to a random UUID. */
  readonly id?: string;
}

/** What {@link Jobs.chain} returns: the head step's handle and the chain id. */
export interface ChainHandle extends JobHandle {
  readonly chain: string;
}

/** Options of {@link Jobs.batch}. */
export interface BatchOptions {
  /** Enqueued once when every child completed (or was discarded or skipped). */
  readonly then?: JobCall;
  /** Enqueued once when any child failed for good. */
  readonly catch?: JobCall;
  /** Enqueued once after `then` or `catch` is enqueued; it does not wait for it to run. */
  readonly finally?: JobCall;
  /** The batch id; re-issuing an id deduplicates. Defaults to a random UUID. */
  readonly id?: string;
  /** The declared queue the finalizer runs on. Defaults to `default`. */
  readonly queue?: string;
  /** Up to 100,000 children stored over several operations; needs an `id`. */
  readonly chunked?: boolean;
}

/** What {@link Jobs.batch} returns. */
export interface BatchHandle {
  readonly id: string;
  readonly total: number;
  /** True when a batch with this id was already stored and nothing was enqueued. */
  readonly deduplicated: boolean;
}

/** Dispatches jobs. */
export interface Jobs {
  /** Enqueue a typed call; options here override the call's own. */
  dispatch(call: JobCall, options?: DispatchOptions): Promise<JobHandle>;
  /** Enqueue a job by name with an unchecked payload, validated at runtime. */
  dispatchByName(name: string, payload: unknown, options?: DispatchOptions): Promise<JobHandle>;
  /**
   * Run the steps in order, each once the one before completed (or was
   * discarded). Every step is validated before the first is enqueued.
   */
  chain(steps: readonly [JobCall, ...JobCall[]], options?: ChainOptions): Promise<ChainHandle>;
  /**
   * Run the items in parallel; the callbacks fire once every item has a
   * final outcome. Every item is validated before any is enqueued. Needs an
   * adapter with flows.
   */
  batch(items: readonly JobCall[], options?: BatchOptions): Promise<BatchHandle>;
  /** The counts of batch `id`, or `undefined` when the transport holds none. */
  batchStatus(id: string): Promise<BatchStatus | undefined>;
  /** The failed children of batch `id` by ascending index: at most `limit` (1 to 100, default 100). */
  batchFailures(
    id: string,
    options?: { readonly limit?: number },
  ): Promise<readonly BatchChildFailure[]>;
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
}

const DISPATCH_OPTION_KEYS: ReadonlySet<string> = new Set([
  ...JOB_OPTION_KEYS,
  'delayMs',
  'runAt',
  'key',
  'keyWindowMs',
  'tags',
]);

/** What a call inside a flow may set: its job options and tags, never a time or a key. */
const FLOW_CALL_KEYS: ReadonlySet<string> = new Set([...JOB_OPTION_KEYS, 'tags']);

const CHAIN_OPTION_KEYS: ReadonlySet<string> = new Set(['catch', 'id']);
const BATCH_OPTION_KEYS: ReadonlySet<string> = new Set([
  'then',
  'catch',
  'finally',
  'id',
  'queue',
  'chunked',
]);
const BATCH_CALLBACKS = ['then', 'catch', 'finally'] as const;

type FlowRule =
  | 'shape'
  | 'empty'
  | 'too_many_steps'
  | 'too_many_items'
  | 'id'
  | 'chunked_id'
  | 'queue'
  | 'callback';

function refuse(option: string): Error {
  return new JobsErrors.Error('invalid_option', { option });
}

function invalidFlow(rule: FlowRule): Error {
  return new JobsErrors.Error('invalid_flow', { rule });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check one options record: an object of keys in `allowed`, or absent. A
 * dispatch option a flow call may not set is refused by name; anything else
 * unknown is `unknown_option`.
 */
function checkedOptions(value: unknown, allowed: ReadonlySet<string>): DispatchOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw refuse('options');
  for (const [key, entry] of Object.entries(value)) {
    if (allowed.has(key)) continue;
    if (!DISPATCH_OPTION_KEYS.has(key)) throw new JobsErrors.Error('unknown_option');
    if (entry !== undefined) throw refuse(key);
  }
  return value;
}

/** A flow's own options record, of keys in `allowed`, or absent. */
function flowOptions(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw refuse('options');
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  return value;
}

function flowId(value: unknown): string {
  if (value === undefined) return randomUUID();
  if (!isFlowId(value)) throw invalidFlow('id');
  return value;
}

function callback(value: unknown): JobCall | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidFlow('callback');
  return value as unknown as JobCall;
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
/** The epoch milliseconds a job may run from, or `undefined` for at once. */
function runAtOf(options: DispatchOptions, now: number): number | undefined {
  if (options.delayMs !== undefined && options.runAt !== undefined) {
    throw refuse('runAt');
  }
  if (options.delayMs !== undefined) {
    const delayMs = validDelay(options.delayMs);
    if (delayMs === undefined) throw refuse('delayMs');
    return delayMs === 0 ? undefined : now + delayMs;
  }
  if (options.runAt !== undefined) {
    const at: unknown = options.runAt;
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw refuse('runAt');
    const runAt = at.getTime();
    if (runAt - now > MAX_JOB_DELAY_MS) throw refuse('runAt');
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
    throw refuse(checked.problem);
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
      throw new JobsErrors.Error('invalid_option', { option: 'key' }, { cause: error });
    }
  }
  if (raw === undefined) {
    if (options.keyWindowMs !== undefined) throw refuse('keyWindowMs');
    return undefined;
  }
  const value = validKey(raw);
  // The reserved prefix holds the flow and schedule keys: a dispatch that
  // took one would swallow a chain step, a batch child or a callback.
  if (value === undefined || isReservedKey(value)) throw refuse('key');
  let windowMs = spec.keyWindowMs;
  if (options.keyWindowMs !== undefined) {
    const window = validDuration(options.keyWindowMs);
    if (window === undefined) throw refuse('keyWindowMs');
    windowMs = window;
  }
  return { value, windowMs };
}

/** A call validated and resolved, ready to become an envelope. */
interface PreparedCall {
  readonly spec: JobSpec;
  /** The validated plain-JSON snapshot of the payload: the schema input. */
  readonly snapshot: unknown;
  readonly options: JobOptions;
  readonly key: { readonly value: string; readonly windowMs: number } | undefined;
  readonly tags: readonly string[] | undefined;
  readonly runAt: number | undefined;
  readonly overlap: JobOverlap | undefined;
  /** The clock reading the run time was computed from. */
  readonly now: number;
}

/** The stored form of a prepared flow call. */
function stepOf(prepared: PreparedCall): JobFlowStep {
  return {
    queue: prepared.spec.queue,
    name: prepared.spec.name,
    payload: prepared.snapshot,
    options: prepared.options,
    ...(prepared.tags === undefined || prepared.tags.length === 0 ? {} : { tags: prepared.tags }),
    ...(prepared.overlap === undefined ? {} : { overlap: prepared.overlap }),
  };
}

class Producer implements JobProducer {
  readonly #catalog: JobCatalog;
  readonly #adapter: JobsAdapter;
  readonly #clock: JobsClock;
  #closed = false;

  constructor(options: ProducerOptions) {
    this.#catalog = options.catalog;
    this.#adapter = options.adapter;
    this.#clock = options.clock ?? systemClock;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }

  #open(): void {
    if (this.#closed) throw new JobsErrors.Error('producer_closed');
  }

  /** The spec of a call whose definition is the one the catalog registered under its name. */
  #registered(call: JobCall): JobSpec {
    const registered =
      typeof call === 'object' && call !== null ? this.#catalog.get(call.name) : undefined;
    if (registered === undefined || registered !== call.definition) {
      throw new JobsErrors.Error('unknown_job');
    }
    return jobSpec(registered);
  }

  async dispatch(call: JobCall, options?: DispatchOptions): Promise<JobHandle> {
    this.#open();
    return this.#dispatch(this.#registered(call), call.payload, [call.options, options]);
  }

  async dispatchByName(
    name: string,
    payload: unknown,
    options?: DispatchOptions,
  ): Promise<JobHandle> {
    this.#open();
    const registered = typeof name === 'string' ? this.#catalog.get(name) : undefined;
    if (registered === undefined) throw new JobsErrors.Error('unknown_job');
    return this.#dispatch(jobSpec(registered), payload, [options]);
  }

  async #dispatch(spec: JobSpec, payload: unknown, layers: readonly unknown[]): Promise<JobHandle> {
    const prepared = await this.#prepare(spec, payload, layers, DISPATCH_OPTION_KEYS);
    const context = serializeContext();
    this.#open();
    const envelope = buildEnvelope({
      name: spec.name,
      payload: prepared.snapshot,
      options: prepared.options,
      ...(prepared.key === undefined ? {} : { key: prepared.key }),
      ...(prepared.tags === undefined ? {} : { tags: prepared.tags }),
      ...(context === undefined ? {} : { context }),
      ...(prepared.overlap === undefined ? {} : { overlap: prepared.overlap }),
      ...(prepared.runAt === undefined ? {} : { runAt: prepared.runAt }),
      dispatchedAt: prepared.now,
    });
    return this.#adapter.enqueue(spec.queue, envelope);
  }

  /**
   * Validate one call: its options (keys in `allowed`), a plain-JSON snapshot
   * of its payload checked by the schema, and the key, run time and overlap
   * it stores. A flow call gets no key or run time: the flow sets the key.
   */
  async #prepare(
    spec: JobSpec,
    payload: unknown,
    layers: readonly unknown[],
    allowed: ReadonlySet<string>,
  ): Promise<PreparedCall> {
    const options: DispatchOptions = Object.assign(
      {},
      ...layers.map((layer) => definedEntries(checkedOptions(layer, allowed))),
    ) as DispatchOptions;
    const jobOptions = resolvedOptions(spec, options);
    const tags = options.tags === undefined ? undefined : validTags(options.tags);
    if (options.tags !== undefined && tags === undefined) {
      throw refuse('tags');
    }
    if (!isPlainJson(payload)) {
      throw new JobsErrors.Error('payload_not_json');
    }
    const snapshot = JSON.parse(JSON.stringify(payload)) as unknown;
    const parsed = await spec.schema.safeParseAsync(snapshot);
    if (!parsed.success) {
      throw new JobsErrors.Error('invalid_payload');
    }
    const dispatch = allowed === DISPATCH_OPTION_KEYS;
    const key = dispatch ? keyOf(spec, options, parsed.data) : undefined;
    const now = this.#clock.now();
    return {
      spec,
      snapshot,
      options: jobOptions,
      key,
      tags,
      runAt: dispatch ? runAtOf(options, now) : undefined,
      overlap:
        spec.overlap === undefined ? undefined : overlapFor(spec.overlap, spec.name, parsed.data),
      now,
    };
  }

  /**
   * Prepare every call of a flow at once. The lowest-numbered refusal
   * rejects the whole flow with `flow_item_refused`, its own error as the
   * cause, so nothing is enqueued.
   */
  async #prepareItems(
    calls: readonly (JobCall | undefined)[],
  ): Promise<(PreparedCall | undefined)[]> {
    const results = await Promise.allSettled(
      calls.map(async (call) =>
        call === undefined
          ? undefined
          : this.#prepare(this.#registered(call), call.payload, [call.options], FLOW_CALL_KEYS),
      ),
    );
    const prepared: (PreparedCall | undefined)[] = [];
    for (const [item, result] of results.entries()) {
      if (result.status === 'rejected') {
        throw new JobsErrors.Error('flow_item_refused', { item }, { cause: result.reason });
      }
      prepared.push(result.value);
    }
    return prepared;
  }

  async chain(
    steps: readonly [JobCall, ...JobCall[]],
    options?: ChainOptions,
  ): Promise<ChainHandle> {
    this.#open();
    if (!Array.isArray(steps)) throw invalidFlow('shape');
    if (steps.length === 0) throw invalidFlow('empty');
    if (steps.length > MAX_CHAIN_STEPS) throw invalidFlow('too_many_steps');
    const checked = flowOptions(options, CHAIN_OPTION_KEYS);
    const id = flowId(checked.id);
    const caught = callback(checked.catch);
    const prepared = await this.#prepareItems([...steps, caught]);
    const [head, ...next] = prepared.slice(0, steps.length).map((entry) => stepOf(entry!));
    const catchStep = prepared[steps.length];
    const context = serializeContext();
    this.#open();
    const envelope = stepEnvelope(head!, {
      key: chainStepKey(id, 0),
      flow: {
        kind: 'chain',
        id,
        step: 0,
        next,
        ...(catchStep === undefined ? {} : { catch: stepOf(catchStep) }),
      },
      context,
      dispatchedAt: this.#clock.now(),
    });
    if (encodedSize(envelope) > MAX_FLOW_BYTES) throw new JobsErrors.Error('flow_too_large');
    const handle = await this.#adapter.enqueue(head!.queue, envelope);
    return Object.freeze({ id: handle.id, deduplicated: handle.deduplicated, chain: id });
  }

  async batch(items: readonly JobCall[], options?: BatchOptions): Promise<BatchHandle> {
    this.#open();
    const flows = requireCapability(this.#adapter, 'flows');
    if (!Array.isArray(items)) throw invalidFlow('shape');
    const checked = flowOptions(options, BATCH_OPTION_KEYS);
    const { chunked } = checked;
    if (chunked !== undefined && typeof chunked !== 'boolean') throw refuse('chunked');
    if (items.length === 0) throw invalidFlow('empty');
    if (items.length > (chunked === true ? MAX_CHUNKED_BATCH_ITEMS : MAX_BATCH_ITEMS)) {
      throw invalidFlow('too_many_items');
    }
    if (chunked === true && checked.id === undefined) throw invalidFlow('chunked_id');
    const id = flowId(checked.id);
    const queue = checked.queue ?? DEFAULT_QUEUE;
    if (typeof queue !== 'string' || !this.#catalog.queues.has(queue)) throw invalidFlow('queue');
    const callbacks = BATCH_CALLBACKS.map((name) => callback(checked[name]));
    const prepared = await this.#prepareItems([...items, ...callbacks]);
    const context = serializeContext();
    const now = this.#clock.now();
    const children = prepared.slice(0, items.length).map((entry, index) => ({
      queue: entry!.spec.queue,
      envelope: stepEnvelope(stepOf(entry!), {
        key: batchChildKey(id, index),
        flow: { kind: 'batch', id, index },
        context,
        dispatchedAt: now,
      }),
    }));
    const payload: { -readonly [K in keyof FinalizerPayload]: FinalizerPayload[K] } = {
      id,
      total: items.length,
    };
    for (const [offset, name] of BATCH_CALLBACKS.entries()) {
      const entry = prepared[items.length + offset];
      if (entry !== undefined) payload[name] = stepOf(entry);
    }
    const finalizer = finalizerEnvelope(payload, context, now);
    if (encodedSize(finalizer) > MAX_FLOW_BYTES) throw new JobsErrors.Error('flow_too_large');
    this.#open();
    const { deduplicated } = await flows.enqueueBatch({
      id,
      children,
      finalizer: { queue, envelope: finalizer },
      chunked: chunked === true,
    });
    return Object.freeze({ id, total: items.length, deduplicated });
  }

  async batchStatus(id: string): Promise<BatchStatus | undefined> {
    this.#open();
    const flows = requireCapability(this.#adapter, 'flows');
    return isFlowId(id) ? flows.batchStatus(id) : undefined;
  }

  async batchFailures(
    id: string,
    options?: { readonly limit?: number },
  ): Promise<readonly BatchChildFailure[]> {
    this.#open();
    const flows = requireCapability(this.#adapter, 'flows');
    const checked = flowOptions(options, new Set(['limit']));
    const limit = checked.limit ?? MAX_CHILD_FAILURES;
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CHILD_FAILURES
    ) {
      throw refuse('limit');
    }
    return isFlowId(id) ? flows.childFailures(id, limit) : Object.freeze([]);
  }
}

/**
 * A producer over `adapter` for the jobs of `catalog`.
 *
 * @throws `jobs.capability_missing` when a job has overlap control and the
 *   adapter has no leases.
 */
export function createProducer(options: ProducerOptions): JobProducer {
  if (
    options.adapter.capabilities.leases === undefined &&
    options.catalog.definitions.some((definition) => jobSpec(definition).overlap !== undefined)
  ) {
    throw new JobsErrors.Error('capability_missing', { capability: 'leases' });
  }
  return new Producer(options);
}
