/**
 * Exclusive keyed locks held by in-memory transactions until they end.
 *
 * This is how the memory store models a database's row and unique-key locks:
 * a transaction acquires a key (a row, or a unique value it is inserting or
 * freeing) and keeps it until it commits or rolls back. A second transaction
 * that wants the same key waits for the holder to end, then re-reads the
 * committed state, which is what read committed does after a lock wait.
 *
 * A wait that would close a cycle of waiting transactions is refused at once
 * with `transaction_conflict`, as a database's deadlock detector does, and so
 * is a wait longer than the timeout.
 */

import { TenancyError } from './tenancy-error.js';

/** A transaction as the lock table sees it. */
export interface LockHolder {
  /** Settles when the transaction has ended and released its locks. */
  readonly ended: Promise<void>;
  /** The holder this transaction is waiting for, if any. */
  waitingFor: LockHolder | null;
}

/** The key of a lock: a table name followed by the parts of a row or unique key. */
export function lockKey(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

/** A table of exclusive locks. */
export class TransactionLocks {
  readonly #holders = new Map<string, LockHolder>();
  readonly #held = new Map<LockHolder, Set<string>>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
  }

  /** Acquire `key` for `holder`, waiting for its current holder to end. */
  async acquire(holder: LockHolder, key: string): Promise<void> {
    for (;;) {
      const current = this.#holders.get(key);
      if (current === undefined) {
        this.#holders.set(key, holder);
        const keys = this.#held.get(holder) ?? new Set<string>();
        keys.add(key);
        this.#held.set(holder, keys);
        return;
      }
      if (current === holder) {
        return;
      }
      const seen = new Set<LockHolder>();
      for (let waiter: LockHolder | null = current; waiter !== null; waiter = waiter.waitingFor) {
        if (waiter === holder || seen.has(waiter)) {
          throw new TenancyError('transaction_conflict');
        }
        seen.add(waiter);
      }
      holder.waitingFor = current;
      try {
        await this.#wait(current.ended);
      } finally {
        holder.waitingFor = null;
      }
    }
  }

  /** Release every lock `holder` acquired. */
  releaseAll(holder: LockHolder): void {
    for (const key of this.#held.get(holder) ?? []) {
      if (this.#holders.get(key) === holder) {
        this.#holders.delete(key);
      }
    }
    this.#held.delete(holder);
  }

  async #wait(ended: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TenancyError('transaction_conflict')), this.#timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([ended, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
