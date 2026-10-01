/**
 * A keyset walk costs the same per batch at the end of a large table as at
 * its start: over 200,000 SQLite rows, read in batches of 1,000, the time a
 * batch takes near the end must stay within 20% of the time near the start.
 * (An offset walk reads every skipped row again, so its last batches cost
 * hundreds of times its first.)
 *
 * Absolute times mean nothing on a shared runner, so the test compares a
 * ratio, and makes each side of it robust to load: the walk runs several
 * times, each batch position keeps its fastest time over the runs (load only
 * ever adds time), and the two sides are the medians of those minima over
 * twenty positions each, skipping the first batch (warm-up) and the last
 * (short). Interleaving is free: every run visits early and late positions
 * alike, so a burst of load during one run raises both sides or neither.
 * Under sustained load seven runs may leave some late positions without a
 * quiet moment, so while the ratio is over the band the walk runs again, up
 * to {@link MAX_RUNS} times. A further run can only lower a position's
 * fastest time, so load is measured away, while a walk whose late batches
 * really cost more (an offset walk's are about seventeen times its early
 * ones here) stays over the band however often it runs.
 * The walk selects only the key, so the per-row decoding that is the same in
 * every batch does not dilute what is measured: the statement itself.
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { before, describe, it } from 'node:test';

import { insertAll, query } from '../../src/index.js';
import { EVENT_MODELS, Event, type EventRow } from './fixtures/event-model.js';
import { openDataSource, suiteLifecycle } from './fixtures/open-data-source.js';

const ROWS = 200_000;
const BATCH = 1_000;
const RUNS = 7;
const MAX_RUNS = 28;
const SAMPLE = 20;
const BAND = 1.2;
const SEED_CHUNK = 10_000;

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

describe('keyset batch timing over 200k SQLite rows', () => {
  const lifecycle = suiteLifecycle();

  // Seeded in chunks: one 200,000-row array, with its entities and statement
  // parameters alive at once, was this file's memory peak.
  before(async () => {
    await openDataSource(lifecycle, EVENT_MODELS);
    const base = Date.UTC(2024, 0, 1);
    for (let start = 0; start < ROWS; start += SEED_CHUNK) {
      await insertAll<EventRow>(
        Event,
        Array.from({ length: Math.min(SEED_CHUNK, ROWS - start) }, (_, offset) => ({
          at: new Date(base + start + offset),
          rank: null,
          label: 'e',
        })),
      );
    }
  });

  it('keeps the time per batch at the end within 20% of the start', async () => {
    const batches = ROWS / BATCH;
    const fastest = Array.from({ length: batches }, () => Number.POSITIVE_INFINITY);
    const measure = (): { early: number; late: number; ratio: number } => {
      const early = median(fastest.slice(1, 1 + SAMPLE));
      const late = median(fastest.slice(batches - 1 - SAMPLE, batches - 1));
      return { early, late, ratio: late / early };
    };
    let runs = 0;
    while (runs < RUNS || (measure().ratio > BAND && runs < MAX_RUNS)) {
      runs += 1;
      let previous = performance.now();
      let seen = 0;
      await query<EventRow>(Event)
        .select('id')
        .inBatches(BATCH, (rows, index) => {
          const now = performance.now();
          fastest[index] = Math.min(fastest[index] as number, now - previous);
          seen += rows.length;
          previous = performance.now();
        });
      assert.equal(seen, ROWS);
    }
    const { early, late, ratio } = measure();
    assert.ok(
      ratio <= BAND,
      `late batches took ${late.toFixed(3)} ms, early ${early.toFixed(3)} ms (ratio ${ratio.toFixed(2)}) over ${runs} runs`,
    );
  });
});
