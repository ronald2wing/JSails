/**
 * Tests for the seeded generator (`jsails/testing`): mulberry32's reference
 * outputs, determinism per seed, the range of every derived method, the seed
 * list with its fresh seed and `JSAILS_TEST_SEED` replay, and `forEachSeed`
 * rethrowing the first failure unchanged after naming its seed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FIXED_SEEDS,
  forEachSeed,
  seededRandom,
  TEST_SEED_ENV,
  testSeeds,
} from '../../src/testing/index.js';

describe('seededRandom', () => {
  it('matches the reference mulberry32 sequence', () => {
    // Outputs of the published mulberry32 for seeds 1 and 2^32 - 1, scaled to
    // the 32-bit integers they were divided from.
    const scaled = (seed: number, count: number): number[] => {
      const random = seededRandom(seed);
      return Array.from({ length: count }, () => Math.floor(random.next() * 2 ** 32));
    };
    assert.deepEqual(scaled(1, 3), [2693262067, 11749833, 2265367787]);
    assert.deepEqual(scaled(0xffffffff, 2), [3850105811, 813802916]);
  });

  it('repeats the same sequence for the same seed and differs across seeds', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    const seqC = Array.from({ length: 16 }, () => c.next());
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, seqC);
    assert.equal(a.seed, 42);
  });

  it('keeps next() in [0, 1) and int() in [min, max)', () => {
    const random = seededRandom(7);
    for (let index = 0; index < 10_000; index += 1) {
      const value = random.next();
      assert.ok(value >= 0 && value < 1);
      const int = random.int(-3, 4);
      assert.ok(Number.isInteger(int) && int >= -3 && int < 4);
    }
  });

  it('picks list members, shuffles without mutating, and yields bytes', () => {
    const random = seededRandom(9);
    const items = Object.freeze(['a', 'b', 'c', 'd', 'e']);
    for (let index = 0; index < 100; index += 1) {
      assert.ok(items.includes(random.pick(items)));
    }
    const shuffled = random.shuffle(items);
    assert.deepEqual([...shuffled].sort(), [...items]);
    assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
    const bytes = random.bytes(64);
    assert.equal(bytes.byteLength, 64);
    assert.ok(bytes.some((byte) => byte !== bytes[0]));
  });

  it('refuses malformed seeds and arguments', () => {
    for (const seed of [-1, 1.5, 2 ** 32, Number.NaN]) {
      assert.throws(() => seededRandom(seed), RangeError);
    }
    const random = seededRandom(1);
    assert.throws(() => random.int(3, 3), RangeError);
    assert.throws(() => random.pick([]), RangeError);
    assert.throws(() => random.bytes(-1), RangeError);
  });
});

describe('testSeeds', () => {
  it('is the fixed list plus one fresh seed', () => {
    assert.deepEqual(testSeeds({ env: {}, fresh: () => 99 }), [...FIXED_SEEDS, 99]);
  });

  it('does not repeat a fresh seed that is already fixed', () => {
    assert.deepEqual(testSeeds({ env: {}, fixed: [5, 6], fresh: () => 6 }), [5, 6]);
  });

  it('draws a fresh seed in range by default', () => {
    const seeds = testSeeds({ env: {}, fixed: [] });
    assert.equal(seeds.length, 1);
    assert.ok(Number.isInteger(seeds[0]) && seeds[0]! >= 0 && seeds[0]! < 2 ** 32);
  });

  it('replays only the pinned seed', () => {
    assert.deepEqual(testSeeds({ env: { [TEST_SEED_ENV]: ' 1234 ' } }), [1234]);
    assert.throws(() => testSeeds({ env: { [TEST_SEED_ENV]: 'abc' } }), RangeError);
    assert.throws(() => testSeeds({ env: { [TEST_SEED_ENV]: String(2 ** 32) } }), RangeError);
  });
});

describe('forEachSeed', () => {
  it('runs every seed in order', async (t) => {
    const seen: number[] = [];
    await forEachSeed(
      t,
      (random) => {
        seen.push(random.seed);
      },
      { env: {}, fixed: [3, 1], fresh: () => 2 },
    );
    assert.deepEqual(seen, [3, 1, 2]);
  });

  it('stops at the first failure, names its seed, and rethrows it unchanged', async () => {
    const original = new Error('property broke');
    const diagnostics: string[] = [];
    const context = { diagnostic: (message: string) => diagnostics.push(message) };
    const seen: number[] = [];
    await assert.rejects(
      forEachSeed(
        context as unknown as Parameters<typeof forEachSeed>[0],
        (random) => {
          seen.push(random.seed);
          if (random.seed === 8) {
            throw original;
          }
        },
        { env: {}, fixed: [7, 8, 9], fresh: () => 7 },
      ),
      (error) => error === original,
    );
    assert.deepEqual(seen, [7, 8]);
    assert.deepEqual(diagnostics, [`failed with seed 8; replay with ${TEST_SEED_ENV}=8`]);
  });
});
