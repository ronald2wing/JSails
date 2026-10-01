/**
 * The schedule ticker over a fake port on virtual time: interval and cron
 * arming, an early wake that waits out the remainder, catch-up coalesced to
 * one fire keyed by the first missed slot, re-arming on a change, paused and
 * removed records, a change reported while a read runs, a refused fire, port
 * errors and failed reads (both retried), and `stop`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { JobEnvelope, ScheduleRepeat } from '../../src/contract/index.js';
import { buildEnvelope } from '../../src/envelope/codec.js';
import {
  FIRE_RETRY_MS,
  startScheduleTicker,
  type FireExpectation,
  type ScheduleFiringPort,
  type ScheduleRecord,
} from '../../src/schedules/ticker.js';
import type { ClockTimer, JobsClock } from '../../src/timing/long-timer.js';
import { flush, VirtualClock } from '../timing/virtual-clock.js';

const START = Date.parse('2024-01-01T00:00:00Z');

interface Fired {
  readonly id: string;
  readonly through: number;
  readonly key: string | undefined;
}

/** A port over mutable records, applying fires as a compare-and-set. */
class FakePort implements ScheduleFiringPort {
  readonly fired: Fired[] = [];
  readonly #records = new Map<string, ScheduleRecord>();
  readonly #listeners = new Set<() => void>();
  failNextFire: Error | undefined;
  failRecords: Error | undefined;
  asyncRecords = false;

  set(
    id: string,
    repeat: ScheduleRepeat,
    overrides: Partial<ScheduleRecord> = {},
    announce = true,
  ): void {
    const previous = this.#records.get(id);
    this.#records.set(id, {
      spec: { id, queue: 'default', envelope: ENVELOPE, repeat },
      paused: false,
      anchor: START,
      through: undefined,
      revision: (previous?.revision ?? 0) + 1,
      ...overrides,
    });
    if (announce) this.notify();
  }

  remove(id: string): void {
    this.#records.delete(id);
    this.notify();
  }

  notify(): void {
    for (const listener of this.#listeners) listener();
  }

  get listeners(): number {
    return this.#listeners.size;
  }

  records(): readonly ScheduleRecord[] | Promise<readonly ScheduleRecord[]> {
    if (this.failRecords !== undefined) {
      const error = this.failRecords;
      this.failRecords = undefined;
      return Promise.reject(error);
    }
    const records = [...this.#records.values()];
    return this.asyncRecords ? Promise.resolve(records) : records;
  }

  fire(id: string, expected: FireExpectation, through: number, envelope: JobEnvelope): boolean {
    if (this.failNextFire !== undefined) {
      const error = this.failNextFire;
      this.failNextFire = undefined;
      throw error;
    }
    const record = this.#records.get(id);
    if (
      record === undefined ||
      record.paused ||
      record.revision !== expected.revision ||
      record.through !== expected.through
    ) {
      return false;
    }
    this.#records.set(id, { ...record, through });
    this.fired.push({ id, through, key: envelope.meta.key });
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

const ENVELOPE = buildEnvelope({ name: 'tick', payload: null, options: {}, dispatchedAt: 0 });

function start(port: FakePort, clock: JobsClock) {
  const errors: unknown[] = [];
  const ticker = startScheduleTicker(port, clock, (error) => errors.push(error));
  return { ticker, errors };
}

describe('schedule ticker', () => {
  test('fires an interval at its slots, keyed by each slot', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('minutely', { everyMs: 60_000 });
    const { ticker, errors } = start(port, clock);
    await flush();
    await clock.advance(59_999);
    assert.equal(port.fired.length, 0);
    await clock.advance(1);
    await clock.advance(120_000);
    assert.deepEqual(
      port.fired.map((fire) => fire.key),
      [START + 60_000, START + 120_000, START + 180_000].map(
        (slot) => `jsails:schedule:minutely:${slot}`,
      ),
    );
    ticker.stop();
    assert.deepEqual(errors, []);
  });

  test('fires a cron schedule at its occurrences', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START + 10_000);
    port.set('hourly', { cron: '0 * * * *', tz: 'UTC' }, { anchor: START + 10_000 });
    const { ticker } = start(port, clock);
    await flush();
    await clock.advance(2 * 3_600_000);
    assert.deepEqual(
      port.fired.map((fire) => fire.through),
      [START + 3_600_000, START + 7_200_000],
    );
    ticker.stop();
  });

  test('catches up once, keyed by the first missed slot, then resumes on the grid', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START + 250_000);
    port.set('minutely', { everyMs: 60_000 });
    const { ticker } = start(port, clock);
    await flush();
    await flush();
    assert.deepEqual(port.fired, [
      {
        id: 'minutely',
        through: START + 250_000,
        key: `jsails:schedule:minutely:${START + 60_000}`,
      },
    ]);
    await clock.advance(50_000);
    assert.equal(port.fired.at(-1)?.key, `jsails:schedule:minutely:${START + 300_000}`);
    assert.equal(port.fired.length, 2);
    ticker.stop();
  });

  test('a wake that comes early by the wall clock waits out the remainder', async () => {
    const port = new FakePort();
    const virtual = new VirtualClock(START);
    let skew = 0;
    // The wall clock lags the timers by `skew` after the first wake.
    const clock: JobsClock = {
      now: () => virtual.now() - skew,
      setTimer: (callback: () => void, ms: number): ClockTimer =>
        virtual.setTimer(() => {
          callback();
          skew = 0;
        }, ms),
    };
    port.set('minutely', { everyMs: 60_000 });
    const { ticker } = start(port, clock);
    await flush();
    skew = 500;
    await virtual.advance(60_000);
    assert.equal(port.fired.length, 0, 'fired before its slot by the wall clock');
    await virtual.advance(500);
    assert.equal(port.fired.length, 1);
    ticker.stop();
  });

  test('re-arms on a change; paused and removed records are not armed', async () => {
    const port = new FakePort();
    port.asyncRecords = true;
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    port.set('b', { everyMs: 60_000 }, { paused: true });
    const { ticker } = start(port, clock);
    await flush();
    port.set('a', { everyMs: 120_000 });
    port.notify();
    await flush();
    await flush();
    await clock.advance(60_000);
    assert.equal(port.fired.length, 0, 'the old repeat stayed armed');
    await clock.advance(60_000);
    assert.deepEqual(
      port.fired.map((fire) => fire.id),
      ['a'],
    );
    port.remove('a');
    await flush();
    await clock.advance(240_000);
    assert.equal(port.fired.length, 1);
    port.set('b', { everyMs: 60_000 }, { paused: false, anchor: clock.now() });
    await flush();
    await clock.advance(60_000);
    assert.deepEqual(
      port.fired.map((fire) => fire.id),
      ['a', 'b'],
    );
    ticker.stop();
  });

  test('a change reported at any point of a running read is read', async () => {
    for (const asyncRecords of [false, true]) {
      for (let offset = 0; offset <= 8; offset += 1) {
        const port = new FakePort();
        port.asyncRecords = asyncRecords;
        const clock = new VirtualClock(START);
        port.set('a', { everyMs: 60_000 }, { paused: true });
        port.set('b', { everyMs: 60_000 }, { paused: true });
        const { ticker } = start(port, clock);
        await flush();
        port.set('a', { everyMs: 60_000 }, { paused: true });
        for (let tick = 0; tick < offset; tick += 1) await Promise.resolve();
        port.set('b', { everyMs: 60_000 }, { paused: false });
        await flush();
        await clock.advance(60_000);
        assert.deepEqual(
          port.fired.map((fire) => fire.id),
          ['b'],
          `a resume ${offset} microtasks into a read (${asyncRecords ? 'async' : 'sync'} records) was dropped`,
        );
        ticker.stop();
      }
    }
  });

  test('a fire refused by the port re-reads the records', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    const { ticker } = start(port, clock);
    await flush();
    // A change the port does not announce: the fire's expectation is stale.
    port.set('a', { everyMs: 60_000 }, { revision: 99 }, false);
    await clock.advance(60_000);
    await flush();
    await flush();
    // The re-read record still has the slot due, and fires it under its new revision.
    assert.deepEqual(port.fired, [
      { id: 'a', through: START + 60_000, key: `jsails:schedule:a:${START + 60_000}` },
    ]);
    await clock.advance(60_000);
    assert.equal(port.fired.length, 2, 'the re-read record fires at its next slot');
    ticker.stop();
  });

  test('a port error is reported and the fire retried', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    const { ticker, errors } = start(port, clock);
    await flush();
    port.failNextFire = new Error('store down');
    await clock.advance(60_000);
    assert.equal(errors.length, 1);
    assert.equal(port.fired.length, 0);
    await clock.advance(FIRE_RETRY_MS);
    assert.equal(port.fired[0]?.key, `jsails:schedule:a:${START + 60_000}`);
    port.failRecords = new Error('read failed');
    port.notify();
    await flush();
    assert.equal(errors.length, 2);
    ticker.stop();
  });

  test('a failed read is tried again, so a store briefly unreachable at start still fires', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    port.failRecords = new Error('store unreachable');
    const { ticker, errors } = start(port, clock);
    await flush();
    assert.equal(errors.length, 1);
    await clock.advance(FIRE_RETRY_MS);
    await flush();
    await clock.advance(60_000 - FIRE_RETRY_MS);
    assert.deepEqual(
      port.fired.map((fire) => fire.key),
      [`jsails:schedule:a:${START + 60_000}`],
      'no change was announced, yet the schedule fires',
    );
    ticker.stop();
  });

  test('a refused fire whose re-read fails is armed again by the retried read', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    const { ticker, errors } = start(port, clock);
    await flush();
    port.set('a', { everyMs: 60_000 }, { revision: 99 }, false);
    port.failRecords = new Error('read failed');
    await clock.advance(60_000);
    await flush();
    assert.equal(errors.length, 1);
    assert.equal(port.fired.length, 0);
    await clock.advance(FIRE_RETRY_MS);
    await flush();
    assert.deepEqual(
      port.fired.map((fire) => fire.id),
      ['a'],
    );
    ticker.stop();
  });

  test('stop cancels a pending read retry', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    port.failRecords = new Error('store unreachable');
    const { ticker } = start(port, clock);
    await flush();
    assert.equal(clock.pending, 1);
    ticker.stop();
    assert.equal(clock.pending, 0);
  });

  test('a change announced while a read retry waits reads at once', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    port.failRecords = new Error('store unreachable');
    const { ticker } = start(port, clock);
    await flush();
    port.notify();
    await flush();
    assert.equal(clock.pending, 1, 'the retry timer gave way to the armed record');
    await clock.advance(60_000);
    assert.equal(port.fired.length, 1);
    ticker.stop();
  });

  test('a record whose fire time cannot be computed is reported, not armed', async () => {
    const port = new FakePort();
    port.set('broken', { cron: '0 0 L * *', tz: 'UTC' });
    const { ticker, errors } = start(port, new VirtualClock(START));
    await flush();
    assert.equal(errors.length, 1);
    ticker.stop();
  });

  test('stop cancels every timer, stops listening, and is idempotent', async () => {
    const port = new FakePort();
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    const { ticker } = start(port, clock);
    await flush();
    assert.equal(port.listeners, 1);
    ticker.stop();
    ticker.stop();
    assert.equal(port.listeners, 0);
    assert.equal(clock.pending, 0);
    await clock.advance(120_000);
    assert.equal(port.fired.length, 0);
  });

  test('a stop while the records are read arms nothing', async () => {
    const port = new FakePort();
    port.asyncRecords = true;
    const clock = new VirtualClock(START);
    port.set('a', { everyMs: 60_000 });
    const { ticker } = start(port, clock);
    ticker.stop();
    await flush();
    assert.equal(clock.pending, 0);
  });
});
