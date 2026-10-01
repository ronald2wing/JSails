/**
 * Timers that hold any delay. Node clamps a `setTimeout` above 2^31-1 ms
 * (about 24.8 days) to 1 ms, so a 30-day job delay or schedule interval would
 * fire at once and then every millisecond. {@link setLongTimeout} splits a long
 * wait into chunks no longer than that limit and counts each chunk off as it
 * elapses, so it fires once, after the whole delay.
 *
 * Chunks are counted rather than compared with a wall clock: Node timers run
 * on the monotonic clock, so a wall-clock step (NTP, a suspended laptop) never
 * shortens or stretches the wait, and a fake clock that only moves when a test
 * advances it sees exactly the delay it was given.
 *
 * Everything time-dependent in the jobs package reads time through a
 * {@link JobsClock}, so the memory adapter can run on the system clock in an
 * app and on a virtual clock in a test.
 */

import { JobsErrors } from '../errors/jobs-errors.js';

/** The longest delay a Node timer holds without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A pending timer started on a {@link JobsClock}. */
export interface ClockTimer {
  cancel(): void;
}

/** The time source of the jobs package. */
export interface JobsClock {
  /** Epoch milliseconds. */
  now(): number;
  /** Run `callback` once after `ms` (at most {@link MAX_TIMER_DELAY_MS}). */
  setTimer(callback: () => void, ms: number): ClockTimer;
}

/** The process clock: `Date.now()` and Node timers. */
export const systemClock: JobsClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (callback: () => void, ms: number): ClockTimer => {
    const handle = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(handle) };
  },
});

/** A pending long timer. */
export interface LongTimer {
  /** Stop the timer; the callback will not run. Idempotent. */
  cancel(): void;
  /** Whether the callback ran or the timer was cancelled. */
  readonly done: boolean;
}

/**
 * Run `callback` once after `ms` milliseconds, however long that is.
 *
 * @throws `jobs.invalid_delay` when `ms` is negative, fractional, or not a safe integer.
 */
export function setLongTimeout(
  callback: () => void,
  ms: number,
  clock: JobsClock = systemClock,
): LongTimer {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new JobsErrors.Error('invalid_delay');
  let remaining = ms;
  let current: ClockTimer | undefined;
  let done = false;
  const arm = (): void => {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS);
    current = clock.setTimer(() => {
      remaining -= chunk;
      if (done) return;
      if (remaining > 0) {
        arm();
        return;
      }
      done = true;
      current = undefined;
      callback();
    }, chunk);
  };
  arm();
  return {
    cancel() {
      if (done) return;
      done = true;
      current?.cancel();
      current = undefined;
    },
    get done() {
      return done;
    },
  };
}

/**
 * Run `callback` every `everyMs` milliseconds, each wait a
 * {@link setLongTimeout}, so a 30-day interval fires once every 30 days.
 * The next wait starts when the callback is called, not when it finishes.
 *
 * @throws `jobs.invalid_delay` when `everyMs` is not a positive safe integer.
 */
export function setLongInterval(
  callback: () => void,
  everyMs: number,
  clock: JobsClock = systemClock,
): LongTimer {
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0) throw new JobsErrors.Error('invalid_delay');
  let done = false;
  let current: LongTimer;
  const arm = (): void => {
    current = setLongTimeout(
      () => {
        arm();
        callback();
      },
      everyMs,
      clock,
    );
  };
  arm();
  return {
    cancel() {
      if (done) return;
      done = true;
      current.cancel();
    },
    get done() {
      return done;
    },
  };
}
