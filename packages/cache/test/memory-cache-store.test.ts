/**
 * `MemoryCacheStore`: the cache contract's conformance cases, then the
 * store's own promises, checked against a reference model. Under random
 * operations on a fake clock it answers exactly as a plain least-recently-used
 * model does, never holds more than its byte and entry budgets, and keeps the
 * hottest key through any pressure.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { CacheErrors, type CacheValue } from 'jsails/cache';
import {
  cacheStoreConformance,
  createFakeClock,
  forEachSeed,
  type SeededRandom,
} from 'jsails/testing';

import { MemoryCacheStore } from '../src/index.js';
import { memoryEntryBytes } from '../src/memory-cache-store.js';

for (const entry of cacheStoreConformance(async () => {
  const clock = createFakeClock();
  const store = new MemoryCacheStore({ now: clock.now });
  return {
    store,
    advance: async (ms) => {
      clock.advance(ms);
    },
    close: () => store.close(),
  };
})) {
  test(`MemoryCacheStore conformance: ${entry.name}`, () => entry.run());
}

interface ModelEntry {
  readonly value: CacheValue;
  readonly expiresAt: number;
  readonly bytes: number;
}

/**
 * The reference: a `Map` in recency order with the same expiry and budget
 * rules, written as plainly as possible (whole scans instead of a heap).
 */
class ReferenceLru {
  readonly entries = new Map<string, ModelEntry>();
  readonly #now: () => number;
  readonly #maxBytes: number;
  readonly #maxEntries: number;

  constructor(now: () => number, maxBytes: number, maxEntries: number) {
    this.#now = now;
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
  }

  get bytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  #live(key: string): ModelEntry | undefined {
    const entry = this.entries.get(key);
    if (entry !== undefined && this.#now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): CacheValue | null {
    const entry = this.#live(key);
    if (entry === undefined) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: CacheValue, ttlMs: number): 'too_large' | void {
    const bytes = memoryEntryBytes(key, value);
    if (bytes > this.#maxBytes) return 'too_large';
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.#now() + ttlMs, bytes });
    this.#enforce(key);
  }

  add(key: string, value: CacheValue, ttlMs: number): boolean | 'too_large' {
    if (memoryEntryBytes(key, value) > this.#maxBytes) return 'too_large';
    if (this.#live(key) !== undefined) return false;
    this.set(key, value, ttlMs);
    return true;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  #within(): boolean {
    return this.bytes <= this.#maxBytes && this.entries.size <= this.#maxEntries;
  }

  #enforce(written: string): void {
    if (this.#within()) return;
    for (const [key, entry] of [...this.entries]) {
      if (this.#now() >= entry.expiresAt) this.entries.delete(key);
    }
    for (const key of [...this.entries.keys()]) {
      if (this.#within()) return;
      if (key !== written) this.entries.delete(key);
    }
  }
}

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'ключ', 'κ', '𝄞', 'long-key-name-x'];
const TTLS = [40, 400, 4000];

function randomValue(random: SeededRandom): CacheValue {
  if (random.next() < 0.3) return random.bytes(random.int(0, 50));
  const alphabet = ['x', 'y', 'é', '✓', '𝄞'];
  let text = '';
  for (let length = random.int(0, 40); length > 0; length -= 1) text += random.pick(alphabet);
  return text;
}

function normalize(value: CacheValue | null): unknown {
  return value instanceof Uint8Array ? { bytes: [...value] } : value;
}

async function outcome<T>(run: () => Promise<T>): Promise<T | 'too_large'> {
  try {
    return await run();
  } catch (error) {
    if (CacheErrors.is(error, 'too_large')) return 'too_large';
    throw error;
  }
}

describe('MemoryCacheStore against a reference LRU', () => {
  it('answers every random operation exactly as the reference does', async (t) => {
    await forEachSeed(t, async (random) => {
      const clock = createFakeClock();
      const maxBytes = random.int(120, 400);
      const maxEntries = random.int(3, 10);
      const store = new MemoryCacheStore({ now: clock.now, maxBytes, maxEntries });
      const model = new ReferenceLru(clock.now, maxBytes, maxEntries);
      for (let step = 0; step < 3000; step += 1) {
        const key = random.pick(KEYS);
        const roll = random.next();
        const label = `step ${String(step)}`;
        if (roll < 0.3) {
          assert.deepEqual(normalize(await store.get(key)), normalize(model.get(key)), label);
        } else if (roll < 0.4) {
          const keys = Array.from({ length: random.int(1, 4) }, () => random.pick(KEYS));
          assert.deepEqual(
            (await store.getMany(keys)).map(normalize),
            keys.map((each) => normalize(model.get(each))),
            label,
          );
        } else if (roll < 0.65) {
          const value = randomValue(random);
          const ttl = random.pick(TTLS);
          const expected = model.set(key, value, ttl) ?? undefined;
          assert.equal(await outcome(() => store.set(key, value, ttl)), expected, label);
        } else if (roll < 0.8) {
          const value = randomValue(random);
          const ttl = random.pick(TTLS);
          assert.equal(
            await outcome(() => store.add(key, value, ttl)),
            model.add(key, value, ttl),
            label,
          );
        } else if (roll < 0.9) {
          await store.delete(key);
          model.delete(key);
        } else {
          clock.advance(random.int(1, 120));
        }
        const usage = store.usage();
        assert.ok(usage.bytes <= maxBytes, `${label}: ${String(usage.bytes)} bytes held`);
        assert.ok(usage.entries <= maxEntries, `${label}: ${String(usage.entries)} entries held`);
        assert.equal(usage.bytes, model.bytes, `${label}: bytes`);
        assert.equal(usage.entries, model.entries.size, `${label}: entries`);
      }
    });
  });

  it('keeps the hottest key through pressure of many times its budget', async (t) => {
    await forEachSeed(t, async (random) => {
      const store = new MemoryCacheStore({ maxBytes: 2048, maxEntries: 64 });
      await store.set('hot', 'the value everyone reads', 3_600_000);
      for (let write = 0; write < 2000; write += 1) {
        await store.set(`cold:${String(write)}`, randomValue(random), 3_600_000);
        if (write % 8 === 0) assert.equal(await store.get('hot'), 'the value everyone reads');
      }
      assert.equal(await store.get('hot'), 'the value everyone reads');
      assert.ok(store.usage().bytes <= 2048);
    });
  });
});

describe('MemoryCacheStore budgets', () => {
  it('drops expired entries before evicting a live one', async () => {
    const clock = createFakeClock();
    const store = new MemoryCacheStore({ now: clock.now, maxEntries: 3 });
    await store.set('old', 'v', 10);
    await store.set('live-1', 'v', 60_000);
    await store.set('live-2', 'v', 60_000);
    clock.advance(20);
    await store.set('new', 'v', 60_000);
    assert.deepEqual(await store.getMany(['live-1', 'live-2', 'new']), ['v', 'v', 'v']);
    assert.equal(store.usage().entries, 3);
  });

  it('charges a key and its value as UTF-8 bytes', async () => {
    const store = new MemoryCacheStore();
    await store.set('ké', '✓', 1000);
    await store.set('b', new Uint8Array(7), 1000);
    assert.deepEqual(store.usage(), { entries: 2, bytes: 3 + 3 + 1 + 7 });
    assert.equal(memoryEntryBytes('𝄞', '\ud800x'), 4 + 3 + 1);
  });

  it('refuses an entry larger than the byte budget and changes nothing', async () => {
    const store = new MemoryCacheStore({ maxBytes: 16 });
    await store.set('k', 'small', 60_000);
    await assert.rejects(store.set('k', 'x'.repeat(16), 60_000), (error: unknown) =>
      CacheErrors.is(error, 'too_large'),
    );
    await assert.rejects(store.add('other', new Uint8Array(32), 60_000), (error: unknown) =>
      CacheErrors.is(error, 'too_large'),
    );
    assert.equal(await store.get('k'), 'small');
  });

  it('a refused add leaves recency unchanged', async () => {
    const store = new MemoryCacheStore({ maxEntries: 2 });
    await store.set('first', 'v', 60_000);
    await store.set('second', 'v', 60_000);
    assert.equal(await store.add('first', 'w', 60_000), false);
    await store.set('third', 'v', 60_000);
    assert.equal(await store.get('first'), null, 'first stayed least recently used');
    assert.equal(await store.get('second'), 'v');
  });

  it('close drops every entry', async () => {
    const store = new MemoryCacheStore();
    await store.set('k', 'v', 60_000);
    await store.close();
    assert.deepEqual(store.usage(), { entries: 0, bytes: 0 });
  });

  it('keeps its expiry bookkeeping bounded under rewrites of one key', async () => {
    const store = new MemoryCacheStore({ maxEntries: 4 });
    for (let write = 0; write < 5000; write += 1) await store.set('k', String(write), 60_000);
    assert.equal(await store.get('k'), '4999');
    assert.equal(store.usage().entries, 1);
  });

  it('refuses malformed options with value-free errors', () => {
    const invalid = (option: unknown, run: () => unknown): void => {
      assert.throws(run, (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'invalid_option'));
        assert.deepEqual(error.context, { option });
        return true;
      });
    };
    invalid('MemoryCacheStore', () => new MemoryCacheStore(null as never));
    invalid('MemoryCacheStore', () => new MemoryCacheStore([] as never));
    invalid('now', () => new MemoryCacheStore({ now: 5 as never }));
    invalid('maxBytes', () => new MemoryCacheStore({ maxBytes: 0 }));
    invalid('maxBytes', () => new MemoryCacheStore({ maxBytes: 1.5 }));
    invalid('maxEntries', () => new MemoryCacheStore({ maxEntries: -1 }));
  });
});
