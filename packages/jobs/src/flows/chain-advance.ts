/**
 * Chains in the worker. A chain step's envelope carries the steps after it
 * and the catch call, so the processor that settles a step builds the next
 * one (or the catch) itself, over any transport, as a follow-up the adapter
 * stores in the same operation that settles the step. Its key makes the
 * enqueue once-only: a redelivered step deduplicates instead of forking the
 * chain, and a step retried after a final failure continues it.
 *
 * Whether the chain's catch already fired travels with the chain: a step
 * built after a step whose catch fired (one an operator force-retried)
 * carries `catchFired` too, so a later final failure never fires the catch a
 * second time, however long after the first it comes.
 *
 * Every follow-up carries the execution context the chain was dispatched
 * with. Its queue must be one this worker declares ({@link chainQueuesDeclared}):
 * a step whose follow-up names a queue it does not know comes from a newer
 * release, and the processor leaves it to a worker that knows the queue
 * before running it.
 */

import type {
  JobEnvelope,
  JobFlowMembership,
  JobFlowStep,
  JobFollowUp,
} from '../contract/index.js';
import { buildEnvelope, decodeEnvelope } from '../envelope/codec.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import type { QueueSet } from '../queues/queue-set.js';
import { chainCatchKey, chainStepKey, FLOW_KEY_WINDOW_MS } from './flow-limits.js';

/** The parts a stored step needs to become an envelope. */
export interface StepParts {
  readonly key: string;
  readonly flow: JobFlowMembership;
  readonly context: unknown;
  readonly dispatchedAt: number;
}

type ChainMembership = Extract<JobFlowMembership, { readonly kind: 'chain' }>;

/** The envelope of a stored flow member, keyed for {@link FLOW_KEY_WINDOW_MS}. */
export function stepEnvelope(step: JobFlowStep, parts: StepParts): JobEnvelope {
  return buildEnvelope({
    name: step.name,
    payload: step.payload,
    options: step.options,
    key: { value: parts.key, windowMs: FLOW_KEY_WINDOW_MS },
    ...(step.tags === undefined ? {} : { tags: step.tags }),
    ...(parts.context === undefined ? {} : { context: parts.context }),
    ...(step.overlap === undefined ? {} : { overlap: step.overlap }),
    flow: parts.flow,
    dispatchedAt: parts.dispatchedAt,
  });
}

/** A stored member as the follow-up that enqueues it on its queue. */
export function stepFollowUp(step: JobFlowStep, parts: StepParts): JobFollowUp {
  return Object.freeze({ queue: step.queue, envelope: stepEnvelope(step, parts) });
}

function chainOf(envelope: JobEnvelope): ChainMembership | undefined {
  const flow = envelope.meta.flow;
  return flow?.kind === 'chain' ? flow : undefined;
}

/**
 * Whether this worker declares every queue a settle of this job may enqueue
 * on: the next step's and the catch's. True for a job that is no chain step.
 */
export function chainQueuesDeclared(envelope: JobEnvelope, queues: Pick<QueueSet, 'has'>): boolean {
  const chain = chainOf(envelope);
  if (chain === undefined) return true;
  const next = chain.next[0];
  return (
    (next === undefined || queues.has(next.queue)) &&
    (chain.catch === undefined || queues.has(chain.catch.queue))
  );
}

/**
 * The step after this one, keyed `jsails:chain:<id>:<step + 1>`, carrying the
 * rest of the chain, its catch, and `catchFired` when this step has it;
 * `undefined` after the last step or for a job that is no chain step.
 */
export function chainAdvance(envelope: JobEnvelope, now: number): JobFollowUp | undefined {
  const chain = chainOf(envelope);
  const [next, ...rest] = chain?.next ?? [];
  if (chain === undefined || next === undefined) return undefined;
  const step = chain.step + 1;
  return stepFollowUp(next, {
    key: chainStepKey(chain.id, step),
    flow: {
      kind: 'chain',
      id: chain.id,
      step,
      next: rest,
      ...(chain.catch === undefined ? {} : { catch: chain.catch }),
      ...(chain.catchFired === true ? { catchFired: true as const } : {}),
    },
    context: envelope.meta.context,
    dispatchedAt: now,
  });
}

/**
 * The chain's catch, keyed `jsails:chain:<id>:catch`, as a callback of the
 * chain; `undefined` for a chain without one, one whose catch already fired,
 * or a job that is no chain step.
 */
export function chainCatch(envelope: JobEnvelope, now: number): JobFollowUp | undefined {
  const chain = chainOf(envelope);
  if (chain?.catch === undefined || chain.catchFired === true) return undefined;
  return stepFollowUp(chain.catch, {
    key: chainCatchKey(chain.id),
    flow: { kind: 'callback', flow: 'chain', id: chain.id, callback: 'catch' },
    context: envelope.meta.context,
    dispatchedAt: now,
  });
}

/**
 * A copy of a chain step's envelope with `meta.flow.catchFired` set, for an
 * adapter that settles a final failure whose outcome says the catch fired.
 *
 * @throws `jobs.invalid_envelope` for an envelope that is not a chain step.
 */
export function withCatchFired(envelope: JobEnvelope): JobEnvelope {
  const decoded = decodeEnvelope(envelope);
  const chain = decoded.ok ? chainOf(decoded.envelope) : undefined;
  if (!decoded.ok || chain === undefined) throw new JobsErrors.Error('invalid_envelope');
  const { meta } = decoded.envelope;
  return Object.freeze({
    ...decoded.envelope,
    meta: Object.freeze({ ...meta, flow: Object.freeze({ ...chain, catchFired: true as const }) }),
  });
}
