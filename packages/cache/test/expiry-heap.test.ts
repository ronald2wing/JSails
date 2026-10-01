/**
 * The in-memory stores' expiry heap: it drains due keys in expiry order and
 * leaves later ones, and a compaction keeps it within a constant factor of the
 * live entries however many stale nodes rewrites leave behind. The stores'
 * own bookkeeping is checked through the same bound.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeClock, forEachSeed } from 'jsails/testing';

import { MemoryLeaseStore } from '../src/index.js';
import { ExpiryHeap } from '../src/expiry-heap.js';
import { MemoryWindowCounter } from '../src/window-counter.js';

describe('ExpiryHeap', () => {
  it('drains every due key in expiry order and keeps the rest', async (t) => {
    await forEachSeed(t, (random) => {
      const heap = new ExpiryHeap();
      const times = Array.from({ length: 200 }, () => random.int(0, 1000));
      times.forEach((time, index) => heap.push(time, `k${String(index)}`));
      const drained: number[] = [];
      heap.drain(500, (key) => drained.push(times[Number(key.slice(1))] ?? -1));
      assert.deepEqual(
        drained,
        times.filter((time) => time <= 500).sort((a, b) => a - b),
      );
      assert.equal(heap.size, times.filter((time) => time > 500).length);
    });
  });

  it('rebuilds from the live entries once stale nodes outnumber them', () => {
    const heap = new ExpiryHeap();
    for (let write = 0; write < 100; write += 1) heap.push(write, 'only');
    heap.compact(1, () => [['only', 99]]);
    assert.equal(heap.size, 1);
    heap.compact(1, () => assert.fail('a heap within its slack is not rebuilt'));
    heap.clear();
    assert.equal(heap.size, 0);
  });
});

describe('expiry bookkeeping of the in-memory stores', () => {
  it('a lease store renewed many times compacts on its next sweep', async () => {
    const clock = createFakeClock();
    const store = new MemoryLeaseStore({ now: clock.now });
    const lease = await store.acquire('job', 1000);
    assert.ok(lease !== null);
    for (let renewal = 0; renewal < 500; renewal += 1) {
      clock.advance(1);
      assert.equal(await store.renew(lease, 1000), true);
    }
    assert.equal(await store.acquire('job', 1000), null, 'the compacted heap kept the lease');
    clock.advance(1000);
    assert.ok((await store.acquire('job', 1000)) !== null);
  });

  it('a window counter restarted many times compacts as it goes', async () => {
    const clock = createFakeClock();
    const counter = new MemoryWindowCounter(clock.now);
    for (let window = 0; window < 500; window += 1) {
      assert.equal(await counter.increment('k', 1), 1);
      clock.advance(1);
    }
    assert.equal(counter.size, 1);
  });
});
