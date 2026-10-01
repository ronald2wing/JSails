/**
 * Conformance cases for defined caches (`jsails/testing`): the guarantees of
 * `defineCache` held against a real {@link CacheStore}, for both tiers.
 *
 * A harness supplies a fresh, empty root store per case (and optionally a
 * lease store for the `cluster` cases); each case builds one or more
 * "processes" over it, each with its own tag token table and no bus, exactly
 * as separate app processes sharing the store would have. Freshness runs on
 * an injected clock, so no case depends on how fast the store answers;
 * waiting for a second process's sync polls with a generous bound.
 *
 * ```ts
 * for (const entry of defineCacheConformance(harness)) test(entry.name, entry.run);
 * ```
 */

import assert from 'node:assert/strict';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';

import {
  defineCache,
  type Cache,
  type CacheDefinition,
  type CacheServices,
  type CacheTier,
} from '../cache/define-cache.js';
import type { LeaseStore } from '../cache/lease.js';
import type { CacheStore, CacheValue } from '../cache/store.js';
import { createCacheTags, type CacheTags } from '../cache/tag-tokens.js';
import { cacheTagsToken, cacheToken, leaseToken, type CacheService } from '../cache/tokens.js';
import type { ServiceToken } from '../extensions/services.js';
import { FIXED_SEEDS, seededRandom, type SeededRandom } from './seeded-random.js';
import type { StoreConformanceCase } from './store-conformance.js';

/**
 * One store under test for {@link defineCacheConformance}.
 *
 * @public
 */
export interface DefineCacheHarness {
  /** A fresh, empty root store. */
  readonly store: CacheStore;
  /** A lease store shared by the case's processes; the `cluster` cases need it. */
  readonly leases?: LeaseStore;
  /** Release what the harness holds. */
  close(): Promise<void>;
}

/**
 * Builds a fresh {@link DefineCacheHarness} for one case.
 *
 * @public
 */
export type DefineCacheHarnessFactory = () => Promise<DefineCacheHarness>;

/** How long a case waits for something another process must notice. */
const NOTICE_BOUND_MS = 10_000;

/** A sync interval short enough for a case to wait for it. */
const FAST_SYNC_MS = 25;

/** Every definition a case makes lives this long on the case clock. */
const TTL_MS = 60_000;

/** One simulated app process: its own tag table over the shared store. */
interface CacheProcess {
  readonly tags: CacheTags;
  readonly services: CacheServices;
  define<T>(definition: Omit<CacheDefinition<T>, 'now'>): Cache<T>;
}

/** A manual clock for freshness. */
interface Clock {
  now(): number;
  advance(ms: number): void;
}

function manualClock(): Clock {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

/** `store` with every `get` delayed by `ms`, so a lookup is slow to answer. */
function slowReads(store: CacheStore, ms: number): CacheStore {
  const delayed: CacheStore = {
    get: async (key) => {
      await sleep(ms);
      return store.get(key);
    },
    getMany: (keys) => store.getMany(keys),
    set: (key, value, ttlMs) => store.set(key, value, ttlMs),
    add: (key, value, ttlMs) => store.add(key, value, ttlMs),
    delete: (key) => store.delete(key),
    namespace: (name) => slowReads(store.namespace(name), ms),
    close: () => store.close(),
  };
  return delayed;
}

/** `store` whose reads and writes fail once `failing.on` is set. */
function failingStore(store: CacheStore, failing: { on: boolean }): CacheStore {
  const guard = (): void => {
    if (failing.on) throw new Error('store down');
  };
  const wrapped: CacheStore = {
    get: async (key) => {
      guard();
      return store.get(key);
    },
    getMany: async (keys) => {
      guard();
      return store.getMany(keys);
    },
    set: async (key, value: CacheValue, ttlMs) => {
      guard();
      return store.set(key, value, ttlMs);
    },
    add: async (key, value: CacheValue, ttlMs) => {
      guard();
      return store.add(key, value, ttlMs);
    },
    delete: async (key) => {
      guard();
      return store.delete(key);
    },
    namespace: (name) => failingStore(store.namespace(name), failing),
    close: () => store.close(),
  };
  return wrapped;
}

/** Wait until `check` holds, polling, or fail after {@link NOTICE_BOUND_MS}. */
async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + NOTICE_BOUND_MS;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(message);
    await sleep(10);
  }
}

/** A promise and its resolver, for a loader a case releases by hand. */
function gate(): { readonly opened: Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

class CaseContext {
  readonly #harness: DefineCacheHarness;
  readonly #tables: CacheTags[] = [];
  readonly clock = manualClock();

  constructor(harness: DefineCacheHarness) {
    this.#harness = harness;
  }

  get store(): CacheStore {
    return this.#harness.store;
  }

  get leases(): LeaseStore | undefined {
    return this.#harness.leases;
  }

  /** A new process over the shared store. */
  process(options: { syncMs?: number; store?: CacheStore } = {}): CacheProcess {
    const root = options.store ?? this.#harness.store;
    const tags = createCacheTags({
      store: root.namespace('jsails.tags'),
      ...(options.syncMs === undefined ? {} : { syncMs: options.syncMs }),
    });
    this.#tables.push(tags);
    const service: CacheService = { cache: (name) => root.namespace(name) };
    const leases = this.#harness.leases;
    const services: CacheServices = {
      get: <T>(token: ServiceToken<T>): T => {
        if (token === cacheToken) return service as T;
        if (token === cacheTagsToken) return tags as T;
        if (token === leaseToken && leases !== undefined) return leases as T;
        throw new Error(`no service ${token.name}`);
      },
    };
    const clock = this.clock;
    return {
      tags,
      services,
      define: <T>(definition: Omit<CacheDefinition<T>, 'now'>): Cache<T> =>
        defineCache<T>(services, { ...definition, now: clock.now }),
    };
  }

  async close(): Promise<void> {
    for (const table of this.#tables) await table.close();
  }
}

function caseRunner(
  factory: DefineCacheHarnessFactory,
): (name: string, body: (context: CaseContext) => Promise<void>) => StoreConformanceCase {
  return (name, body) => ({
    name,
    async run() {
      const harness = await factory();
      const context = new CaseContext(harness);
      try {
        await body(context);
      } finally {
        await context.close();
        await harness.close();
      }
    },
  });
}

/** A loader over a versioned source that counts its runs. */
function countingLoader(source: { version: number }): {
  readonly load: () => Promise<number>;
  readonly runs: () => number;
} {
  let runs = 0;
  return {
    load: async () => {
      runs += 1;
      return source.version;
    },
    runs: () => runs,
  };
}

/**
 * The randomized invalidation property for one seed: a writer bumps the
 * source version and then invalidates the tag; every get started after an
 * invalidation resolved must return at least that version, however loads,
 * gets and invalidations interleave.
 */
async function invalidationProperty(process: CacheProcess, tier: CacheTier, random: SeededRandom) {
  const cache = process.define<number>({
    name: `property-${tier}-${String(random.seed)}`,
    ttlMs: TTL_MS,
    tier,
    tags: (key) => [`t-${key}`],
  });
  const keys = ['a', 'b'];
  const versions = new Map(keys.map((key) => [key, 0]));
  const confirmed = new Map(keys.map((key) => [key, 0]));
  const pending: Promise<void>[] = [];
  for (let step = 0; step < 60; step += 1) {
    const key = random.pick(keys);
    if (random.next() < 0.3) {
      const version = (versions.get(key) ?? 0) + 1;
      versions.set(key, version);
      pending.push(
        cache.invalidate(`t-${key}`).then(() => {
          confirmed.set(key, Math.max(confirmed.get(key) ?? 0, version));
        }),
      );
    } else {
      const floor = confirmed.get(key) ?? 0;
      const delay = random.int(0, 4);
      pending.push(
        cache
          .get(key, async () => {
            const seen = versions.get(key) ?? 0;
            for (let turn = 0; turn < delay; turn += 1) await nextTurn();
            return seen;
          })
          .then((value) => {
            assert.ok(
              value >= floor,
              `seed ${String(random.seed)}: a get started after the invalidation of version ${String(floor)} returned ${String(value)}`,
            );
          }),
      );
    }
    if (random.next() < 0.5) await nextTurn();
  }
  await Promise.all(pending);
}

/**
 * The defined-cache conformance cases, each run for the `process` and the
 * `shared` tier.
 *
 * @public
 */
export function defineCacheConformance(
  factory: DefineCacheHarnessFactory,
): readonly StoreConformanceCase[] {
  const define = caseRunner(factory);
  const cases: StoreConformanceCase[] = [];
  for (const tier of ['process', 'shared'] as const) {
    const name = (title: string): string => `${tier} tier: ${title}`;

    cases.push(
      define(name('loads once and serves the entry while it is fresh'), async (context) => {
        const cache = context.process().define<number>({ name: 'fresh', ttlMs: TTL_MS, tier });
        const loader = countingLoader({ version: 7 });
        assert.equal(await cache.get('k', loader.load), 7);
        assert.equal(await cache.get('k', loader.load), 7);
        assert.equal(loader.runs(), 1);
        context.clock.advance(TTL_MS);
        assert.equal(await cache.get('k', loader.load), 7);
        assert.equal(loader.runs(), 2, 'an entry past its TTL reloads');
        assert.equal(cache.stats().hits, 1);
      }),

      define(
        name('after invalidate resolves no get returns a pre-invalidation value'),
        async (context) => {
          const process = context.process();
          for (const seed of FIXED_SEEDS) {
            await invalidationProperty(process, tier, seededRandom(seed));
          }
        },
      ),

      define(name('an invalidation during a load never stores its value'), async (context) => {
        const cache = context.process().define<number>({
          name: 'during',
          ttlMs: TTL_MS,
          tier,
          tags: () => ['t'],
        });
        const source = { version: 1 };
        const held = gate();
        let started = false;
        const first = cache.get('k', async () => {
          started = true;
          const seen = source.version;
          await held.opened;
          return seen;
        });
        await eventually(async () => started, 'the load never started');
        source.version = 2;
        await cache.invalidate('t');
        held.open();
        assert.equal(await first, 1, 'the caller that started before still gets its value');
        assert.equal(cache.stats().skipped, 1);
        const loader = countingLoader(source);
        assert.equal(await cache.get('k', loader.load), 2);
        assert.equal(loader.runs(), 1, 'nothing was stored, so the next get loads');
      }),

      define(name('an evicted tag token invalidates'), async (context) => {
        const definition = { name: 'evicted', ttlMs: TTL_MS, tier, tags: () => ['t'] } as const;
        const tokens = context.store.namespace('jsails.tags');
        const source = { version: 1 };
        const warm = context.process({ syncMs: FAST_SYNC_MS }).define<number>(definition);
        assert.equal(await warm.get('k', countingLoader(source).load), 1);
        await tokens.delete('t');
        source.version = 2;
        if (tier === 'shared') {
          // A process that never saw the token mints a new one, under which
          // the stored entry no longer validates.
          const cold = context.process().define<number>(definition);
          assert.equal(await cold.get('k', countingLoader(source).load), 2);
          await tokens.delete('t');
          source.version = 3;
        }
        // The warm process learns of the loss from its sync.
        await eventually(
          async () => (await warm.get('k', countingLoader(source).load)) === source.version,
          'a warm process never noticed its tag token was evicted',
        );
      }),

      define(name('concurrent callers run the loader once'), async (context) => {
        const cache = context.process().define<number>({
          name: 'flight',
          ttlMs: TTL_MS,
          tier,
          tags: () => ['t'],
        });
        const loader = countingLoader({ version: 5 });
        const values = await Promise.all(
          Array.from({ length: 50 }, () => cache.get('k', loader.load)),
        );
        assert.deepEqual(new Set(values), new Set([5]));
        assert.equal(loader.runs(), 1);
      }),

      define(
        name('concurrent callers run the loader once with a slow store get'),
        async (context) => {
          const cache = context
            .process({ store: slowReads(context.store, 30) })
            .define<number>({ name: 'slow', ttlMs: TTL_MS, tier, tags: () => ['t'] });
          const loader = countingLoader({ version: 5 });
          const values = await Promise.all(
            Array.from({ length: 20 }, async (_unused, index) => {
              if (index % 2 === 1) await nextTurn();
              return cache.get('k', loader.load);
            }),
          );
          assert.deepEqual(new Set(values), new Set([5]));
          assert.equal(loader.runs(), 1);
        },
      ),

      define(name('a rejected loader is not cached and strands no waiter'), async (context) => {
        const cache = context.process().define<number>({ name: 'reject', ttlMs: TTL_MS, tier });
        let runs = 0;
        const failing = async (): Promise<number> => {
          runs += 1;
          await nextTurn();
          throw new Error('load failed');
        };
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () => cache.get('k', failing)),
        );
        assert.equal(runs, 1);
        assert.ok(results.every((result) => result.status === 'rejected'));
        assert.equal(await cache.get('k', async () => 9), 9, 'the failure was not stored');
      }),

      define(name('serves stale within staleMs while one caller refreshes'), async (context) => {
        const cache = context.process().define<number>({
          name: 'stale',
          ttlMs: TTL_MS,
          staleMs: TTL_MS,
          tier,
          tags: () => ['t'],
        });
        assert.equal(await cache.get('k', async () => 1), 1);
        context.clock.advance(TTL_MS + 1);
        const held = gate();
        let refreshing = false;
        const refresher = cache.get('k', async () => {
          refreshing = true;
          await held.opened;
          return 2;
        });
        await eventually(async () => refreshing, 'the refresh never started');
        assert.equal(
          await cache.get('k', async () => 3),
          1,
          'a caller during the refresh gets stale',
        );
        held.open();
        assert.equal(await refresher, 2, 'the refreshing caller waits for the new value');
        assert.equal(await cache.get('k', async () => 4), 2);
        context.clock.advance(3 * TTL_MS);
        assert.equal(await cache.get('k', async () => 5), 5, 'past staleMs the entry is gone');
      }),

      define(name('never serves an invalidated entry stale'), async (context) => {
        const cache = context.process().define<number>({
          name: 'stale-invalid',
          ttlMs: TTL_MS,
          staleMs: TTL_MS,
          tier,
          tags: () => ['t'],
        });
        assert.equal(await cache.get('k', async () => 1), 1);
        context.clock.advance(TTL_MS + 1);
        await cache.invalidate('t');
        const held = gate();
        let loading = false;
        const refresher = cache.get('k', async () => {
          loading = true;
          await held.opened;
          return 2;
        });
        await eventually(async () => loading, 'the load never started');
        const joiner = cache.get('k', async () => 3);
        held.open();
        assert.equal(await refresher, 2);
        assert.equal(await joiner, 2, 'the joiner waited instead of getting the invalidated entry');
      }),

      define(name('value tags invalidate the entry'), async (context) => {
        const cache = context.process().define<{ readonly id: string; readonly v: number }>({
          name: 'value-tags',
          ttlMs: TTL_MS,
          tier,
          tags: (key) => [`list:${key}`],
          valueTags: (value) => [`item:${value.id}`],
        });
        assert.deepEqual(await cache.get('k', async () => ({ id: 'x', v: 1 })), { id: 'x', v: 1 });
        assert.deepEqual(await cache.get('k', async () => ({ id: 'x', v: 2 })), { id: 'x', v: 1 });
        await cache.invalidate('item:x');
        assert.deepEqual(await cache.get('k', async () => ({ id: 'x', v: 3 })), { id: 'x', v: 3 });
      }),

      define(name('a store failure loads uncached and never fails the read'), async (context) => {
        const failing = { on: false };
        const cache = context
          .process({ store: failingStore(context.store, failing) })
          .define<number>({ name: 'down', ttlMs: TTL_MS, tier, tags: () => ['t'] });
        failing.on = true;
        assert.equal(await cache.get('k', async () => 1), 1);
        assert.equal(await cache.get('k', async () => 2), 2, 'nothing was stored');
        assert.ok(cache.stats().errors > 0);
        failing.on = false;
        assert.equal(await cache.get('k', async () => 3), 3);
        assert.equal(await cache.get('k', async () => 4), 3, 'cached again once the store is back');
      }),

      define(name('another process sees an invalidation within its sync'), async (context) => {
        const reader = context.process({ syncMs: FAST_SYNC_MS });
        const writer = context.process();
        const definition = { name: 'cross', ttlMs: TTL_MS, tier, tags: () => ['t'] } as const;
        const readCache = reader.define<number>(definition);
        const writeCache = writer.define<number>(definition);
        const source = { version: 1 };
        assert.equal(await readCache.get('k', countingLoader(source).load), 1);
        assert.equal(await readCache.get('k', countingLoader({ version: 99 }).load), 1);
        source.version = 2;
        await writeCache.invalidate('t');
        await eventually(
          async () => (await readCache.get('k', countingLoader(source).load)) === 2,
          'the reader never saw the invalidation',
        );
      }),
    );

    if (tier === 'shared') {
      cases.push(
        define(name('a cluster stampede runs one load across processes'), async (context) => {
          if (context.leases === undefined) return;
          const definition = {
            name: 'cluster',
            ttlMs: TTL_MS,
            tier,
            tags: () => ['t'],
            stampede: 'cluster',
          } as const;
          const first = context.process().define<number>(definition);
          const second = context.process().define<number>(definition);
          const held = gate();
          let runs = 0;
          let started = false;
          const winner = first.get('k', async () => {
            runs += 1;
            started = true;
            await held.opened;
            return 1;
          });
          await eventually(async () => started, 'the winner never started');
          const loser = second.get('k', async () => {
            runs += 1;
            return 2;
          });
          await sleep(10);
          held.open();
          assert.equal(await winner, 1);
          assert.equal(await loser, 1, 'the loser waited for the winner instead of loading');
          assert.equal(runs, 1);
        }),
      );
    }
  }
  return Object.freeze(cases);
}
