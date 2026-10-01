/**
 * The shared poll loop under fake timers: the jittered interval, pausing while
 * hidden or offline (the default) with one catch-up refresh on return, the
 * `continue` policies, `Retry-After`, the capped exponential backoff, and the
 * marker parser.
 */

import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';

import {
  MAX_POLL_BACKOFF_MS,
  parsePollMarker,
  startPolling,
  type PollHandle,
  type PollOptions,
  type PollSignals,
} from '../../src/client/polling.js';
import {
  MAX_POLL_INTERVAL_MS,
  MAX_POLL_MARKER_LENGTH,
  MIN_POLL_INTERVAL_MS,
} from '../../src/server-components/protocol.js';

/** Drain pending microtasks while fake timers are active (`setImmediate` stays real). */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function signals(initial: { hidden?: boolean; online?: boolean } = {}): {
  signals: PollSignals;
  set(patch: { hidden?: boolean; online?: boolean }): void;
} {
  const state = { hidden: initial.hidden ?? false, online: initial.online ?? true };
  const listeners = new Set<() => void>();
  return {
    signals: {
      get hidden() {
        return state.hidden;
      },
      get online() {
        return state.online;
      },
      onChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    set(patch) {
      Object.assign(state, patch);
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
  };
}

interface Loop {
  readonly handle: PollHandle;
  readonly calls: number[];
  readonly signals: ReturnType<typeof signals>;
  /** Outcome of each next refresh; a function is called and may throw. */
  next: Array<() => void>;
  active: boolean;
}

/**
 * A loop over a counting target. `random` defaults to 0.5, which makes the
 * jitter zero, so delays are exact.
 */
function loop(
  t: TestContext,
  options: Partial<PollOptions> & { intervalMs: number },
  extra: { hidden?: boolean; online?: boolean; random?: () => number } = {},
): Loop {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sig = signals(extra);
  const state: Loop = {
    calls: [],
    signals: sig,
    next: [],
    active: true,
    handle: { stop() {} },
  };
  const handle = startPolling({
    options: { whenHidden: 'pause', whenOffline: 'pause', ...options },
    signals: sig.signals,
    isActive: () => state.active,
    random: extra.random ?? (() => 0.5),
    refresh: async () => {
      state.calls.push(Date.now());
      state.next.shift()?.();
    },
  });
  Object.assign(state, { handle });
  t.after(() => handle.stop());
  return state;
}

/** Advance the fake clock by `ms`, then let the loop's promises settle. */
async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await drain();
}

describe('poll loop: interval and jitter', () => {
  it('ticks every interval, never overlapping refreshes', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    await advance(t, 999);
    assert.equal(l.calls.length, 0);
    await advance(t, 1);
    assert.equal(l.calls.length, 1);
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(l.calls.length, 3);
  });

  it('spreads each delay by at most 10% either way', async (t) => {
    const early = loop(t, { intervalMs: 1000 }, { random: () => 0 });
    await advance(t, 899);
    assert.equal(early.calls.length, 0);
    await advance(t, 1);
    assert.equal(early.calls.length, 1, 'random 0 ticks at 90% of the interval');
    early.handle.stop();
  });

  it('ticks no later than 110% of the interval', async (t) => {
    const late = loop(t, { intervalMs: 1000 }, { random: () => 0.999_999 });
    await advance(t, 1099);
    assert.equal(late.calls.length, 0);
    await advance(t, 1);
    assert.equal(late.calls.length, 1);
  });

  it('stops scheduling once stopped or once the owner is inactive', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    await advance(t, 1000);
    assert.equal(l.calls.length, 1);
    l.active = false;
    await advance(t, 5000);
    assert.equal(l.calls.length, 1);
    l.active = true;
    l.handle.stop();
    l.signals.set({ hidden: false });
    await advance(t, 5000);
    assert.equal(l.calls.length, 1);
  });
});

describe('poll loop: hidden and offline', () => {
  it('pauses while hidden by default and refreshes once on return when a tick came due', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    await advance(t, 400);
    l.signals.set({ hidden: true });
    await advance(t, 10_000);
    assert.equal(l.calls.length, 0, 'no refresh while hidden');

    l.signals.set({ hidden: false });
    await drain();
    assert.equal(l.calls.length, 1, 'one catch-up refresh on return');
    await advance(t, 999);
    assert.equal(l.calls.length, 1);
    await advance(t, 1);
    assert.equal(l.calls.length, 2, 'the cadence resumes from the catch-up');
  });

  it('waits out the rest of the interval when none elapsed while hidden', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    await advance(t, 300);
    l.signals.set({ hidden: true });
    await advance(t, 300);
    l.signals.set({ hidden: false });
    await drain();
    assert.equal(l.calls.length, 0, 'no catch-up before the deadline');
    await advance(t, 399);
    assert.equal(l.calls.length, 0);
    await advance(t, 1);
    assert.equal(l.calls.length, 1);
  });

  it('starts paused in a hidden tab and catches up when it becomes visible', async (t) => {
    const l = loop(t, { intervalMs: 1000 }, { hidden: true });
    await advance(t, 5000);
    assert.equal(l.calls.length, 0);
    l.signals.set({ hidden: false });
    await drain();
    assert.equal(l.calls.length, 1);
  });

  it('pauses while offline by default and catches up on reconnect', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    l.signals.set({ online: false });
    await advance(t, 3000);
    assert.equal(l.calls.length, 0);
    l.signals.set({ online: true });
    await drain();
    assert.equal(l.calls.length, 1);
  });

  it('keeps ticking while hidden or offline when the policy is continue', async (t) => {
    const l = loop(
      t,
      { intervalMs: 1000, whenHidden: 'continue', whenOffline: 'continue' },
      { hidden: true, online: false },
    );
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(l.calls.length, 2);
  });

  it('applies each policy to its own signal', async (t) => {
    const l = loop(t, { intervalMs: 1000, whenHidden: 'continue' }, { hidden: true });
    await advance(t, 1000);
    assert.equal(l.calls.length, 1, 'hidden does not pause a continue poll');
    l.signals.set({ online: false });
    await advance(t, 3000);
    assert.equal(l.calls.length, 1, 'offline still pauses');
  });

  it('does not refresh a tick that was armed before the tab went hidden', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    await advance(t, 999);
    l.signals.set({ hidden: true });
    await advance(t, 1);
    assert.equal(l.calls.length, 0);
  });
});

describe('poll loop: failures', () => {
  const fail = (): void => {
    throw new Error('refresh failed');
  };

  it('backs off exponentially on consecutive failures and resets on success', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    l.next = [fail, fail, fail, () => {}];
    await advance(t, 1000);
    assert.deepEqual(l.calls, [1000]);
    await advance(t, 2000);
    assert.deepEqual(l.calls, [1000, 3000], 'first failure doubles the delay');
    await advance(t, 4000);
    assert.deepEqual(l.calls, [1000, 3000, 7000], 'second failure doubles it again');
    await advance(t, 8000);
    assert.deepEqual(l.calls, [1000, 3000, 7000, 15_000]);
    await advance(t, 1000);
    assert.deepEqual(l.calls, [1000, 3000, 7000, 15_000, 16_000], 'a success resets the delay');
  });

  it('caps the backoff', async (t) => {
    const l = loop(t, { intervalMs: 60_000 });
    l.next = Array.from({ length: 6 }, () => fail);
    await advance(t, 60_000);
    await advance(t, 120_000);
    await advance(t, 240_000);
    assert.equal(l.calls.length, 3);
    await advance(t, MAX_POLL_BACKOFF_MS - 1);
    assert.equal(l.calls.length, 3, '480 s is capped at the maximum');
    await advance(t, 1);
    assert.equal(l.calls.length, 4);
    await advance(t, MAX_POLL_BACKOFF_MS);
    assert.equal(l.calls.length, 5, 'the cap holds for every later failure');
  });

  it('never backs off below one interval when the interval exceeds the cap', async (t) => {
    const intervalMs = MAX_POLL_BACKOFF_MS * 2;
    const l = loop(t, { intervalMs });
    l.next = [fail];
    await advance(t, intervalMs);
    assert.equal(l.calls.length, 1);
    await advance(t, intervalMs - 1);
    assert.equal(l.calls.length, 1);
    await advance(t, 1);
    assert.equal(l.calls.length, 2);
  });

  it('honours a Retry-After the failure carries', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    l.next = [
      () => {
        throw Object.assign(new Error('rate limited'), { retryAfterMs: 30_000 });
      },
    ];
    await advance(t, 1000);
    await advance(t, 29_999);
    assert.equal(l.calls.length, 1, 'not before Retry-After elapsed');
    await advance(t, 1);
    assert.equal(l.calls.length, 2);
  });

  it('caps an honoured Retry-After and ignores an unreadable one', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    l.next = [
      () => {
        throw Object.assign(new Error('x'), { retryAfterMs: MAX_POLL_BACKOFF_MS * 10 });
      },
      () => {
        throw Object.assign(new Error('x'), { retryAfterMs: -5 });
      },
    ];
    await advance(t, 1000);
    await advance(t, MAX_POLL_BACKOFF_MS);
    assert.equal(l.calls.length, 2, 'Retry-After is capped');
    await advance(t, 4000);
    assert.equal(l.calls.length, 3, 'a negative Retry-After falls back to the backoff');
  });

  it('keeps the backoff deadline across a pause', async (t) => {
    const l = loop(t, { intervalMs: 1000 });
    l.next = [fail];
    await advance(t, 1000);
    l.signals.set({ hidden: true });
    await advance(t, 500);
    l.signals.set({ hidden: false });
    await drain();
    assert.equal(l.calls.length, 1, 'the backed-off deadline has not passed');
    await advance(t, 1500);
    assert.equal(l.calls.length, 2);
  });
});

describe('poll marker', () => {
  it('parses the interval and defaults both policies to pause', () => {
    assert.deepEqual(parsePollMarker('{"intervalMs":1000}'), {
      intervalMs: 1000,
      whenHidden: 'pause',
      whenOffline: 'pause',
    });
    assert.deepEqual(
      parsePollMarker('{"intervalMs":1000,"whenHidden":"continue","whenOffline":"pause"}'),
      { intervalMs: 1000, whenHidden: 'continue', whenOffline: 'pause' },
    );
  });

  it('accepts the maximum interval, whose jittered delay stays inside a timer', () => {
    assert.equal(
      parsePollMarker(`{"intervalMs":${MAX_POLL_INTERVAL_MS}}`)?.intervalMs,
      MAX_POLL_INTERVAL_MS,
    );
    // Past 2^31 - 1 ms a browser or Node timer fires after about 1 ms.
    assert.ok(MAX_POLL_INTERVAL_MS * 1.1 < 2 ** 31 - 1);
  });

  it('rejects an absent, malformed, out-of-bounds, or unknown-policy marker', () => {
    for (const raw of [
      null,
      '',
      '{',
      '[]',
      'null',
      '{"intervalMs":"1000"}',
      `{"intervalMs":${MIN_POLL_INTERVAL_MS - 1}}`,
      `{"intervalMs":${MAX_POLL_INTERVAL_MS + 1}}`,
      '{"intervalMs":3000000000}',
      '{"intervalMs":1000.5}',
      '{"intervalMs":1000,"whenHidden":"stop"}',
      '{"intervalMs":1000,"whenOffline":true}',
      '{"intervalMs":1000,"pauseWhenHidden":true,"whenHidden":1}',
      `{"intervalMs":1000,"pad":"${'x'.repeat(MAX_POLL_MARKER_LENGTH)}"}`,
    ]) {
      assert.equal(parsePollMarker(raw), null, String(raw));
    }
  });
});
