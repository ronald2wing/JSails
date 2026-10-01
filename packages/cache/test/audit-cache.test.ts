/**
 * Audit regressions for the cache package (CNT-01): each test states the
 * correct behaviour for one audited defect. Those that fail today are listed,
 * with the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { auditCase, blackholeServer, deferred, settlesWithin } from 'jsails/testing';

import { MemoryCacheStore, ValkeyCacheStore } from '../src/cache-store.js';
import { ValkeyMutexStore } from '../src/mutex-store.js';
import { FixedWindowRateLimiter } from '../src/rate-limiter.js';
import { FakeValkeyClient } from './fake-valkey-client.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

test(
  ...auditCase(
    'cache/claim-evicted-by-counters',
    'a long-lived claim survives a burst of unrelated short-lived counters',
  ),
  async () => {
    const store = new MemoryCacheStore({ maxEntries: 100 });
    assert.equal(await store.increment('webhook:stripe:sig-1', WEEK_MS), 1);
    for (let index = 0; index < 200; index += 1) {
      await store.increment(`throttle:login:203.0.113.${index}`, 60_000);
    }
    assert.equal(
      await store.increment('webhook:stripe:sig-1', WEEK_MS),
      2,
      'the replay claim was evicted, so the captured delivery would be accepted again',
    );
  },
);

test(
  ...auditCase('cache/memory-lru', 'the memory store evicts the least recently used entry'),
  async () => {
    const store = new MemoryCacheStore({ maxEntries: 2 });
    await store.set('hot', 'a', 60_000);
    await store.set('cold', 'b', 60_000);
    assert.equal(await store.get('hot'), 'a');
    await store.set('new', 'c', 60_000);
    assert.equal(await store.get('hot'), 'a', 'the entry read last was evicted first');
    assert.equal(await store.get('cold'), null);
  },
);

test(
  ...auditCase(
    'cache/remember-single-flight',
    'remember runs the loader once for callers that overlap its round trips',
  ),
  async () => {
    // The interleaving is scripted rather than timed: the second caller's GET
    // is answered while the first caller is still loading (a miss), and its
    // reply is held until the first caller has stored the value and returned.
    const values = new Map<string, string>();
    let gets = 0;
    const secondGetIssued = deferred();
    const firstSettled = deferred();
    class ScriptedClient extends FakeValkeyClient {
      constructor(_url: string, _options: object) {
        super();
      }

      override async get(key: string): Promise<string | null> {
        const value = values.get(key) ?? null;
        gets += 1;
        if (gets === 2) {
          secondGetIssued.resolve();
          await firstSettled.promise;
        }
        return value;
      }

      override async set(key: string, value: string): Promise<'OK'> {
        values.set(key, value);
        return 'OK';
      }
    }
    const store = new ValkeyCacheStore(
      { valkeyUrl: 'redis://127.0.0.1:6379' },
      { RedisClient: ScriptedClient },
    );
    const loaderEntered = deferred();
    const releaseLoader = deferred();
    let loads = 0;
    const loader = async (): Promise<string> => {
      loads += 1;
      loaderEntered.resolve();
      await releaseLoader.promise;
      return 'value';
    };
    try {
      const first = store.remember('report', 60_000, loader);
      await loaderEntered.promise;
      const second = store.remember('report', 60_000, loader);
      // Today the second GET is issued within the current turn (only
      // microtasks precede it). A store that joins the in-flight load before
      // reading never issues it, so one macrotask turn bounds the wait.
      await Promise.race([secondGetIssued.promise, nextTurn()]);
      releaseLoader.resolve();
      const firstValue = await first;
      firstSettled.resolve();
      assert.deepEqual([firstValue, await second], ['value', 'value']);
      assert.equal(loads, 1, `the loader ran ${loads} times for one key`);
    } finally {
      firstSettled.resolve();
      releaseLoader.resolve();
      await store.close();
    }
  },
);

test(
  ...auditCase(
    'cache/rate-limit-namespace',
    'two limiters with different windows never share a counter for one key',
  ),
  async () => {
    const store = new MemoryCacheStore();
    const now = () => 0;
    const perSecond = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });
    const perMinute = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 60_000, now });
    assert.equal((await perSecond.check('login:ada')).allowed, true);
    assert.equal(
      (await perMinute.check('login:ada')).allowed,
      true,
      "the per-minute limiter counted the per-second limiter's hit",
    );
  },
);

test(
  ...auditCase(
    'cache/mutex-integer-ttl',
    'the Valkey mutex refuses or rounds a fractional TTL instead of sending it to SET PX',
  ),
  async () => {
    const sent: unknown[] = [];
    class RecordingClient extends FakeValkeyClient {
      constructor(_url: string, _options: object) {
        super();
      }

      override async set(
        key: string,
        value: string,
        mode: 'PX',
        ttlMs: number,
        condition?: 'NX',
      ): Promise<'OK' | null> {
        sent.push(ttlMs);
        return super.set(key, value, mode, ttlMs, condition);
      }
    }
    const store = new ValkeyMutexStore(
      { valkeyUrl: 'redis://127.0.0.1:6379' },
      { RedisClient: RecordingClient },
    );
    try {
      let refused = false;
      try {
        await store.acquire('job:nightly', 1500.5);
      } catch {
        refused = true;
      }
      assert.ok(
        refused || sent.every((ttl) => Number.isInteger(ttl)),
        `SET PX received ${String(sent[0])}, which Valkey rejects`,
      );
    } finally {
      await store.close();
    }
  },
);

test(
  ...auditCase(
    'cache/valkey-command-timeout',
    'a cache read against an unresponsive Valkey fails within a bounded time',
  ),
  async (t) => {
    const blackhole = await blackholeServer();
    t.after(() => blackhole.close());
    const store = new ValkeyCacheStore({ valkeyUrl: blackhole.url('redis') });
    t.after(async () => {
      try {
        await settlesWithin(store.close(), 2000, 'closing the store');
      } catch {
        // A store that cannot close against a silent peer is the defect under
        // test; the blackhole's own close ends the socket either way.
      }
    });
    const outcome = await settlesWithin(
      store.get('page:/').then(
        () => 'resolved',
        () => 'rejected',
      ),
      5000,
      'a cache read against a silent Valkey',
    );
    assert.equal(outcome, 'rejected', 'a read against a silent Valkey resolved');
  },
);
