/**
 * The check every flow transport runs on a {@link BatchEnqueue} before it
 * stores anything, so the memory adapter and a shared transport refuse the
 * same batches with the same codes: the shape, the id, the child count for
 * the mode, each child decoded as a current-version envelope on a declared
 * queue and carrying its own batch membership at its position, and a
 * finalizer that is the built-in finalizer job with no key and no flow.
 */

import type { BatchEnqueue, JobEnvelope } from '../contract/index.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { BATCH_FINALIZER_JOB } from './batch-finalizer.js';
import { isFlowId, MAX_BATCH_ITEMS, MAX_CHUNKED_BATCH_ITEMS } from './flow-limits.js';

/** One checked batch member: a declared queue and its decoded envelope. */
export interface CheckedBatchMember {
  readonly queue: string;
  readonly envelope: JobEnvelope;
}

/** A checked {@link BatchEnqueue}. */
export interface CheckedBatch {
  readonly id: string;
  readonly children: readonly CheckedBatchMember[];
  readonly finalizer: CheckedBatchMember;
  readonly chunked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedMember(member: unknown, hasQueue: (queue: string) => boolean): CheckedBatchMember {
  if (!isRecord(member) || typeof member.queue !== 'string') {
    throw new JobsErrors.Error('invalid_flow', { rule: 'shape' });
  }
  if (!hasQueue(member.queue)) throw new JobsErrors.Error('unknown_queue');
  const decoded = decodeEnvelope(member.envelope);
  if (!decoded.ok) throw new JobsErrors.Error('invalid_envelope');
  return Object.freeze({ queue: member.queue, envelope: decoded.envelope });
}

/**
 * The checked form of `batch`.
 *
 * @throws `jobs.invalid_flow` naming `shape`, `id`, `empty` or
 *   `too_many_items`; `jobs.unknown_queue` for a member on a queue `hasQueue`
 *   refuses; `jobs.invalid_envelope` for a member that does not decode, a
 *   child whose batch membership is not its own, or a finalizer that is not
 *   the built-in one or carries a key or a flow.
 */
export function checkedBatch(
  batch: BatchEnqueue,
  hasQueue: (queue: string) => boolean,
): CheckedBatch {
  if (!isRecord(batch) || !Array.isArray(batch.children) || typeof batch.chunked !== 'boolean') {
    throw new JobsErrors.Error('invalid_flow', { rule: 'shape' });
  }
  const { id, children, chunked } = batch;
  if (!isFlowId(id)) throw new JobsErrors.Error('invalid_flow', { rule: 'id' });
  if (children.length === 0) throw new JobsErrors.Error('invalid_flow', { rule: 'empty' });
  if (children.length > (chunked ? MAX_CHUNKED_BATCH_ITEMS : MAX_BATCH_ITEMS)) {
    throw new JobsErrors.Error('invalid_flow', { rule: 'too_many_items' });
  }
  const checkedChildren = children.map((child, index) => {
    const member = checkedMember(child, hasQueue);
    const flow = member.envelope.meta.flow;
    if (flow?.kind !== 'batch' || flow.id !== id || flow.index !== index) {
      throw new JobsErrors.Error('invalid_envelope');
    }
    return member;
  });
  const finalizer = checkedMember(batch.finalizer, hasQueue);
  const { name, meta } = finalizer.envelope;
  if (name !== BATCH_FINALIZER_JOB || meta.key !== undefined || meta.flow !== undefined) {
    throw new JobsErrors.Error('invalid_envelope');
  }
  return Object.freeze({
    id,
    children: Object.freeze(checkedChildren),
    finalizer,
    chunked,
  });
}
