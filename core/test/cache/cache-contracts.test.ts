/**
 * The cache contracts themselves: the validators every store shares, the
 * service tokens' types (a cache is never mistaken for a lease store), and
 * `withLease`, which holds a lease for the length of a piece of work.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCacheKey,
  assertCacheNamespace,
  assertCacheValue,
  assertLease,
  assertTtlMs,
  CacheErrors,
  cacheToken,
  isLeaseStore,
  leaseToken,
  MAX_CACHE_KEY_LENGTH,
  MAX_CACHE_TTL_MS,
  withLease,
  type CacheService,
  type CacheStore,
  type LeaseStore,
} from '../../src/cache/index.js';
import type { ServiceToken } from '../../src/extensions/services.js';
import { MapCacheStore, MapLeaseStore } from './map-cache-store.js';

type TokenValue<T> = T extends ServiceToken<infer V> ? V : never;

describe('cache contract types', () => {
  it('a cache service, or a cache store, never satisfies the lease contract', () => {
    const cache: TokenValue<typeof cacheToken> = { cache: () => new MapCacheStore() };
    const store: CacheStore = new MapCacheStore();
    // @ts-expect-error a cache service is not a lease store
    const fromService: LeaseStore = cache;
    // @ts-expect-error a cache store is not a lease store
    const fromStore: LeaseStore = store;
    assert.equal(isLeaseStore(fromService), false);
    assert.equal(isLeaseStore(fromStore), false);
    assert.equal(isLeaseStore(new MapLeaseStore()), true);
    assert.equal(isLeaseStore(null), false);
  });

  it('the tokens carry the service each one provides', () => {
    const service: TokenValue<typeof cacheToken> extends CacheService ? true : false = true;
    const leases: TokenValue<typeof leaseToken> extends LeaseStore ? true : false = true;
    assert.deepEqual([service, leases], [true, true]);
    assert.notEqual(cacheToken, leaseToken);
  });
});

describe('cache argument validators', () => {
  const rejects = (run: () => void, code: Parameters<typeof CacheErrors.is>[1]): void => {
    assert.throws(run, (error: unknown) => CacheErrors.is(error, code));
  };

  it('accepts a TTL of whole milliseconds from 1 ms to one year', () => {
    assertTtlMs(1);
    assertTtlMs(MAX_CACHE_TTL_MS);
    for (const ttl of [0, -5, 0.5, 1.25, MAX_CACHE_TTL_MS + 1, Number.NaN, '5', null]) {
      rejects(() => assertTtlMs(ttl), 'invalid_ttl');
    }
  });

  it('accepts a non-empty key up to the length limit', () => {
    assertCacheKey('k');
    assertCacheKey('k'.repeat(MAX_CACHE_KEY_LENGTH));
    for (const key of ['', 'k'.repeat(MAX_CACHE_KEY_LENGTH + 1), 1, undefined]) {
      rejects(() => assertCacheKey(key), 'invalid_key');
    }
  });

  it('accepts strings and bytes only', () => {
    assertCacheValue('');
    assertCacheValue(new Uint8Array(2));
    for (const value of [1, null, new ArrayBuffer(1), [1], {}]) {
      rejects(() => assertCacheValue(value), 'invalid_value');
    }
  });

  it('accepts namespace names of word characters, dots and dashes', () => {
    assertCacheNamespace('pages');
    assertCacheNamespace('a.b-c_9');
    for (const name of ['', 'a:b', 'a b', 'x'.repeat(65), 7]) {
      rejects(() => assertCacheNamespace(name), 'invalid_namespace');
    }
  });

  it('accepts a lease with a key, a token and a positive whole fence', () => {
    assertLease({ key: 'k', token: 't', fence: 1 });
    for (const lease of [
      null,
      'lease',
      { key: '', token: 't', fence: 1 },
      { key: 'k', token: '', fence: 1 },
      { key: 'k', token: 't', fence: 0 },
      { key: 'k', token: 't', fence: 1.5 },
    ]) {
      rejects(() => assertLease(lease), 'invalid_lease');
    }
  });

  it('error messages never carry the rejected value', () => {
    try {
      assertCacheKey('s3cr3t'.repeat(400));
      assert.fail('expected a rejection');
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('s3cr3t'));
    }
  });
});

describe('withLease', () => {
  it('runs the work under a held lease and releases it after', async () => {
    const store = new MapLeaseStore();
    const outcome = await withLease(store, 'job', { ttlMs: 60_000 }, async (lease, signal) => {
      assert.equal(store.isHeld('job'), true);
      assert.equal(lease.key, 'job');
      assert.equal(signal.aborted, false);
      return 'done';
    });
    assert.deepEqual(outcome, { acquired: true, value: 'done' });
    assert.equal(store.isHeld('job'), false);
  });

  it('skips the work while another holder has the key', async () => {
    const store = new MapLeaseStore();
    await store.acquire('job', 60_000);
    let ran = false;
    const outcome = await withLease(store, 'job', { ttlMs: 60_000 }, async () => {
      ran = true;
    });
    assert.deepEqual(outcome, { acquired: false });
    assert.equal(ran, false);
  });

  it('releases the lease when the work throws, and rethrows its error', async () => {
    const store = new MapLeaseStore();
    await assert.rejects(
      withLease(store, 'job', { ttlMs: 60_000 }, async () => {
        throw new Error('work failed');
      }),
      /work failed/,
    );
    assert.equal(store.isHeld('job'), false);
  });

  it('lets the work outcome win over a failing release', async () => {
    const store = new MapLeaseStore();
    store.release = () => Promise.reject(new Error('release failed'));
    const outcome = await withLease(store, 'job', { ttlMs: 60_000 }, async () => 7);
    assert.deepEqual(outcome, { acquired: true, value: 7 });
  });

  it("forwards the caller's abort to the work and keeps the lease", async () => {
    const store = new MapLeaseStore();
    const controller = new AbortController();
    const reason = new Error('stop');
    const outcome = await withLease(
      store,
      'job',
      { ttlMs: 60_000, signal: controller.signal },
      async (_lease, signal) => {
        controller.abort(reason);
        return signal.reason;
      },
    );
    assert.deepEqual(outcome, { acquired: true, value: reason });
    assert.equal(store.isHeld('job'), true, 'an aborted holder leaves the lease to expire');
  });

  it('starts aborted when the caller already aborted', async () => {
    const store = new MapLeaseStore();
    const outcome = await withLease(
      store,
      'job',
      { ttlMs: 60_000, signal: AbortSignal.abort() },
      async (_lease, signal) => signal.aborted,
    );
    assert.deepEqual(outcome, { acquired: true, value: true });
  });

  it('renews every third of the TTL and retries a failed renewal', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let now = 0;
    const store = new MapLeaseStore(() => now);
    const renew = store.renew.bind(store);
    let failNext = true;
    store.renew = async (lease, ttlMs) => {
      if (failNext) {
        failNext = false;
        throw new Error('backend down');
      }
      return renew(lease, ttlMs);
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };
    const outcome = await withLease(store, 'job', { ttlMs: 3000 }, async (_lease, signal) => {
      for (let step = 0; step < 4; step += 1) {
        now += 1000;
        t.mock.timers.tick(1000);
        await settle();
      }
      return { held: store.isHeld('job'), aborted: signal.aborted };
    });
    assert.deepEqual(outcome, { acquired: true, value: { held: true, aborted: false } });
  });

  it('aborts the work with cache.invalid_lease once the lease is lost', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let now = 0;
    const store = new MapLeaseStore(() => now);
    const outcome = await withLease(store, 'job', { ttlMs: 3000 }, async (_lease, signal) => {
      now += 5000;
      await store.acquire('job', 60_000);
      t.mock.timers.tick(1000);
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      return CacheErrors.is(signal.reason, 'invalid_lease');
    });
    assert.deepEqual(outcome, { acquired: true, value: true });
    assert.equal(store.isHeld('job'), true, "the next holder's lease survives");
  });

  it('aborts the work once renewals have failed for a whole TTL', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    let now = 0;
    const store = new MapLeaseStore(() => now);
    store.renew = () => Promise.reject(new Error('partitioned'));
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };
    const outcome = await withLease(store, 'job', { ttlMs: 3000 }, async (_lease, signal) => {
      const seen: boolean[] = [];
      for (let step = 0; step < 4; step += 1) {
        now += 1000;
        t.mock.timers.tick(1000);
        await settle();
        seen.push(signal.aborted);
      }
      return { seen, lost: CacheErrors.is(signal.reason, 'invalid_lease') };
    });
    assert.deepEqual(outcome, {
      acquired: true,
      value: { seen: [false, false, true, true], lost: true },
    });
  });

  it('aborts the work when a renewal is still unanswered at the deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const store = new MapLeaseStore();
    store.renew = () => new Promise<boolean>(() => undefined);
    const outcome = await withLease(store, 'job', { ttlMs: 3000 }, async (_lease, signal) => {
      t.mock.timers.tick(2999);
      const before = signal.aborted;
      t.mock.timers.tick(1);
      return { before, after: signal.aborted };
    });
    assert.deepEqual(outcome, { acquired: true, value: { before: false, after: true } });
  });

  it('validates its arguments before acquiring', async () => {
    const store = new MapLeaseStore();
    const work = async (): Promise<void> => undefined;
    await assert.rejects(withLease(store, '', { ttlMs: 1000 }, work), (error: unknown) =>
      CacheErrors.is(error, 'invalid_key'),
    );
    await assert.rejects(withLease(store, 'job', { ttlMs: 0.5 }, work), (error: unknown) =>
      CacheErrors.is(error, 'invalid_ttl'),
    );
    await assert.rejects(
      withLease(store, 'job', null as unknown as { ttlMs: number }, work),
      (error: unknown) => CacheErrors.is(error, 'invalid_option'),
    );
    assert.deepEqual(store.calls, []);
  });
});
