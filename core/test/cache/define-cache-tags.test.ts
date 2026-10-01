/**
 * The tag token table behind `defineCache`: minting and single-flight cold
 * reads (never joined or installed across a change), local invalidation
 * before the store write, bus messages and gaps, the subscription (waited for
 * only while the bus is healthy, retried with a backoff), the sync backstop
 * (installs, losses, failures, never reverting a write in flight, never
 * starved by a busy bus), the bounded local table, and closing.
 */

import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';

import {
  CacheErrors,
  createCacheTags,
  type CacheStore,
  type CacheTagBus,
  type CacheTagBusHandlers,
  type CacheTags,
  type CacheTagsOptions,
} from '../../src/cache/index.js';
import { MapCacheStore } from './map-cache-store.js';

/** An in-process bus several tables share, as processes share Valkey. */
class FakeBus implements CacheTagBus {
  readonly published: string[] = [];
  readonly handlers = new Set<CacheTagBusHandlers>();
  subscribes = 0;
  unsubscribes = 0;
  failPublish: Error | undefined;
  failSubscribe: Error | undefined;
  /** When set, a subscribe waits for it before succeeding or failing. */
  holdSubscribe: Promise<void> | undefined;
  failUnsubscribe: Error | undefined;

  async publish(message: string): Promise<void> {
    if (this.failPublish !== undefined) throw this.failPublish;
    this.published.push(message);
    for (const handler of this.handlers) handler.message(message);
  }

  async subscribe(handlers: CacheTagBusHandlers): Promise<() => Promise<void>> {
    this.subscribes += 1;
    if (this.holdSubscribe !== undefined) await this.holdSubscribe;
    if (this.failSubscribe !== undefined) throw this.failSubscribe;
    this.handlers.add(handlers);
    return async () => {
      this.unsubscribes += 1;
      this.handlers.delete(handlers);
      if (this.failUnsubscribe !== undefined) throw this.failUnsubscribe;
    };
  }

  /** Deliver a raw message, as a foreign publisher would. */
  send(message: string): void {
    for (const handler of this.handlers) handler.message(message);
  }

  gap(): void {
    for (const handler of this.handlers) handler.gap();
  }
}

function table(
  t: { after(fn: () => Promise<void>): void },
  options: Partial<CacheTagsOptions> & { store?: CacheStore } = {},
): { tags: CacheTags; store: CacheStore } {
  const store = options.store ?? new MapCacheStore();
  const tags = createCacheTags({ ...options, store });
  t.after(() => tags.close());
  return { tags, store };
}

/** Fill a table's 10 000 local tags, `t0` to `t9999`. */
async function fill(tags: CacheTags): Promise<void> {
  const names = Array.from({ length: 10_000 }, (_unused, index) => `t${String(index)}`);
  for (let start = 0; start < names.length; start += 32) {
    await tags.tokens(names.slice(start, start + 32));
  }
}

async function waitUntil(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(message);
    await sleep(5);
  }
}

describe('createCacheTags tokens', () => {
  it('mints a missing token once, then serves it warm with no round trip', async (t) => {
    const store = new MapCacheStore();
    const { tags } = table(t, { store });
    const [first] = await tags.tokens(['t']);
    assert.equal(typeof first, 'string');
    assert.equal(await store.get('t'), first);
    const calls = store.calls.length;
    assert.deepEqual(await tags.tokens(['t', 't']), [first, first]);
    assert.equal(store.calls.length, calls);
    assert.deepEqual(await tags.tokens([]), []);
  });

  it('reads concurrent cold tags in one getMany', async (t) => {
    const store = new MapCacheStore();
    await store.set('a', 'token-a', 60_000);
    await store.set('b', 'token-b', 60_000);
    const seeded = store.calls.length;
    const { tags } = table(t, { store });
    const results = await Promise.all([
      tags.tokens(['a', 'b']),
      tags.tokens(['b', 'a']),
      tags.tokens(['a']),
    ]);
    assert.deepEqual(results, [['token-a', 'token-b'], ['token-b', 'token-a'], ['token-a']]);
    assert.deepEqual(store.calls.slice(seeded), ['getMany']);
  });

  it('adopts the token another reader minted first', async (t) => {
    const store = new MapCacheStore();
    const raced: CacheStore = {
      get: (key) => store.get(key),
      getMany: (keys) => store.getMany(keys),
      set: (key, value, ttlMs) => store.set(key, value, ttlMs),
      add: async (key) => {
        await store.set(key, 'winner', 60_000);
        return false;
      },
      delete: (key) => store.delete(key),
      namespace: (name) => store.namespace(name),
      close: () => store.close(),
    };
    const { tags } = table(t, { store: raced });
    assert.deepEqual(await tags.tokens(['t']), ['winner']);
  });

  it('replaces a token that is not a string', async (t) => {
    const store = new MapCacheStore();
    await store.set('t', Uint8Array.of(1), 60_000);
    const { tags } = table(t, { store });
    const [token] = await tags.tokens(['t']);
    assert.equal(await store.get('t'), token);
  });

  it('rejects a malformed tag and a backend failure', async (t) => {
    const store = new MapCacheStore();
    const { tags } = table(t, { store });
    await assert.rejects(tags.tokens(['bad tag']), (error: unknown) =>
      CacheErrors.is(error, 'invalid_tag'),
    );
    store.failWith = new CacheErrors.Error('unavailable', { store: 'cache' });
    await assert.rejects(tags.tokens(['t']), (error: unknown) =>
      CacheErrors.is(error, 'unavailable'),
    );
  });

  it('never lends a cold read that began before an invalidation to a read after it', async (t) => {
    const store = new MapCacheStore();
    await store.set('t', 'T0', 60_000);
    const bus = new FakeBus();
    const { tags } = table(t, { store, bus });
    await tags.tokens(['other']);
    const held = store.holdNextGetMany();
    const before = tags.tokens(['t']);
    await held.began;
    await tags.invalidate(['t']);
    const stored = await store.get('t');
    // Something marks the tag cold again while the first read is held.
    bus.gap();
    // Released only once the later read settles, or after a while if it joined
    // the held read; either way the test ends.
    const fallback = setTimeout(held.release, 2000);
    const after = await tags.tokens(['t']);
    clearTimeout(fallback);
    held.release();
    assert.deepEqual(after, [stored], 'the read after the invalidation sees it');
    assert.deepEqual(await before, ['T0'], 'the earlier read answers as of its start');
  });

  it('neither lends nor installs a cold read its tag was invalidated during', async (t) => {
    const store = new MapCacheStore();
    await store.set('t', 'T0', 60_000);
    const bus = new FakeBus();
    const reader = table(t, { store, bus }).tags;
    const writer = table(t, { store, bus }).tags;
    await reader.tokens(['other']);
    const held = store.holdNextGetMany();
    const before = reader.tokens(['t']);
    await held.began;
    const sequence = reader.sequence;
    await writer.invalidate(['t']);
    assert.ok(reader.sequence > sequence, 'the message moved the sequence of a tag being read');
    const stored = await store.get('t');
    const fallback = setTimeout(held.release, 2000);
    const after = await reader.tokens(['t']);
    clearTimeout(fallback);
    held.release();
    assert.deepEqual(after, [stored], 'a read after the message sees the new token');
    assert.deepEqual(await before, ['T0']);
    assert.deepEqual(await reader.tokens(['t']), [stored], 'the earlier read was not installed');
  });
});

describe('createCacheTags invalidate', () => {
  it('changes the local token and the sequence before the store write lands', async (t) => {
    const store = new MapCacheStore();
    const { tags } = table(t, { store });
    const [before] = await tags.tokens(['t']);
    const sequence = tags.sequence;
    const writing = tags.invalidate(['t', 't']);
    assert.ok(tags.sequence > sequence);
    const [during] = await tags.tokens(['t']);
    assert.notEqual(during, before);
    await writing;
    assert.equal(await store.get('t'), during);
  });

  it('rejects when the store could not record it', async (t) => {
    const store = new MapCacheStore();
    const { tags } = table(t, { store });
    store.failWith = new CacheErrors.Error('unavailable', { store: 'cache' });
    await assert.rejects(tags.invalidate(['t']), (error: unknown) =>
      CacheErrors.is(error, 'unavailable'),
    );
  });

  it('refuses more than 32 tags and a malformed one', async (t) => {
    const { tags } = table(t);
    await assert.rejects(
      tags.invalidate(Array.from({ length: 33 }, (_unused, index) => `t${String(index)}`)),
      (error: unknown) => CacheErrors.is(error, 'too_many_tags'),
    );
    await assert.rejects(tags.invalidate(['bad tag']), (error: unknown) =>
      CacheErrors.is(error, 'invalid_tag'),
    );
    await tags.invalidate([]);
  });

  it('publishes to the other tables, which re-read the tag, and ignores its own message', async (t) => {
    const store = new MapCacheStore();
    const bus = new FakeBus();
    const writer = table(t, { store, bus }).tags;
    const reader = table(t, { store, bus }).tags;
    const [initial] = await reader.tokens(['t']);
    await writer.tokens(['t']);
    const writerSequence = writer.sequence;
    const readerSequence = reader.sequence;
    await writer.invalidate(['t']);
    assert.equal(bus.published.length, 1);
    assert.equal(writer.sequence, writerSequence + 1, 'its own message changed nothing more');
    assert.equal(reader.sequence, readerSequence + 1, 'the reader marked the tag cold');
    const [after] = await reader.tokens(['t']);
    assert.notEqual(after, initial);
    assert.deepEqual(await writer.tokens(['t']), [after]);
  });

  it('tolerates a failed publish and reports it once per outage', async (t) => {
    const bus = new FakeBus();
    const errors: unknown[] = [];
    const { tags, store } = table(t, { bus, onError: (error) => errors.push(error) });
    await tags.tokens(['t']);
    bus.failPublish = new Error('bus down');
    await tags.invalidate(['t']);
    await tags.invalidate(['t']);
    assert.equal(errors.length, 1);
    assert.deepEqual(await store.get('t'), (await tags.tokens(['t']))[0]);
  });
});

describe('createCacheTags bus', () => {
  it('subscribes before the first cold read, once, and unsubscribes on close', async (t) => {
    const bus = new FakeBus();
    const store = new MapCacheStore();
    const { tags } = table(t, { bus, store });
    let open!: () => void;
    bus.holdSubscribe = new Promise((resolve) => {
      open = resolve;
    });
    const first = tags.tokens(['a']);
    await sleep(10);
    assert.deepEqual(store.calls, [], 'the first read waits for the subscription');
    open();
    await first;
    await tags.tokens(['b']);
    assert.equal(bus.subscribes, 1);
    await tags.close();
    assert.equal(bus.unsubscribes, 1);
  });

  it('unsubscribes a subscription that lands after close, and reports if that fails', async (t) => {
    for (const failure of [undefined, new Error('unsubscribe failed')]) {
      const bus = new FakeBus();
      bus.failUnsubscribe = failure;
      let open!: () => void;
      bus.holdSubscribe = new Promise((resolve) => {
        open = resolve;
      });
      const errors: unknown[] = [];
      const { tags } = table(t, { bus, onError: (error) => errors.push(error) });
      const reading = tags.tokens(['a']);
      const closing = tags.close();
      open();
      await closing;
      assert.equal(bus.unsubscribes, 1);
      assert.equal(bus.handlers.size, 0);
      assert.deepEqual(errors, failure === undefined ? [] : [failure]);
      await reading;
    }
  });

  it('neither waits for nor retries a failed subscription on each cold read', async (t) => {
    const bus = new FakeBus();
    bus.failSubscribe = new Error('subscriber down');
    const errors: unknown[] = [];
    const { tags } = table(t, { bus, syncMs: 3_600_000, onError: (error) => errors.push(error) });
    await tags.tokens(['a']);
    assert.equal(bus.subscribes, 1);
    assert.equal(errors.length, 1);
    bus.failSubscribe = undefined;
    await tags.tokens(['b']);
    await tags.tokens(['c']);
    assert.equal(bus.subscribes, 1, 'no attempt before the backoff passes');
  });

  it('retries from the sync while reads go on, and re-reads every tag once subscribed', async (t) => {
    const bus = new FakeBus();
    bus.failSubscribe = new Error('subscriber down');
    const { tags } = table(t, { bus, syncMs: 20 });
    await tags.tokens(['a']);
    let open!: () => void;
    bus.holdSubscribe = new Promise((resolve) => {
      open = resolve;
    });
    bus.failSubscribe = undefined;
    await waitUntil(() => bus.subscribes === 2, 'the sync never retried the subscription');
    let read = false;
    const reading = tags.tokens(['b']).then(() => {
      read = true;
    });
    await waitUntil(() => read, 'a cold read waited for a subscription retry');
    await reading;
    const sequence = tags.sequence;
    open();
    await waitUntil(
      () => tags.sequence > sequence,
      'tokens read while unsubscribed were not re-read once subscribed',
    );
    const subscribed = tags.sequence;
    bus.send('{"v":1,"o":"x","t":["a"]}');
    assert.equal(tags.sequence, subscribed + 1, 'the retried subscription delivers');
    assert.equal(bus.subscribes, 2);
  });

  it('ignores malformed messages and its own, and moves on every other', async (t) => {
    const bus = new FakeBus();
    const store = new MapCacheStore();
    const { tags } = table(t, { bus, store });
    await tags.tokens(['t']);
    const sequence = tags.sequence;
    for (const message of [
      'not json',
      'null',
      '{"v":2,"o":"x","t":["t"]}',
      '{"v":1,"t":["t"]}',
      '{"v":1,"o":"x","t":"t"}',
      '{"v":1,"o":"x","t":["bad tag"]}',
      JSON.stringify({ v: 1, o: 'x', t: Array.from({ length: 33 }, () => 't') }),
    ]) {
      bus.send(message);
    }
    assert.equal(tags.sequence, sequence);
    bus.send('{"v":1,"o":"x","t":["unknown"]}');
    assert.equal(tags.sequence, sequence + 1, 'a tag the table does not hold may be in use yet');
    const calls = store.calls.length;
    await tags.tokens(['t']);
    assert.equal(store.calls.length, calls, 't stayed warm');
    bus.send('{"v":1,"o":"x","t":["t"]}');
    assert.equal(tags.sequence, sequence + 2);
    await tags.tokens(['t']);
    assert.equal(store.calls.length, calls + 1, 't is read again');
  });

  it('marks every tag cold on a gap', async (t) => {
    const bus = new FakeBus();
    const store = new MapCacheStore();
    const { tags } = table(t, { bus, store });
    await tags.tokens(['a', 'b']);
    const sequence = tags.sequence;
    bus.gap();
    assert.equal(tags.sequence, sequence + 1);
    const calls = store.calls.length;
    await tags.tokens(['a', 'b']);
    assert.equal(store.calls.length, calls + 1, 'both were read again');
  });
});

describe('createCacheTags sync', () => {
  it('installs a changed token and forgets a lost one', async (t) => {
    const store = new MapCacheStore();
    const { tags } = table(t, { store, syncMs: 10 });
    const [a] = await tags.tokens(['a']);
    await tags.tokens(['b']);
    await store.set('a', 'changed', 60_000);
    await store.delete('b');
    await waitUntil(async () => (await tags.tokens(['a']))[0] === 'changed', 'never synced');
    assert.notEqual(a, 'changed');
    const calls = store.calls.filter((call) => call === 'add').length;
    await waitUntil(async () => {
      await tags.tokens(['b']);
      return store.calls.filter((call) => call === 'add').length > calls;
    }, 'the lost token was never minted again');
  });

  it('marks everything cold when a sync fails, and reports it', async (t) => {
    const store = new MapCacheStore();
    const errors: unknown[] = [];
    const { tags } = table(t, { store, syncMs: 10, onError: (error) => errors.push(error) });
    await tags.tokens(['a']);
    const sequence = tags.sequence;
    store.failWith = new Error('down');
    await waitUntil(() => errors.length > 0, 'the failed sync was never reported');
    assert.ok(tags.sequence > sequence);
    store.failWith = undefined;
  });

  it('never reverts a token whose invalidation is still being written', async (t) => {
    const store = new MapCacheStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: CacheStore = {
      get: (key) => store.get(key),
      getMany: (keys) => store.getMany(keys),
      set: async (key, value, ttlMs) => {
        await held;
        return store.set(key, value, ttlMs);
      },
      add: (key, value, ttlMs) => store.add(key, value, ttlMs),
      delete: (key) => store.delete(key),
      namespace: (name) => store.namespace(name),
      close: () => store.close(),
    };
    const { tags } = table(t, { store: slow, syncMs: 5 });
    const [old] = await tags.tokens(['t']);
    // A second warm tag keeps the sync reading while `t` is skipped.
    await tags.tokens(['other']);
    const writing = tags.invalidate(['t']);
    const [fresh] = await tags.tokens(['t']);
    const getManys = store.calls.filter((call) => call === 'getMany').length;
    await waitUntil(
      () => store.calls.filter((call) => call === 'getMany').length >= getManys + 3,
      'the sync never ran',
    );
    assert.deepEqual(await tags.tokens(['t']), [fresh]);
    assert.notEqual(fresh, old);
    release();
    await writing;
  });

  it('installs what it read although messages for other tags arrived meanwhile', async (t) => {
    const store = new MapCacheStore();
    const bus = new FakeBus();
    let busy = false;
    const chatty: CacheStore = {
      get: (key) => store.get(key),
      getMany: async (keys) => {
        const values = await store.getMany(keys);
        if (busy) bus.send('{"v":1,"o":"x","t":["unrelated"]}');
        return values;
      },
      set: (key, value, ttlMs) => store.set(key, value, ttlMs),
      add: (key, value, ttlMs) => store.add(key, value, ttlMs),
      delete: (key) => store.delete(key),
      namespace: (name) => store.namespace(name),
      close: () => store.close(),
    };
    const { tags } = table(t, { store: chatty, bus, syncMs: 10 });
    await tags.tokens(['a']);
    busy = true;
    await store.set('a', 'changed', 60_000);
    await waitUntil(
      async () => (await tags.tokens(['a']))[0] === 'changed',
      'every sync was discarded for a message about another tag',
    );
  });
});

describe('createCacheTags bounds and lifecycle', () => {
  it('drops the least recently used tag beyond 10 000, leaving the sequence', async (t) => {
    const store = new MapCacheStore();
    const { tags } = table(t, { store, syncMs: 3_600_000 });
    await fill(tags);
    await tags.tokens(['t0']);
    const sequence = tags.sequence;
    await tags.tokens(['extra']);
    await tags.tokens(['extra2']);
    assert.equal(tags.sequence, sequence, 'a dropped tag changed no token');
    const calls = store.calls.length;
    await tags.tokens(['t0']);
    assert.equal(store.calls.length, calls, 't0 was recently used and stayed');
    await tags.tokens(['t1']);
    assert.equal(store.calls.length, calls + 1, 't1 was dropped and is read again');
  });

  it('moves the sequence once at the next sync after dropping tags', async (t) => {
    const syncing = table(t, { syncMs: 20 }).tags;
    await fill(syncing);
    const sequence = syncing.sequence;
    await syncing.tokens(['extra']);
    await syncing.tokens(['extra2']);
    assert.equal(syncing.sequence, sequence);
    await waitUntil(
      () => syncing.sequence === sequence + 1,
      'the sync never accounted for the dropped tags',
    );
    await sleep(100);
    assert.equal(syncing.sequence, sequence + 1, 'once, not on every sync');
  });

  it('rejects closed after close, which is idempotent', async (t) => {
    const { tags } = table(t);
    await tags.close();
    await tags.close();
    await assert.rejects(tags.tokens(['t']), (error: unknown) => CacheErrors.is(error, 'closed'));
    await assert.rejects(tags.invalidate(['t']), (error: unknown) =>
      CacheErrors.is(error, 'closed'),
    );
  });

  it('refuses malformed options', () => {
    const store = new MapCacheStore();
    const option = (run: () => unknown, name: string): void => {
      assert.throws(run, (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'invalid_option'));
        assert.deepEqual(error.context, { option: name });
        return true;
      });
    };
    option(() => createCacheTags(null as unknown as CacheTagsOptions), 'createCacheTags');
    option(() => createCacheTags({ store: {} as CacheStore }), 'store');
    option(() => createCacheTags({ store, bus: {} as CacheTagBus }), 'bus');
    option(() => createCacheTags({ store, syncMs: 0 }), 'syncMs');
    option(() => createCacheTags({ store, onError: 'x' as unknown as () => void }), 'onError');
  });
});
