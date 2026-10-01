/**
 * A seeded pseudo-random generator for the tenancy property tests.
 *
 * mulberry32: same seed, same sequence, so a failing property names the seed
 * that reproduces it. Test-only; it is replaced by the framework's seeded
 * random source once `jsails/testing` provides one.
 */

/** A seeded random source. */
export interface SeededPrng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, max). */
  int(max: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A string of `length` characters drawn from `alphabet`. */
  string(alphabet: string, length: number): string;
}

/** Create a {@link SeededPrng} from a 32-bit seed. */
export function seededPrng(seed: number): SeededPrng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number): number => Math.floor(next() * max);
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) {
        throw new RangeError('pick from an empty list');
      }
      return item;
    },
    string(alphabet: string, length: number): string {
      let out = '';
      for (let i = 0; i < length; i += 1) {
        out += alphabet[int(alphabet.length)] ?? '';
      }
      return out;
    },
  };
}
