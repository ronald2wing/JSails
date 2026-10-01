/**
 * The batch finalizer: a reserved built-in job, `jsails.batch`, that every
 * worker runs without it being registered in any catalog. The transport holds
 * it until every child of its batch has a recorded final outcome, then makes
 * it runnable once; it reads the batch status and completes with `then` (no
 * child failed) or `catch` (one did), then `finally`, as follow-ups keyed
 * `jsails:batch:<id>:<callback>`. The adapter stores them in the operation
 * that completes the finalizer, so they go out together or not at all: a
 * finalizer that failed stored none, and a retry of it, however late, stores
 * each callback once.
 *
 * The callbacks live in the finalizer's payload, in the transport, so they
 * fire after a producer restart. `finally` is enqueued with `then` or
 * `catch` but does not wait for it to run: work that must follow `then`
 * belongs in `then`, or in a chain `then` starts. The finalizer runs no user
 * code, so it needs no attempt, signal or context restore. A callback on a
 * queue this worker does not declare comes from a newer release: the
 * finalizer is then left, unrun, to a worker that knows the queue.
 */

import type {
  AttemptOutcome,
  JobEnvelope,
  JobErrorSummary,
  JobFlowStep,
  JobFollowUp,
  JobOptions,
  JobsAdapter,
} from '../contract/index.js';
import { buildEnvelope, decodeFlowStep } from '../envelope/codec.js';
import { runtimeSummary, summarizeJobError, type SummaryOptions } from '../errors/error-summary.js';
import type { QueueSet } from '../queues/queue-set.js';
import type { JobsClock } from '../timing/long-timer.js';
import { stepFollowUp } from './chain-advance.js';
import { batchCallbackKey, isFlowId, MAX_CHUNKED_BATCH_ITEMS } from './flow-limits.js';

/** The reserved name of the batch finalizer job. */
export const BATCH_FINALIZER_JOB = 'jsails.batch';

/** The finalizer's options: ten attempts, backing off exponentially from 1 s. */
export const FINALIZER_OPTIONS: JobOptions = Object.freeze({
  attempts: 10,
  backoff: Object.freeze({ type: 'exponential', delayMs: 1_000 }),
});

/** What a finalizer carries: its batch and the callbacks to enqueue. */
export interface FinalizerPayload {
  readonly id: string;
  readonly total: number;
  readonly then?: JobFlowStep;
  readonly catch?: JobFlowStep;
  readonly finally?: JobFlowStep;
}

type CallbackName = 'then' | 'catch' | 'finally';

const CALLBACKS: readonly CallbackName[] = ['then', 'catch', 'finally'];
const PAYLOAD_KEYS: ReadonlySet<string> = new Set(['id', 'total', ...CALLBACKS]);

/** The finalizer envelope of a batch: no key and no flow, carrying the batch's context. */
export function finalizerEnvelope(
  payload: FinalizerPayload,
  context: unknown,
  now: number,
): JobEnvelope {
  return buildEnvelope({
    name: BATCH_FINALIZER_JOB,
    payload,
    options: FINALIZER_OPTIONS,
    ...(context === undefined ? {} : { context }),
    dispatchedAt: now,
  });
}

/** Read a stored finalizer payload strictly; `undefined` for anything else. Never throws. */
export function decodeFinalizerPayload(value: unknown): FinalizerPayload | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => PAYLOAD_KEYS.has(key))) return undefined;
  const { id, total } = record;
  if (!isFlowId(id)) return undefined;
  if (
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > MAX_CHUNKED_BATCH_ITEMS
  ) {
    return undefined;
  }
  const payload: { -readonly [K in keyof FinalizerPayload]: FinalizerPayload[K] } = { id, total };
  for (const name of CALLBACKS) {
    if (!(name in record)) continue;
    const step = decodeFlowStep(record[name]);
    if (step === undefined) return undefined;
    payload[name] = step;
  }
  return Object.freeze(payload);
}

/** What {@link runBatchFinalizer} reads. */
export interface FinalizerInput {
  readonly envelope: JobEnvelope;
  readonly transport: Pick<JobsAdapter, 'capabilities'>;
  /** The worker's declared queues. */
  readonly queues: Pick<QueueSet, 'has'>;
  readonly clock: JobsClock;
  readonly summaryOptions: SummaryOptions;
  /** The outcome when a callback names a queue this worker does not declare: the processor's skew release. */
  readonly skew: AttemptOutcome;
}

function failed(error: JobErrorSummary, retryable: boolean): AttemptOutcome {
  return Object.freeze({ kind: 'failed', error, retryable });
}

const COMPLETED: AttemptOutcome = Object.freeze({ kind: 'completed' });

/**
 * Run one finalizer attempt. Total: every failure is an outcome. A missing
 * flows capability or a malformed payload fails for good; a batch record
 * that is gone fails for good, one not yet settled (a transport bug time may
 * cure) and any transport error are retried. Nothing is enqueued here: the
 * callbacks are the completed outcome's follow-ups.
 */
export async function runBatchFinalizer(input: FinalizerInput): Promise<AttemptOutcome> {
  const { envelope, transport, summaryOptions } = input;
  const flows = transport.capabilities.flows;
  if (flows === undefined) return failed(runtimeSummary('capability_missing'), false);
  const payload = decodeFinalizerPayload(envelope.payload);
  if (payload === undefined) return failed(runtimeSummary('invalid_envelope'), false);
  let decided: CallbackName;
  try {
    const status = await flows.batchStatus(payload.id);
    if (status === undefined) return failed(runtimeSummary('flow_missing'), false);
    if (!status.settled) return failed(runtimeSummary('flow_missing'), true);
    decided = status.failed > 0 ? 'catch' : 'then';
  } catch (error) {
    const { summary, retryable } = summarizeJobError(error, summaryOptions);
    return failed(summary, retryable);
  }
  const steps: [CallbackName, JobFlowStep][] = [];
  for (const name of [decided, 'finally'] as const) {
    const step = payload[name];
    if (step !== undefined) steps.push([name, step]);
  }
  if (steps.some(([, step]) => !input.queues.has(step.queue))) return input.skew;
  if (steps.length === 0) return COMPLETED;
  const now = input.clock.now();
  const followUps: JobFollowUp[] = steps.map(([name, step]) =>
    stepFollowUp(step, {
      key: batchCallbackKey(payload.id, name),
      flow: { kind: 'callback', flow: 'batch', id: payload.id, callback: name },
      context: envelope.meta.context,
      dispatchedAt: now,
    }),
  );
  return Object.freeze({ kind: 'completed', followUps: Object.freeze(followUps) });
}
