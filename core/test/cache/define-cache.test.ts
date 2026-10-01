/**
 * `defineCache`: the conformance cases over core's Map doubles, then what the
 * cases do not reach — definition checks, one name per application, the
 * shared tier's envelope, codec and size cap, the loader's detached context,
 * the cluster stampede's fallbacks, how it meets the tag table (a full table,
 * cold reads across an invalidation, a remote invalidation of a value tag),
 * and the cache slot.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import {
  CacheErrors,
  cacheTagsToken,
  cacheToken,
  createCacheSlot,
  createCacheTags,
  defineCache,
  leaseToken,
  type CacheDefinition,
  type CacheServices,
  type CacheTagBus,
  type CacheTagBusHandlers,
  type CacheTags,
  type CacheTagsOptions,
  type LeaseStore,
} from '../../src/cache/index.js';
import { createContextKey, getContext, withContext } from '../../src/context/index.js';
import type { ServiceToken } from '../../src/extensions/services.js';
import { defineCacheConformance } from '../../src/testing/index.js';
import { MapCacheStore, MapLeaseStore } from './map-cache-store.js';

for (const entry of defineCacheConformance(async () => {
  const store = new MapCacheStore();
  const leases = new MapLeaseStore();
  return {
    store,
    leases,
    close: async () => {
      await leases.close();
      await store.close();
    },
  };
})) {
  test(`MapCacheStore: ${entry.name}`, () => entry.run());
}

interface App {
  readonly store: MapCacheStore;
  readonly tags: CacheTags;
  readonly services: CacheServices;
}

/**
 * An app over a fresh Map store, its tag tokens in the `jsails.tags`
 * namespace; its tag table closes with the test.
 */
function app(
  t: { after(fn: () => Promise<void>): void },
  leases?: LeaseStore,
  store: MapCacheStore = new MapCacheStore(),
  tagOptions: Omit<CacheTagsOptions, 'store'> = {},
): App {
  const tags = createCacheTags({ ...tagOptions, store: store.namespace('jsails.tags') });
  t.after(() => tags.close());
  const services: CacheServices = {
    get: <T>(token: ServiceToken<T>): T => {
      if (token === cacheToken) return { cache: (name: string) => store.namespace(name) } as T;
      if (token === cacheTagsToken) return tags as T;
      if (token === leaseToken && leases !== undefined) return leases as T;
      throw new Error('service not provided');
    },
  };
  return { store, tags, services };
}

function rejectsOption(run: () => unknown, option: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(CacheErrors.is(error, 'invalid_option'), String(error));
    assert.deepEqual(error.context, { option });
    return true;
  });
}

const base: CacheDefinition<number> = { name: 'c', ttlMs: 1000, tier: 'process' };

describe('defineCache definition checks', () => {
  it('refuses a malformed definition with the option it names', (t) => {
    const { services } = app(t);
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'name'],
      [{ name: '.hidden' }, 'name'],
      [{ name: 'a'.repeat(65) }, 'name'],
      [{ name: 'has:colon' }, 'name'],
      [{ ttlMs: 0 }, 'ttlMs'],
      [{ ttlMs: 1.5 }, 'ttlMs'],
      [{ staleMs: -1 }, 'staleMs'],
      [{ staleMs: 0.5 }, 'staleMs'],
      [{ tier: 'disk' }, 'tier'],
      [{ tags: 'x' }, 'tags'],
      [{ valueTags: () => ['v'] }, 'tags'],
      [{ now: 5 }, 'now'],
      [{ codec: { encode: String, decode: Number } }, 'codec'],
      [{ maxBytes: 10 }, 'maxBytes'],
      [{ maxEntries: 0 }, 'maxEntries'],
      [{ stampede: 'cluster' }, 'stampede'],
      [{ stampede: 'everywhere' }, 'stampede'],
      [{ tier: 'shared', maxEntries: 5 }, 'maxEntries'],
      [{ tier: 'shared', maxBytes: 0 }, 'maxBytes'],
      [{ tier: 'shared', codec: { encode: String } }, 'codec'],
    ];
    for (const [patch, option] of cases) {
      rejectsOption(() => defineCache(services, { ...base, ...patch }), option);
    }
    rejectsOption(
      () => defineCache(services, null as unknown as CacheDefinition<number>),
      'defineCache',
    );
  });

  it('allows one cache per name in an application, and the same name in another', (t) => {
    const first = app(t);
    defineCache(first.services, base);
    assert.throws(
      () => defineCache(first.services, base),
      (error: unknown) => CacheErrors.is(error, 'duplicate_cache'),
    );
    defineCache(app(t).services, base);
  });

  it('needs the lease store for a cluster stampede', (t) => {
    assert.throws(() =>
      defineCache(app(t).services, { ...base, tier: 'shared', stampede: 'cluster' }),
    );
    defineCache(app(t, new MapLeaseStore()).services, {
      ...base,
      tier: 'shared',
      stampede: 'cluster',
    });
  });

  it('rejects a get with a malformed key, loader, or tag', async (t) => {
    const { services } = app(t);
    const cache = defineCache(services, { ...base, tags: (key) => [key] });
    await assert.rejects(
      cache.get('', async () => 1),
      (error: unknown) => CacheErrors.is(error, 'invalid_key'),
    );
    await assert.rejects(
      cache.get('k', 'load' as unknown as () => Promise<number>),
      (error: unknown) => CacheErrors.is(error, 'invalid_option'),
    );
    await assert.rejects(
      cache.get('has space', async () => 1),
      (error: unknown) => CacheErrors.is(error, 'invalid_tag'),
    );
    const many = defineCache(services, {
      ...base,
      name: 'many',
      tags: () => Array.from({ length: 33 }, (_unused, index) => `t${String(index)}`),
    });
    await assert.rejects(
      many.get('k', async () => 1),
      (error: unknown) => CacheErrors.is(error, 'too_many_tags'),
    );
    await assert.rejects(cache.invalidate('bad tag'), (error: unknown) =>
      CacheErrors.is(error, 'invalid_tag'),
    );
  });

  it('needs a key tag on every key of a cache with value tags', async (t) => {
    const cache = defineCache(app(t).services, {
      ...base,
      tags: (key) => (key === 'untagged' ? [] : ['k']),
      valueTags: () => ['v'],
    });
    assert.equal(await cache.get('tagged', async () => 1), 1);
    await assert.rejects(
      cache.get('untagged', async () => 1),
      (error: unknown) => CacheErrors.is(error, 'invalid_option'),
    );
  });
});

describe('defineCache process tier', () => {
  it('drops the least recently used entry beyond maxEntries', async (t) => {
    const cache = defineCache(app(t).services, { ...base, maxEntries: 2 });
    let loads = 0;
    const load = (value: number) => async () => {
      loads += 1;
      return value;
    };
    await cache.get('a', load(1));
    await cache.get('b', load(2));
    await cache.get('a', load(1));
    await cache.get('c', load(3));
    assert.equal(cache.stats().evictions, 1);
    loads = 0;
    assert.equal(await cache.get('a', load(10)), 1, 'the recently read entry stayed');
    assert.equal(await cache.get('b', load(20)), 20, 'the least recently used one went');
    assert.equal(loads, 1);
  });

  it('holds values by reference, never in the store', async (t) => {
    const { services, store } = app(t);
    const cache = defineCache<{ n: number }>(services, {
      name: 'refs',
      ttlMs: 1000,
      tier: 'process',
      tags: () => ['t'],
    });
    const value = { n: 1 };
    assert.equal(await cache.get('k', async () => value), value);
    assert.equal(await cache.get('k', async () => ({ n: 2 })), value);
    assert.deepEqual(
      [...store.entries.keys()].filter((key) => key.startsWith('jsails.defined')),
      [],
    );
  });

  it('serves a warm hit with no store round trip', async (t) => {
    const { services, store } = app(t);
    const cache = defineCache(services, { ...base, tags: () => ['t'] });
    await cache.get('k', async () => 1);
    const before = store.calls.length;
    for (let index = 0; index < 10; index += 1) await cache.get('k', async () => 2);
    assert.equal(store.calls.length, before);
  });
});

describe('defineCache shared tier', () => {
  it('stores an envelope the next process validates, and reads it with no load', async (t) => {
    const store = new MapCacheStore();
    const first = defineCache<{ n: number }>(app(t, undefined, store).services, {
      name: 's',
      ttlMs: 60_000,
      tier: 'shared',
      tags: () => ['t'],
    });
    assert.deepEqual(await first.get('k', async () => ({ n: 1 })), { n: 1 });
    const raw = await store.namespace('jsails.defined').namespace('s').get('k');
    assert.equal(typeof raw, 'string');
    assert.match(raw as string, /^\{"v":1,.*\}\n\{"n":1\}$/u);
    const second = defineCache<{ n: number }>(app(t, undefined, store).services, {
      name: 's',
      ttlMs: 60_000,
      tier: 'shared',
      tags: () => ['t'],
    });
    assert.deepEqual(await second.get('k', async () => ({ n: 2 })), { n: 1 });
  });

  it('round-trips bytes through a codec', async (t) => {
    const cache = defineCache<Uint8Array>(app(t).services, {
      name: 'bytes',
      ttlMs: 60_000,
      tier: 'shared',
      codec: {
        encode: (value) => value,
        decode: (raw) => (typeof raw === 'string' ? new TextEncoder().encode(raw) : raw),
      },
    });
    const bytes = Uint8Array.of(0x0a, 0, 255, 0x0a);
    assert.deepEqual([...(await cache.get('k', async () => bytes))], [...bytes]);
    assert.deepEqual([...(await cache.get('k', async () => Uint8Array.of(1)))], [...bytes]);
  });

  it('returns an oversized value without storing it', async (t) => {
    const cache = defineCache<string>(app(t).services, {
      name: 'big',
      ttlMs: 60_000,
      tier: 'shared',
      maxBytes: 64,
    });
    assert.equal(await cache.get('k', async () => 'x'.repeat(100)), 'x'.repeat(100));
    assert.equal(await cache.get('k', async () => 'y'), 'y');
    assert.equal(cache.stats().skipped, 1);
  });

  it('counts a value the codec cannot encode and still returns it', async (t) => {
    const cache = defineCache<undefined>(app(t).services, {
      name: 'undefined',
      ttlMs: 60_000,
      tier: 'shared',
    });
    assert.equal(await cache.get('k', async () => undefined), undefined);
    assert.equal(cache.stats().errors, 1);
  });

  it('treats a foreign or corrupted entry as a miss', async (t) => {
    const { services, store } = app(t);
    const cache = defineCache<number>(services, { name: 'foreign', ttlMs: 60_000, tier: 'shared' });
    const values = store.namespace('jsails.defined').namespace('foreign');
    for (const raw of ['plain', '{"v":2}\n1', 'not json\n1', Uint8Array.of(1, 2)]) {
      await values.set('k', raw, 60_000);
      assert.equal(await cache.get('k', async () => 7), 7);
      await values.delete('k');
    }
  });
});

describe('defineCache loader context', () => {
  it("runs the loader in the context the cache was defined in, not the caller's", async (t) => {
    const tenant = createContextKey<string>('test.cache.tenant');
    const cache = defineCache<string | undefined>(app(t).services, {
      name: 'context',
      ttlMs: 1000,
      tier: 'process',
    });
    const seen = await withContext(tenant, 'caller', () =>
      cache.get('k', async () => getContext(tenant)),
    );
    assert.equal(seen, undefined);
  });
});

describe('defineCache cluster stampede', () => {
  it('loads without coordination when the lease store fails', async (t) => {
    const leases = new MapLeaseStore();
    leases.failWith = new Error('lease store down');
    const cache = defineCache<number>(app(t, leases).services, {
      name: 'cluster',
      ttlMs: 60_000,
      tier: 'shared',
      stampede: 'cluster',
    });
    assert.equal(await cache.get('k', async () => 1), 1);
    assert.equal(cache.stats().errors, 1);
  });

  it('rejects with the loader error, not as a lease failure', async (t) => {
    const cache = defineCache<number>(app(t, new MapLeaseStore()).services, {
      name: 'cluster',
      ttlMs: 60_000,
      tier: 'shared',
      stampede: 'cluster',
    });
    let runs = 0;
    await assert.rejects(
      cache.get('k', async () => {
        runs += 1;
        throw new Error('load failed');
      }),
      /load failed/u,
    );
    assert.equal(runs, 1);
  });

  it('keys the lease by a fixed-length digest of the key', async (t) => {
    const leases = new MapLeaseStore();
    const cache = defineCache<number>(app(t, leases).services, {
      name: 'cluster',
      ttlMs: 60_000,
      tier: 'shared',
      stampede: 'cluster',
    });
    assert.equal(await cache.get('k'.repeat(1024), async () => 1), 1);
    assert.deepEqual(leases.calls.slice(0, 2), ['acquire', 'release']);
  });
});

/** A bus whose one subscriber the test drives, as another process would. */
function drivenBus(): { bus: CacheTagBus; subscriber: () => CacheTagBusHandlers } {
  let handlers: CacheTagBusHandlers | undefined;
  return {
    bus: {
      publish: async () => undefined,
      subscribe: async (subscriber) => {
        handlers = subscriber;
        return async () => undefined;
      },
    },
    subscriber: () => {
      assert.ok(handlers !== undefined, 'the table never subscribed');
      return handlers;
    },
  };
}

describe('defineCache over the tag table', () => {
  it('keeps single flight and stores its loads when the tag table is full', async (t) => {
    const { tags, services } = app(t, undefined, new MapCacheStore(), { syncMs: 3_600_000 });
    const names = Array.from({ length: 10_000 }, (_unused, index) => `fill-${String(index)}`);
    for (let start = 0; start < names.length; start += 32) {
      await tags.tokens(names.slice(start, start + 32));
    }
    const cache = defineCache<number>(services, {
      ...base,
      ttlMs: 60_000,
      tags: (key) => [`item-${key}`],
    });
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      return loads;
    };
    assert.equal(await cache.get('a', load), 1);
    assert.equal(await cache.get('a', load), 1, 'a load whose own tag was cold is stored');

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowLoads = 0;
    const slow = async (): Promise<number> => {
      slowLoads += 1;
      await held;
      return 0;
    };
    const first = Array.from({ length: 5 }, () => cache.get('b', slow));
    // Another key's cold tag drops one more from the table while b loads.
    assert.equal(await cache.get('c', load), 2);
    const second = Array.from({ length: 5 }, () => cache.get('b', slow));
    release();
    assert.deepEqual(
      await Promise.all([...first, ...second]),
      Array.from({ length: 10 }, () => 0),
    );
    assert.equal(slowLoads, 1, 'every caller of b joined one load');
    const stats = cache.stats();
    assert.equal(stats.coalesced, 9);
    assert.equal(stats.skipped, 0);
  });

  for (const tier of ['process', 'shared'] as const) {
    it(`never validates a ${tier} entry with a cold read begun before an invalidation`, async (t) => {
      const store = new MapCacheStore();
      const { bus, subscriber } = drivenBus();
      const { services } = app(t, undefined, store, { bus });
      const tagStore = store.namespace('jsails.tags');
      const cache = defineCache<string>(services, {
        name: 'c',
        ttlMs: 60_000,
        tier,
        tags: (key) => [`key.${key}`],
        valueTags: () => ['t'],
      });
      const other = defineCache<string>(services, {
        name: 'o',
        ttlMs: 60_000,
        tier,
        tags: () => ['t'],
      });
      assert.equal(await cache.get('k', async () => 'v1'), 'v1');
      subscriber().gap();
      // Another key's lookup starts a cold read of `t`, held before it answers.
      const held = tagStore.holdNextGetMany();
      const slow = other.get('k2', async () => 'other');
      await held.began;
      await cache.invalidate('t');
      subscriber().gap();
      const fallback = setTimeout(held.release, 2000);
      const after = await cache.get('k', async () => 'v2');
      clearTimeout(fallback);
      held.release();
      assert.equal(after, 'v2', 'a get after the invalidation never serves the value before it');
      assert.equal(await slow, 'other');
    });

    it(`does not store a ${tier} load whose value tag another process invalidated meanwhile`, async (t) => {
      const store = new MapCacheStore();
      const { bus, subscriber } = drivenBus();
      const { services } = app(t, undefined, store, { bus });
      const cache = defineCache<string>(services, {
        name: 'c',
        ttlMs: 60_000,
        tier,
        tags: (key) => [`key.${key}`],
        valueTags: () => ['vt'],
      });
      const value = await cache.get('k', async () => {
        // The data this load read changes elsewhere, which writes a new token
        // for a tag this process has never read and announces it.
        await store.namespace('jsails.tags').set('vt', 'remote', 60_000);
        subscriber().message(JSON.stringify({ v: 1, o: 'elsewhere', t: ['vt'] }));
        return 'v1';
      });
      assert.equal(value, 'v1');
      assert.equal(cache.stats().skipped, 1);
      assert.equal(await cache.get('k', async () => 'v2'), 'v2');
    });
  }
});

describe('createCacheSlot', () => {
  it('loads directly until bound, routes through the bound cache, and unbinds only its own', async (t) => {
    const slot = createCacheSlot<number>('slot');
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      return loads;
    };
    assert.equal(await slot.cache.get('k', load), 1);
    assert.equal(await slot.cache.get('k', load), 2);
    await slot.cache.invalidate('t');
    assert.equal(slot.cache.stats().misses, 0);

    const { services } = app(t);
    const first = defineCache<number>(services, { ...base, name: 'one', tags: () => ['t'] });
    const unbindFirst = slot.bind(first);
    assert.equal(await slot.cache.get('k', load), 3);
    assert.equal(await slot.cache.get('k', load), 3);
    await slot.cache.invalidate('t');
    assert.equal(await slot.cache.get('k', load), 4);
    assert.equal(slot.cache.stats().misses, 2);

    const second = defineCache<number>(services, { ...base, name: 'two' });
    const unbindSecond = slot.bind(second);
    unbindFirst();
    assert.equal(await slot.cache.get('k', load), 5);
    assert.equal(
      await slot.cache.get('k', load),
      5,
      'the second binding survived the first unbind',
    );
    unbindSecond();
    assert.equal(await slot.cache.get('k', load), 6);
  });

  it('refuses a malformed name', () => {
    rejectsOption(() => createCacheSlot(''), 'name');
  });
});
