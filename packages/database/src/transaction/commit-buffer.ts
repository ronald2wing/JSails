/**
 * Commit buffers: items that must reach a consumer only once the work that
 * produced them committed, and never if it rolled back. The write pipeline's
 * change records are the consumer this exists for (DAT-08): a record added
 * inside a transaction follows its frame (merged into the parent when a
 * nested frame releases, dropped when it rolls back) and the consumer gets
 * every surviving item of one buffer in one batch after the outermost commit,
 * so it can coalesce them. Outside a transaction, or directly under a
 * `withTestTransaction` root (where app code runs as if in autocommit), an
 * item is delivered at once.
 *
 * Delivery after a commit runs where the transaction's afterCommit
 * callbacks do (with its scope removed, or inside a `withTestTransaction`
 * root), before them; a failure there is reported with theirs as
 * `transaction.after_commit_failed`.
 */

import type { Engine } from '../engine/contract.js';
import type { CommitSink } from './frame.js';
import { boundFrame } from './transaction-scope.js';

/** A buffer of items delivered after the transaction that produced them commits. */
export interface CommitBuffer<T> {
  /**
   * Add an item produced on `engine`: buffered in the current transaction
   * frame, or delivered now when there is none. Rejects with
   * `transaction.closed` (or `timeout`) from a transaction that ended, and
   * with the consumer's failure of an immediate delivery.
   */
  add(engine: Engine, item: T): Promise<void>;
}

class TransactionBuffer<T> implements CommitBuffer<T>, CommitSink {
  constructor(private readonly consumer: (items: readonly T[]) => unknown) {}

  async add(engine: Engine, item: T): Promise<void> {
    const frame = boundFrame(engine);
    frame?.assertLive();
    if (frame === undefined || frame.virtualRoot) {
      await this.consumer([item]);
      return;
    }
    frame.buffer(this, item);
  }

  deliver(items: readonly unknown[]): unknown {
    return this.consumer(items as readonly T[]);
  }
}

/** A commit buffer whose surviving items go to `consumer`, one batch per commit. */
export function createCommitBuffer<T>(consumer: (items: readonly T[]) => unknown): CommitBuffer<T> {
  return new TransactionBuffer(consumer);
}
