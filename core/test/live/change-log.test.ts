/**
 * Tests for the live layer's in-memory change log.
 *
 * The `ChangeLog` contract assigns the durable sequence at append time, retains
 * a bounded window (by count and by bytes), and reports `truncated` when a
 * requested sequence has already been evicted — the "continuity lost" signal a
 * caller uses to degrade to a full snapshot (LIVE-PLAN.md §4.5, §8).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LiveChange } from '../../src/live/change-record.js';
import { createInMemoryChangeLog } from '../../src/live/change-log.js';

function change(id: string, extra: Partial<LiveChange> = {}): LiveChange {
  return {
    sequence: 0,
    collection: 'posts',
    id,
    operation: 'update',
    row: { id, title: `Title ${id}` },
    at: 1_700_000_000_000,
    ...extra,
  };
}

describe('createInMemoryChangeLog', () => {
  describe('append', () => {
    it('assigns a strictly monotonic sequence starting at 1, replacing the placeholder', async () => {
      const log = createInMemoryChangeLog();
      assert.equal(await log.append(change('a')), 1);
      assert.equal(await log.append(change('b')), 2);
      assert.equal(await log.append(change('c')), 3);
      assert.equal(log.head, 3);

      const slice = await log.since(1);
      assert.equal(slice.truncated, false);
      assert.deepEqual(
        slice.changes.map((c) => c.sequence),
        [1, 2, 3],
      );
      // The placeholder `sequence: 0` never escapes the log.
      assert.ok(slice.changes.every((c) => c.sequence > 0));
    });

    it('exposes head as the last assigned sequence, 0 before any append', async () => {
      const log = createInMemoryChangeLog();
      assert.equal(log.head, 0);
      await log.append(change('a'));
      assert.equal(log.head, 1);
    });
  });

  describe('since', () => {
    it('returns changes at and after the requested sequence when in range', async () => {
      const log = createInMemoryChangeLog();
      await log.append(change('a'));
      await log.append(change('b'));
      await log.append(change('c'));

      const slice = await log.since(2);
      assert.equal(slice.truncated, false);
      assert.deepEqual(
        slice.changes.map((c) => c.id),
        ['b', 'c'],
      );
    });

    it('reports truncated when the requested sequence predates the oldest retained entry', async () => {
      const log = createInMemoryChangeLog({ maxChanges: 2 });
      await log.append(change('a')); // seq 1
      await log.append(change('b')); // seq 2
      await log.append(change('c')); // seq 3, evicts a

      const slice = await log.since(1);
      assert.equal(slice.truncated, true);
      // The evicted entry is gone; only what is still retained is returned.
      assert.deepEqual(
        slice.changes.map((c) => c.id),
        ['b', 'c'],
      );
    });

    it('returns an empty, non-truncated slice for a sequence ahead of head', async () => {
      const log = createInMemoryChangeLog();
      await log.append(change('a'));
      const slice = await log.since(99);
      assert.equal(slice.truncated, false);
      assert.deepEqual(slice.changes, []);
    });

    it('does not report truncated for the 0 baseline used to request "everything"', async () => {
      const log = createInMemoryChangeLog({ maxChanges: 1 });
      await log.append(change('a'));
      await log.append(change('b'));
      const slice = await log.since(0);
      assert.equal(slice.truncated, false);
      assert.deepEqual(
        slice.changes.map((c) => c.id),
        ['b'],
      );
    });
  });

  describe('eviction', () => {
    it('evicts the oldest entry beyond the count cap', async () => {
      const log = createInMemoryChangeLog({ maxChanges: 1 });
      await log.append(change('a'));
      await log.append(change('b'));
      const slice = await log.since(1);
      assert.deepEqual(
        slice.changes.map((c) => c.id),
        ['b'],
      );
      assert.equal(slice.truncated, true);
    });

    it('evicts the oldest entry beyond the byte cap', async () => {
      const small = change('a', { row: { id: 'a', title: 'tiny' } });
      const baseBytes = JSON.stringify(small).length;
      // Cap just above one entry so the second append forces an eviction.
      const log = createInMemoryChangeLog({ maxBytes: baseBytes + 1 });
      await log.append(small); // fits alone
      const big = change('b', { row: { id: 'b', payload: 'x'.repeat(baseBytes) } });
      await log.append(big); // over cap, evicts 'a'

      const slice = await log.since(1);
      assert.equal(slice.truncated, true);
      assert.deepEqual(
        slice.changes.map((c) => c.id),
        ['b'],
      );
    });

    it('keeps entries within both bounds when both are set', async () => {
      const log = createInMemoryChangeLog({ maxChanges: 2, maxBytes: 1_000_000 });
      await log.append(change('a'));
      await log.append(change('b'));
      await log.append(change('c'));
      const slice = await log.since(1);
      assert.equal(slice.truncated, true);
      assert.deepEqual(
        slice.changes.map((c) => c.id),
        ['b', 'c'],
      );
    });
  });

  describe('close', () => {
    it('rejects append after close', async () => {
      const log = createInMemoryChangeLog();
      await log.append(change('a'));
      await log.close();
      await assert.rejects(() => log.append(change('b')), /closed/);
    });
  });
});
