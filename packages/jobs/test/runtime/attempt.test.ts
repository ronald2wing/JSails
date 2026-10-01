/**
 * One attempt's abort sources: a lost lease aborts with `overlap_lost`
 * unless the signal already aborted or the attempt was disposed, the first
 * cause wins, and a handler that ignores the abort is held through the grace
 * and poisons the worker when it outlives it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JobsErrors } from '../../src/errors/jobs-errors.js';
import { Attempt } from '../../src/runtime/attempt.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';

function setup(options: { timeoutMs?: number; shutdown?: AbortSignal } = {}) {
  const clock = new VirtualClock(0);
  let poisoned = 0;
  const attempt = new Attempt({
    shutdown: options.shutdown ?? new AbortController().signal,
    timeoutMs: options.timeoutMs,
    clock,
    handlerGraceMs: 1_000,
    ledger: { enter: () => undefined, leave: () => undefined, poison: () => (poisoned += 1) },
  });
  return { attempt, clock, poisoned: () => poisoned };
}

describe('attempt', () => {
  test('a lost lease aborts the signal with overlap_lost', () => {
    const { attempt } = setup();
    assert.equal(attempt.cause, undefined);
    attempt.loseLease();
    assert.equal(attempt.signal.aborted, true);
    assert.equal(attempt.cause, 'lease_lost');
    assert.ok(JobsErrors.is(attempt.abortError, 'overlap_lost'));
    assert.equal(attempt.signal.reason, attempt.abortError);
    attempt.dispose();
  });

  test('the first cause wins; a later loss changes nothing', async () => {
    const { attempt, clock } = setup({ timeoutMs: 10 });
    await clock.advance(10);
    attempt.loseLease();
    assert.equal(attempt.cause, 'timeout');
    assert.ok(JobsErrors.is(attempt.abortError, 'attempt_timeout'));
    attempt.dispose();

    const controller = new AbortController();
    const shut = setup({ shutdown: controller.signal });
    controller.abort();
    shut.attempt.loseLease();
    assert.equal(shut.attempt.cause, 'shutdown');
    assert.equal(shut.attempt.abortError, undefined);
    shut.attempt.dispose();
  });

  test('a loss after the attempt was disposed is ignored', () => {
    const { attempt } = setup();
    attempt.dispose();
    attempt.loseLease();
    assert.equal(attempt.signal.aborted, false);
    assert.equal(attempt.cause, undefined);
  });

  test('a handler that ignores a lost lease poisons the worker after the grace', async () => {
    const { attempt, clock, poisoned } = setup();
    let finish: () => void = () => undefined;
    const held = attempt.hold(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    attempt.loseLease();
    await flush();
    await clock.advance(999);
    assert.equal(poisoned(), 0);
    await clock.advance(1);
    assert.equal(poisoned(), 1);
    finish();
    assert.deepEqual(await held, { ok: true, value: undefined });
    attempt.dispose();
  });
});
