/**
 * The schedule ticker: fires stored schedules at their fire times over any
 * transport, through a small {@link ScheduleFiringPort}. The memory adapter
 * runs one on its own clock while a worker runs; a shared transport can run
 * one per process over a compare-and-set port, and the fire's key makes
 * racing tickers enqueue each fire once.
 *
 * Per unpaused record, the next fire time is the first one after
 * `through ?? anchor`. A fire time already past (nothing fired while it came
 * and went) fires at once, keyed by that first missed time, and moves
 * `through` to now, so every other missed time is coalesced into it. A
 * future one is waited for with a long timer on the clock; a wake that comes
 * early by the wall clock waits out the remainder.
 *
 * The ticker holds one timer per record and re-reads the records whenever
 * the port reports a change (an upsert, a removal, a pause or a resume). A
 * change reported while a read runs is read again as soon as that read
 * ends, never dropped, and a read that fails is tried again after
 * {@link FIRE_RETRY_MS}, so a store that was briefly unreachable never
 * leaves the ticker idle until the next change.
 */

import type { JobEnvelope, ScheduleSpec } from '../contract/index.js';
import { setLongTimeout, type JobsClock, type LongTimer } from '../timing/long-timer.js';
import { firedEnvelope, nextFireAfter } from './fire-times.js';

/** One stored schedule as a firing component reads it. */
export interface ScheduleRecord {
  readonly spec: ScheduleSpec;
  readonly paused: boolean;
  /** When the schedule was stored, or its repeat last changed. */
  readonly anchor: number;
  /** Every fire time at or before this was fired or skipped; `undefined` before the first fire. */
  readonly through: number | undefined;
  /** Changes whenever the record changes other than by a fire. */
  readonly revision: number;
}

/** The state a fire was computed from; a fire applies only while the record still has it. */
export interface FireExpectation {
  readonly revision: number;
  readonly through: number | undefined;
}

/** What a ticker needs from a transport. */
export interface ScheduleFiringPort {
  records(): readonly ScheduleRecord[] | Promise<readonly ScheduleRecord[]>;
  /**
   * Atomically: if record `id` is unpaused and still matches `expected`, set
   * its `through` and enqueue `envelope` on its queue (a taken key stores
   * nothing); resolve whether the record matched.
   */
  fire(
    id: string,
    expected: FireExpectation,
    through: number,
    envelope: JobEnvelope,
  ): boolean | Promise<boolean>;
  /** Call `listener` after every change to the records; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A running ticker. */
export interface ScheduleTicker {
  /** Cancel every timer and stop listening. Idempotent. */
  stop(): void;
}

/** How long a fire or a read the port refused with an error waits before it is tried again. */
export const FIRE_RETRY_MS = 5_000;

interface Armed {
  readonly record: ScheduleRecord;
  timer: LongTimer | undefined;
}

class Ticker implements ScheduleTicker {
  readonly #port: ScheduleFiringPort;
  readonly #clock: JobsClock;
  readonly #onError: (error: unknown) => void;
  readonly #armed = new Map<string, Armed>();
  readonly #unsubscribe: () => void;
  #stopped = false;
  #refreshing = false;
  /** A change was reported that no read has picked up yet. */
  #again = false;
  #retry: LongTimer | undefined;

  constructor(port: ScheduleFiringPort, clock: JobsClock, onError: (error: unknown) => void) {
    this.#port = port;
    this.#clock = clock;
    this.#onError = onError;
    this.#unsubscribe = port.subscribe(() => this.#refresh());
    this.#refresh();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe();
    this.#retry?.cancel();
    this.#retry = undefined;
    for (const armed of this.#armed.values()) armed.timer?.cancel();
    this.#armed.clear();
  }

  #refresh(): void {
    if (this.#stopped) return;
    this.#again = true;
    if (this.#refreshing) return;
    this.#refreshing = true;
    this.#retry?.cancel();
    this.#retry = undefined;
    this.#read().then(undefined, (error: unknown) => {
      this.#onError(error);
      if (this.#stopped) return;
      this.#retry = setLongTimeout(
        () => {
          this.#retry = undefined;
          this.#refresh();
        },
        FIRE_RETRY_MS,
        this.#clock,
      );
    });
  }

  /**
   * Read until no change is pending. `#refreshing` is cleared in the same
   * synchronous step as the last check of `#again`, so a change reported at
   * any moment either is seen by that check or starts a read of its own.
   */
  async #read(): Promise<void> {
    try {
      while (this.#again && !this.#stopped) {
        this.#again = false;
        const records = await this.#port.records();
        if (this.#stopped) return;
        this.#apply(records);
      }
    } finally {
      this.#refreshing = false;
    }
  }

  #apply(records: readonly ScheduleRecord[]): void {
    const seen = new Set<string>();
    for (const record of records) {
      const { id } = record.spec;
      seen.add(id);
      const current = this.#armed.get(id);
      if (
        current !== undefined &&
        !record.paused &&
        current.record.revision === record.revision &&
        current.record.through === record.through
      ) {
        continue;
      }
      this.#disarm(id);
      if (!record.paused) this.#arm(record);
    }
    for (const id of [...this.#armed.keys()]) if (!seen.has(id)) this.#disarm(id);
  }

  #disarm(id: string): void {
    this.#armed.get(id)?.timer?.cancel();
    this.#armed.delete(id);
  }

  #arm(record: ScheduleRecord): void {
    const armed: Armed = { record, timer: undefined };
    this.#armed.set(record.spec.id, armed);
    let slot: number;
    try {
      slot = nextFireAfter(record.spec.repeat, record.anchor, record.through ?? record.anchor);
    } catch (error) {
      this.#onError(error);
      return;
    }
    this.#wait(armed, slot);
  }

  #current(armed: Armed): boolean {
    return !this.#stopped && this.#armed.get(armed.record.spec.id) === armed;
  }

  #wait(armed: Armed, slot: number): void {
    const delay = slot - this.#clock.now();
    if (delay <= 0) {
      this.#fire(armed, slot);
      return;
    }
    armed.timer = setLongTimeout(
      () => {
        armed.timer = undefined;
        if (this.#current(armed)) this.#wait(armed, slot);
      },
      delay,
      this.#clock,
    );
  }

  #fire(armed: Armed, slot: number): void {
    const { record } = armed;
    const { id } = record.spec;
    const now = this.#clock.now();
    const expected: FireExpectation = { revision: record.revision, through: record.through };
    Promise.resolve()
      .then(() =>
        this.#port.fire(id, expected, now, firedEnvelope(record.spec.envelope, id, slot, now)),
      )
      .then(
        (fired) => {
          if (!this.#current(armed)) return;
          if (fired) {
            this.#arm({ ...record, through: now });
            return;
          }
          this.#disarm(id);
          this.#refresh();
        },
        (error: unknown) => {
          this.#onError(error);
          if (!this.#current(armed)) return;
          armed.timer = setLongTimeout(
            () => {
              armed.timer = undefined;
              if (this.#current(armed)) this.#fire(armed, slot);
            },
            FIRE_RETRY_MS,
            this.#clock,
          );
        },
      );
  }
}

/**
 * Fire the schedules of `port` on `clock` until stopped. Port errors and
 * fire times that cannot be computed go to `onError`.
 */
export function startScheduleTicker(
  port: ScheduleFiringPort,
  clock: JobsClock,
  onError: (error: unknown) => void,
): ScheduleTicker {
  return new Ticker(port, clock, onError);
}
