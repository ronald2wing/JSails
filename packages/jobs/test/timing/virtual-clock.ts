/**
 * A {@link JobsClock} whose time only moves when a test advances it. Timers
 * fire in due order with the clock set to their due time, so a timer armed
 * inside another one starts from the right instant. Like a Node timer, it
 * refuses a delay longer than {@link MAX_TIMER_DELAY_MS}, so code that should
 * have chunked a long wait fails loudly here instead of firing early.
 */

import {
  MAX_TIMER_DELAY_MS,
  type ClockTimer,
  type JobsClock,
} from '../../src/timing/long-timer.js';

interface Pending {
  readonly at: number;
  readonly order: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class VirtualClock implements JobsClock {
  #now: number;
  #order = 0;
  readonly #pending: Pending[] = [];
  /** Every delay a timer was armed with, in arming order. */
  readonly armed: number[] = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimer(callback: () => void, ms: number): ClockTimer {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIMER_DELAY_MS) {
      throw new RangeError('a virtual timer delay must be an integer within the Node timer limit');
    }
    this.armed.push(ms);
    this.#order += 1;
    const pending: Pending = { at: this.#now + ms, order: this.#order, callback, cancelled: false };
    this.#pending.push(pending);
    return {
      cancel: () => {
        pending.cancelled = true;
      },
    };
  }

  /** Timers armed and not yet fired or cancelled. */
  get pending(): number {
    return this.#pending.filter((timer) => !timer.cancelled).length;
  }

  /**
   * Move time forward by `ms`, firing every timer that falls due on the way.
   * `between` runs after each fired timer, so a test can let promise
   * reactions a timer started run before time moves on.
   */
  async advance(ms: number, between: () => Promise<void> = flush): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const next = this.#pending
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (next === undefined) break;
      this.#pending.splice(this.#pending.indexOf(next), 1);
      this.#now = next.at;
      next.callback();
      await between();
    }
    this.#now = target;
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      if (this.#pending[index]!.cancelled) this.#pending.splice(index, 1);
    }
  }
}

/** Let queued microtasks and immediates run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
