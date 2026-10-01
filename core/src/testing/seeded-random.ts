/**
 * Reproducible randomness for property-style tests (`jsails/testing`).
 *
 * {@link seededRandom} is mulberry32: a 32-bit state, fast, and identical on
 * every platform and Node version, which `Math.random` is not. Property tests
 * run a fixed seed list, so CI is deterministic, plus one fresh seed per run, so
 * the input space keeps being explored; {@link forEachSeed} prints the seed of
 * a failing run and `JSAILS_TEST_SEED=<n>` replays exactly that one.
 */

import { randomInt } from 'node:crypto';
import type { TestContext } from 'node:test';

import type { Awaitable } from '../contracts/awaitable.js';

/** A deterministic random source; every method advances the same state. */
export interface SeededRandom {
  /** The seed this source started from, as an unsigned 32-bit integer. */
  readonly seed: number;
  /** A float in `[0, 1)`. */
  next(): number;
  /** An integer in `[min, max)`. */
  int(min: number, max: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy (Fisher-Yates); the input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
  /** `length` random bytes. */
  bytes(length: number): Uint8Array;
}

/** The seeds every {@link forEachSeed} run covers. */
export const FIXED_SEEDS: readonly number[] = Object.freeze([
  1, 2, 3, 42, 1337, 0x7fffffff, 0x80000000, 0xffffffff,
]);

/** The environment variable that replays one seed instead of the list. */
export const TEST_SEED_ENV = 'JSAILS_TEST_SEED';

const UINT32 = 0x1_0000_0000;

function toSeed(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= UINT32) {
    throw new RangeError('a seed is an integer in [0, 2^32)');
  }
  return value;
}

/** A {@link SeededRandom} starting at `seed` (an integer in `[0, 2^32)`). */
export function seededRandom(seed: number): SeededRandom {
  const start = toSeed(seed);
  let state = start;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min) {
      throw new RangeError('int(min, max) needs safe integers with min < max');
    }
    return min + Math.floor(next() * (max - min));
  };
  return Object.freeze({
    seed: start,
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError('pick() needs a non-empty list');
      }
      return items[int(0, items.length)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = int(0, index + 1);
        [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
      }
      return copy;
    },
    bytes(length: number): Uint8Array {
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError('bytes(length) needs a non-negative integer');
      }
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = Math.floor(next() * 256);
      }
      return out;
    },
  });
}

/** Options for {@link testSeeds} and {@link forEachSeed}. */
export interface TestSeedsOptions {
  /** Replaces {@link FIXED_SEEDS}. */
  readonly fixed?: readonly number[];
  /** Read for {@link TEST_SEED_ENV}; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The source of the fresh seed; defaults to `crypto.randomInt`. */
  readonly fresh?: () => number;
}

/**
 * The seeds a property test runs: the fixed list plus one fresh seed, or only
 * the seed named by {@link TEST_SEED_ENV} when it is set.
 */
export function testSeeds(options: TestSeedsOptions = {}): readonly number[] {
  const env = options.env ?? process.env;
  const pinned = env[TEST_SEED_ENV];
  if (pinned !== undefined && pinned.trim() !== '') {
    if (!/^\d+$/.test(pinned.trim())) {
      throw new RangeError(`${TEST_SEED_ENV} must be an integer in [0, 2^32)`);
    }
    return Object.freeze([toSeed(Number(pinned.trim()))]);
  }
  const fixed = (options.fixed ?? FIXED_SEEDS).map(toSeed);
  const fresh = toSeed(options.fresh?.() ?? randomInt(0, UINT32));
  return Object.freeze(fixed.includes(fresh) ? fixed : [...fixed, fresh]);
}

/**
 * Run `fn` once per seed from {@link testSeeds}, in order, inside the current
 * test. The first failure stops the loop and is rethrown unchanged (so a
 * ledger entry can match its message), after a diagnostic naming the seed and
 * how to replay it. Seeds are not subtests: a subtest title holding a fresh
 * seed would differ on every run.
 */
export async function forEachSeed(
  t: TestContext,
  fn: (random: SeededRandom) => Awaitable<void>,
  options: TestSeedsOptions = {},
): Promise<void> {
  for (const seed of testSeeds(options)) {
    try {
      await fn(seededRandom(seed));
    } catch (error) {
      t.diagnostic(`failed with seed ${seed}; replay with ${TEST_SEED_ENV}=${seed}`);
      throw error;
    }
  }
}
