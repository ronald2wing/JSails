/**
 * The memory adapter's batch records: per batch, its total, its held
 * finalizer, and the first final outcome of each child, recorded once per
 * index in the same synchronous step as the child's settle. The record that
 * reaches the total settles the batch and hands back the finalizer, exactly
 * once. A retry of a failed child clears its index while the batch is
 * unsettled, and only counts `retriedAfterSettlement` once it settled.
 * Settled batches are swept {@link BATCH_STATUS_RETENTION_MS} after they
 * settled.
 */

import type { BatchChildFailure, BatchStatus, JobErrorSummary } from '../contract/index.js';
import { BATCH_STATUS_RETENTION_MS } from '../flows/flow-limits.js';

/** A child's recorded final outcome. */
export type RecordedOutcome =
  | { readonly kind: 'completed' | 'skipped' }
  | { readonly kind: 'failed'; readonly name: string; readonly error: JobErrorSummary };

interface BatchRecord<F> {
  readonly total: number;
  readonly finalizer: F;
  readonly recorded: Map<number, RecordedOutcome>;
  settled: boolean;
  settledAt: number;
  retriedAfterSettlement: number;
}

/** Batch records keyed by batch id; `F` is the adapter's stored finalizer. */
export class BatchStore<F> {
  readonly #batches = new Map<string, BatchRecord<F>>();
  #nextSweep = 0;

  /**
   * Store a new batch with the finalizer `store` returns, or tell whether
   * `id` is taken by a batch of the same or a different size (`store` is not
   * called then).
   */
  create(id: string, total: number, store: () => F): 'created' | 'exists' | 'conflict' {
    const existing = this.#batches.get(id);
    if (existing !== undefined) return existing.total === total ? 'exists' : 'conflict';
    this.#batches.set(id, {
      total,
      finalizer: store(),
      recorded: new Map(),
      settled: false,
      settledAt: 0,
      retriedAfterSettlement: 0,
    });
    return 'created';
  }

  /**
   * Record child `index`'s final outcome unless one is recorded; the
   * finalizer when this record settled the batch, else `undefined`.
   */
  record(id: string, index: number, outcome: RecordedOutcome, now: number): F | undefined {
    const batch = this.#batches.get(id);
    if (batch === undefined || index >= batch.total || batch.recorded.has(index)) return undefined;
    batch.recorded.set(index, outcome);
    // A settled batch has every index recorded, so only an unsettled one gets here.
    if (batch.recorded.size < batch.total) return undefined;
    batch.settled = true;
    batch.settledAt = now;
    return batch.finalizer;
  }

  /** A failed child of batch `id` was retried. */
  retried(id: string, index: number): void {
    const batch = this.#batches.get(id);
    if (batch === undefined) return;
    if (batch.settled) batch.retriedAfterSettlement += 1;
    else batch.recorded.delete(index);
  }

  status(id: string): BatchStatus | undefined {
    const batch = this.#batches.get(id);
    if (batch === undefined) return undefined;
    let completed = 0;
    let failed = 0;
    let skipped = 0;
    for (const outcome of batch.recorded.values()) {
      if (outcome.kind === 'completed') completed += 1;
      else if (outcome.kind === 'failed') failed += 1;
      else skipped += 1;
    }
    return Object.freeze({
      total: batch.total,
      completed,
      failed,
      skipped,
      pending: batch.total - batch.recorded.size,
      settled: batch.settled,
      retriedAfterSettlement: batch.retriedAfterSettlement,
    });
  }

  /** The failed children of batch `id` by ascending index, at most `limit`. */
  failures(id: string, limit: number): readonly BatchChildFailure[] {
    const batch = this.#batches.get(id);
    if (batch === undefined) return Object.freeze([]);
    const failures: BatchChildFailure[] = [];
    for (const [index, outcome] of [...batch.recorded].sort(([a], [b]) => a - b)) {
      if (failures.length >= limit) break;
      if (outcome.kind === 'failed') {
        failures.push(Object.freeze({ index, name: outcome.name, error: outcome.error }));
      }
    }
    return Object.freeze(failures);
  }

  /** Drop batches settled longer ago than the retention, at most once per second of clock time. */
  sweep(now: number): void {
    if (now < this.#nextSweep) return;
    this.#nextSweep = now + 1_000;
    for (const [id, batch] of this.#batches) {
      if (batch.settled && now - batch.settledAt > BATCH_STATUS_RETENTION_MS) {
        this.#batches.delete(id);
      }
    }
  }
}
