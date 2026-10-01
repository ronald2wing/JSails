/**
 * A FIFO counting semaphore with an acquire timeout and a close that rejects
 * every waiter. The engines use it as the connection budget of a server pool
 * (so the acquire timeout is the engine's, identical on both drivers) and, with
 * one permit, as SQLite's writer lock.
 */

import { DatabaseError } from './database-error.js';

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: DatabaseError) => void;
  timer: NodeJS.Timeout | undefined;
}

export class FifoLock {
  #available: number;
  readonly #waiters: Waiter[] = [];
  #closed = false;

  constructor(permits: number) {
    if (!Number.isSafeInteger(permits) || permits < 1) throw new RangeError('permits must be >= 1');
    this.#available = permits;
  }

  /** Permits currently free. */
  get available(): number {
    return this.#available;
  }

  /** Callers waiting for a permit. */
  get waiting(): number {
    return this.#waiters.length;
  }

  /**
   * Take a permit, waiting in arrival order. Rejects with `acquire_timeout`
   * after `timeoutMs` (0 waits forever) and with `closed` once closed.
   */
  acquire(timeoutMs: number): Promise<void> {
    if (this.#closed) return Promise.reject(new DatabaseError('closed'));
    if (this.#available > 0 && this.#waiters.length === 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: undefined };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) this.#waiters.splice(index, 1);
          reject(new DatabaseError('acquire_timeout'));
        }, timeoutMs);
      }
      this.#waiters.push(waiter);
    });
  }

  /** Return a permit; the longest waiter gets it. */
  release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#available += 1;
      return;
    }
    if (next.timer !== undefined) clearTimeout(next.timer);
    next.resolve();
  }

  /** Reject every waiter and every later acquire with `closed`. */
  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new DatabaseError('closed'));
    }
  }
}
