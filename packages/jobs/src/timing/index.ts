/**
 * Time for the jobs package: the clock seam and timers that hold delays
 * longer than a Node timer can.
 */

export {
  LongTimerError,
  MAX_TIMER_DELAY_MS,
  setLongInterval,
  setLongTimeout,
  systemClock,
  type ClockTimer,
  type JobsClock,
  type LongTimer,
} from './long-timer.js';
