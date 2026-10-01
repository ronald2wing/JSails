/**
 * Batches on the Valkey transport, kept in the transport's own records.
 *
 * A batch is one record hash (total, counts, staged, settled and released
 * flags, the finalizer's queue, id and envelope) plus a hash of each child's
 * first final outcome by index and a sorted set of the failed indexes. The
 * record's finalizer id (`b<digest of the batch id>.<incarnation>`, see
 * `key-layout.ts`) names its incarnation: drawn when the record is created,
 * it is part of every child's job id, so a batch id issued again after its
 * record expired stores fresh jobs rather than meet jobs BullMQ still keeps
 * from before, and a child of an earlier incarnation (a retry of a failed
 * one, say) never records into a later one. The finalizer is not stored
 * while the batch runs: the record that settles the batch hands it back, and
 * the settling worker stores it under the record's finalizer id, so it runs
 * once whichever process settled the batch, and a redelivered child, finding
 * the batch settled and the finalizer not yet marked stored, stores it again
 * under the same id, which stores nothing twice.
 *
 * - `enqueueBatch` claims the record (new, the same batch again, or a
 *   conflict on a different total), then adds the children under fixed ids
 *   (`<finalizer id>.<index>`) by chunks of up to 1,000, each chunk one
 *   transaction across its queues (BullMQ's flow producer with no parent),
 *   raising the record's stored count after each chunk. A batch issued again
 *   resumes from that count and skips children already recorded, so a
 *   producer that died mid-batch loses nothing and runs nothing twice.
 *   Children carry no deduplication key: BullMQ's add under an id that exists
 *   stores nothing, and the batch record keeps a child's first outcome, so a
 *   child is counted once.
 * - A batch that is not chunked is one chunk, so its children are stored in
 *   one transaction, or none are. Its record is created staged: hidden from
 *   `batchStatus` and expiring, as a settled record does, unless the chunk is
 *   found stored (the stored count reaching the total, or a child recording
 *   an outcome, which proves the transaction applied). A failure between the
 *   claim and the transaction leaves no runnable child and a record that
 *   lapses; the same id issued again stores the batch as new.
 * - A child's outcome is recorded in one script, `HSETNX` on its index, by
 *   the worker that settles it (see `ValkeyWorker`); the record that reaches
 *   the total settles the batch and starts the 7-day retention of all three
 *   keys.
 * - `batchStatus` is one read of the record whatever the batch's size.
 * - Retrying a failed child takes its failure back while the batch is
 *   unsettled (and restores it should the retry not happen), and counts
 *   `retriedAfterSettlement` once the batch settled, which never releases
 *   the finalizer again.
 */

import type {
  BatchChildFailure,
  BatchEnqueue,
  BatchStatus,
  FlowTransport,
  JobEnvelope,
  QueueDeclaration,
} from '../contract/index.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { checkedBatch, type CheckedBatchMember } from '../flows/batch-check.js';
import {
  BATCH_STATUS_RETENTION_MS,
  isFlowId,
  MAX_BATCH_ITEMS,
  MAX_CHILD_FAILURES,
} from '../flows/flow-limits.js';
import type { BullFlowJob, BullFlowProducer, BullQueue } from './bullmq-surface.js';
import { decodeFailure } from './failure-record.js';
import { addOptionsOf } from './job-mapping.js';
import { childJobId, finalizerJobId, newBatchIncarnation, type KeyLayout } from './key-layout.js';
import { guarded } from './transport-error.js';
import type { ValkeyScripts } from './valkey-scripts.js';
import type { BatchMembership } from './valkey-worker.js';

/** What the batches need from their adapter. */
export interface BatchHost {
  readonly scripts: ValkeyScripts;
  readonly layout: KeyLayout;
  hasQueue(queue: string): boolean;
  /** The declaration of `queue`, or the defaults for a queue this process does not declare. */
  declaration(queue: string): QueueDeclaration;
  queue(name: string): BullQueue;
  /** The producer that stores a chunk of children in one transaction. */
  readonly flows: BullFlowProducer;
  /** @throws `jobs.adapter_closed` once the adapter closed. */
  assertOpen(): void;
}

/** How a retry of a batch child found its batch. */
export type RetryPreparation =
  | { readonly kind: 'none' }
  | { readonly kind: 'settled'; readonly batch: BatchMembership }
  | { readonly kind: 'unrecorded'; readonly batch: BatchMembership; readonly value: string };

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/**
 * How long a staged record lives unless its children are found stored: the
 * retention of a settled record, past the latest time a child may first run,
 * so a record whose stored mark was lost outlives the wait for its first
 * child to record.
 */
function stagedRecordTtlMs(children: readonly CheckedBatchMember[], now: number): number {
  let wait = 0;
  for (const { envelope } of children) {
    const { runAt } = envelope.meta;
    if (runAt !== undefined) wait = Math.max(wait, runAt - now);
  }
  return BATCH_STATUS_RETENTION_MS + Math.ceil(wait);
}

/** The batches of one adapter. */
export class ValkeyBatches implements FlowTransport {
  readonly #host: BatchHost;

  constructor(host: BatchHost) {
    this.#host = host;
  }

  #keys(id: string): [string, string, string] {
    const record = this.#host.layout.batchRecord(id);
    return [record, `${record}:r`, `${record}:f`];
  }

  async enqueueBatch(batch: BatchEnqueue): Promise<{ readonly deduplicated: boolean }> {
    this.#host.assertOpen();
    const { id, children, finalizer, chunked } = checkedBatch(batch, (queue) =>
      this.#host.hasQueue(queue),
    );
    const [record, results] = this.#keys(id);
    const claim = asArray(
      await guarded(() =>
        this.#host.scripts.batchClaim.run(
          [record],
          [
            children.length,
            finalizer.queue,
            JSON.stringify(finalizer.envelope),
            finalizerJobId(id, newBatchIncarnation()),
            chunked ? '0' : '1',
            stagedRecordTtlMs(children, Date.now()),
          ],
        ),
      ),
    );
    const state = asText(claim[0]);
    if (state === 'conflict') throw new JobsErrors.Error('flow_conflict');
    // The record's own finalizer id: a batch issued again keeps its incarnation.
    const finalizerId = asText(claim[2]);
    const resumed = state !== 'new';
    let stored = Number(asText(claim[1]));
    while (stored < children.length) {
      const end = Math.min(stored + MAX_BATCH_ITEMS, children.length);
      await this.#storeChunk(finalizerId, results, children, stored, end, resumed);
      await guarded(() => this.#host.scripts.batchStored.run([record], [end]));
      stored = end;
    }
    // A staged record was never known stored, so issuing it again stored it as new.
    return Object.freeze({ deduplicated: state === 'exists' });
  }

  /** Add children `start` to `end` in one transaction; a resumed chunk skips recorded children. */
  async #storeChunk(
    finalizerId: string,
    results: string,
    children: readonly CheckedBatchMember[],
    start: number,
    end: number,
    resumed: boolean,
  ): Promise<void> {
    let skip: readonly unknown[] = [];
    if (resumed) {
      const indexes = Array.from({ length: end - start }, (_, offset) => start + offset);
      skip = asArray(await guarded(() => this.#host.scripts.batchRecorded.run([results], indexes)));
    }
    const now = Date.now();
    const jobs: BullFlowJob[] = [];
    for (let index = start; index < end; index += 1) {
      if (asText(skip[index - start]) === '1') continue;
      const { queue, envelope } = children[index]!;
      const options = addOptionsOf(
        envelope,
        this.#host.declaration(queue),
        childJobId(finalizerId, index),
        now,
        false,
      );
      jobs.push({ queueName: queue, name: envelope.name, data: envelope, opts: options });
    }
    if (jobs.length > 0) await guarded(() => this.#host.flows.addBulk(jobs));
  }

  async batchStatus(id: string): Promise<BatchStatus | undefined> {
    if (!isFlowId(id)) return undefined;
    const [record] = this.#keys(id);
    const reply = asArray(await guarded(() => this.#host.scripts.batchStatus.run([record], [])));
    if (reply.length === 0) return undefined;
    const [total, completed, failed, skipped, recorded, settled, retried] = reply.map((value) =>
      Number(asText(value) || '0'),
    ) as [number, number, number, number, number, number, number];
    return Object.freeze({
      total,
      completed,
      failed,
      skipped,
      pending: total - recorded,
      settled: settled === 1,
      retriedAfterSettlement: retried,
    });
  }

  async childFailures(id: string, limit: number): Promise<readonly BatchChildFailure[]> {
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CHILD_FAILURES
    ) {
      throw new JobsErrors.Error('invalid_option', { option: 'limit' });
    }
    if (!isFlowId(id)) return Object.freeze([]);
    const [, results, failures] = this.#keys(id);
    const reply = asArray(
      await guarded(() => this.#host.scripts.batchFailures.run([failures, results], [limit])),
    );
    const out: BatchChildFailure[] = [];
    for (let i = 0; i + 1 < reply.length; i += 2) {
      const { name, error } = decodeFailure(asText(reply[i + 1]));
      out.push(Object.freeze({ index: Number(asText(reply[i])), name: name ?? '', error }));
    }
    return Object.freeze(out);
  }

  /**
   * Record a child's final outcome, and store the finalizer when the batch
   * is settled and its finalizer not yet stored.
   */
  async recordChild(batch: BatchMembership, value: string): Promise<void> {
    const keys = this.#keys(batch.id);
    const reply = asArray(
      await guarded(() =>
        this.#host.scripts.batchRecord.run(keys, [
          batch.index,
          value,
          Date.now(),
          BATCH_STATUS_RETENTION_MS,
          batch.finalizerId,
        ]),
      ),
    );
    if (reply[0] !== 1) return;
    const queue = asText(reply[1]);
    const envelope = JSON.parse(asText(reply[2])) as JobEnvelope;
    const finalizerId = asText(reply[3]);
    const options = addOptionsOf(
      envelope,
      this.#host.declaration(queue),
      finalizerId,
      Date.now(),
      false,
    );
    await guarded(() => this.#host.queue(queue).add(envelope.name, envelope, options));
    await guarded(() => this.#host.scripts.batchReleased.run([keys[0]], []));
  }

  /** Before a failed child is retried. */
  async prepareRetry(batch: BatchMembership | undefined): Promise<RetryPreparation> {
    if (batch === undefined) return { kind: 'none' };
    const reply = asArray(
      await guarded(() =>
        this.#host.scripts.batchUnrecord.run(this.#keys(batch.id), [
          batch.index,
          batch.finalizerId,
        ]),
      ),
    );
    const state = asText(reply[0]);
    if (state === 'settled') return { kind: 'settled', batch };
    if (state === 'unrecorded') return { kind: 'unrecorded', batch, value: asText(reply[1]) };
    return { kind: 'none' };
  }

  /** After a retry: count it on a settled batch, or restore the failure when it did not happen. */
  async finishRetry(preparation: RetryPreparation, retried: boolean): Promise<void> {
    if (preparation.kind === 'settled' && retried) {
      const [record] = this.#keys(preparation.batch.id);
      await guarded(() =>
        this.#host.scripts.batchRetried.run([record], [preparation.batch.finalizerId]),
      );
    } else if (preparation.kind === 'unrecorded' && !retried) {
      await this.recordChild(preparation.batch, preparation.value);
    }
  }
}
