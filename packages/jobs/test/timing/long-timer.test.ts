/**
 * Long timers: a delay or interval longer than a Node timer can hold fires
 * once at the right time, under Node's own fake timers and under the
 * package's clock seam, and never arms a Node timer above its limit.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { JobsErrors } from '../../src/errors/jobs-errors.js';
import {
  MAX_TIMER_DELAY_MS,
  setLongInterval,
  setLongTimeout,
} from '../../src/timing/long-timer.js';
import { VirtualClock } from './virtual-clock.js';

const DAY_MS = 86_400_000;
const STEP_MS = 60_000;

describe('long timers under fake Node timers', () => {
  const armed: number[] = [];

  beforeEach(() => {
    armed.length = 0;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const fake = globalThis.setTimeout;
    mock.method(globalThis, 'setTimeout', ((callback: () => void, ms?: number) => {
      armed.push(ms ?? 0);
      return fake(callback, ms);
    }) as typeof setTimeout);
  });

  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  /**
   * Advance fake time in steps. A fake timer runs at the end of the tick that
   * passes its due time, so each re-armed chunk may start up to one step late;
   * the assertions allow one step per chunk.
   */
  function advance(ms: number): void {
    for (let left = ms; left > 0; left -= STEP_MS) mock.timers.tick(Math.min(left, STEP_MS));
  }

  function assertNear(actual: number | undefined, expected: number, chunks: number): void {
    assert.ok(
      actual !== undefined && actual >= expected && actual <= expected + chunks * STEP_MS,
      `fired at ${String(actual)}, expected ${expected} (+${chunks} steps)`,
    );
  }

  test('a 30-day delay fires exactly once, after 30 days', () => {
    const firedAt: number[] = [];
    setLongTimeout(() => firedAt.push(Date.now()), 30 * DAY_MS);
    advance(30 * DAY_MS - STEP_MS);
    assert.deepEqual(firedAt, [], 'the delay fired early');
    advance(90 * DAY_MS);
    assert.equal(firedAt.length, 1, `the delay fired ${firedAt.length} times`);
    assertNear(firedAt[0], 30 * DAY_MS, 2);
    assert.ok(
      armed.every((ms) => ms <= MAX_TIMER_DELAY_MS),
      `armed ${JSON.stringify(armed)}`,
    );
  });

  test('a 30-day interval fires exactly once in its first 30 days, then every 30 days', () => {
    const firedAt: number[] = [];
    const interval = setLongInterval(() => firedAt.push(Date.now()), 30 * DAY_MS);
    advance(30 * DAY_MS - STEP_MS);
    assert.deepEqual(firedAt, [], 'the interval fired early');
    advance(15 * DAY_MS);
    assert.equal(
      firedAt.length,
      1,
      `the interval fired ${firedAt.length} times in its first 45 days`,
    );
    assertNear(firedAt[0], 30 * DAY_MS, 2);
    advance(30 * DAY_MS);
    assert.equal(firedAt.length, 2);
    assertNear(firedAt[1], 60 * DAY_MS, 4);
    interval.cancel();
    advance(90 * DAY_MS);
    assert.equal(firedAt.length, 2, 'a cancelled interval fired');
    assert.ok(
      armed.every((ms) => ms <= MAX_TIMER_DELAY_MS),
      `armed ${JSON.stringify(armed)}`,
    );
  });
});

describe('long timers on a clock', () => {
  test('a delay is split into chunks within the Node limit and fires at its exact time', async () => {
    const clock = new VirtualClock();
    const firedAt: number[] = [];
    setLongTimeout(() => firedAt.push(clock.now()), 3 * MAX_TIMER_DELAY_MS + 5, clock);
    await clock.advance(3 * MAX_TIMER_DELAY_MS + 4);
    assert.deepEqual(firedAt, []);
    await clock.advance(1);
    assert.deepEqual(firedAt, [3 * MAX_TIMER_DELAY_MS + 5]);
    assert.deepEqual(clock.armed, [MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, 5]);
  });

  test('a short delay arms one timer', async () => {
    const clock = new VirtualClock();
    let fired = 0;
    const timer = setLongTimeout(() => (fired += 1), 10, clock);
    assert.equal(timer.done, false);
    await clock.advance(10);
    assert.equal(fired, 1);
    assert.equal(timer.done, true);
    assert.deepEqual(clock.armed, [10]);
  });

  test('a zero delay fires on the next timer turn, not synchronously', async () => {
    const clock = new VirtualClock();
    let fired = 0;
    setLongTimeout(() => (fired += 1), 0, clock);
    assert.equal(fired, 0);
    await clock.advance(0);
    assert.equal(fired, 1);
  });

  test('cancel stops a long timer between chunks', async () => {
    const clock = new VirtualClock();
    let fired = 0;
    const timer = setLongTimeout(() => (fired += 1), 2 * MAX_TIMER_DELAY_MS, clock);
    await clock.advance(MAX_TIMER_DELAY_MS + 1);
    timer.cancel();
    timer.cancel();
    await clock.advance(2 * MAX_TIMER_DELAY_MS);
    assert.equal(fired, 0);
    assert.equal(timer.done, true);
    assert.equal(clock.pending, 0);
  });

  test('an interval cancelled from its own callback stops', async () => {
    const clock = new VirtualClock();
    let fired = 0;
    const interval = setLongInterval(
      () => {
        fired += 1;
        if (fired === 2) interval.cancel();
      },
      1_000,
      clock,
    );
    await clock.advance(10_000);
    assert.equal(fired, 2);
    assert.equal(interval.done, true);
  });

  test('a delay that is not a non-negative safe integer is refused, value-free', () => {
    for (const ms of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      assert.throws(
        () => setLongTimeout(() => undefined, ms),
        (error: unknown) =>
          JobsErrors.is(error, 'invalid_delay') && !error.message.includes(String(ms)),
      );
    }
    assert.throws(
      () => setLongInterval(() => undefined, 0),
      (error: unknown) => JobsErrors.is(error, 'invalid_delay'),
    );
  });
});
