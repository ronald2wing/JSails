/**
 * Fixed-window rate limiter tests: window boundaries, per-key isolation,
 * atomic counting on both built-in stores, the serialized fallback for a store
 * without `increment`, the value-free 429 helper, and the Hono-agnostic guard.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CacheStore } from 'jsails/cache';
import { createFakeClock } from 'jsails/testing';
import {
  FixedWindowRateLimiter,
  MemoryCacheStore,
  ValkeyCacheStore,
  guardRateLimit,
  rateLimitResponse,
} from '../src/index.js';
import { fakeClientDependencies } from './fake-valkey-client.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit, blocks beyond it, and resets on the next window', async () => {
    const { now, advance } = createFakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 2, windowMs: 1000, now });

    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 1, resetAt: 1000 });
    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 0, resetAt: 1000 });
    assert.deepEqual(await limiter.check('ip:1'), { allowed: false, remaining: 0, resetAt: 1000 });

    advance(1000);
    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 1, resetAt: 2000 });
  });

  it('keeps independent keys in independent windows', async () => {
    const { now } = createFakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    assert.deepEqual(await limiter.check('a'), { allowed: true, remaining: 0, resetAt: 1000 });
    assert.deepEqual(await limiter.check('b'), { allowed: true, remaining: 0, resetAt: 1000 });
  });

  it('rejects invalid options', () => {
    const store = new MemoryCacheStore();
    assert.throws(() => new FixedWindowRateLimiter({ store, limit: 0, windowMs: 1000 }), TypeError);
    assert.throws(() => new FixedWindowRateLimiter({ store, limit: 1, windowMs: 0 }), TypeError);
    assert.throws(
      () => new FixedWindowRateLimiter({ store, limit: 1.5, windowMs: 1000 }),
      TypeError,
    );
    assert.throws(
      () => new FixedWindowRateLimiter({ store: {} as CacheStore, limit: 1, windowMs: 1000 }),
      TypeError,
    );
  });

  it('allows exactly one of 100 concurrent checks when the limit is 1', async () => {
    // A read-then-write would let every concurrent caller observe the
    // pre-increment count; the memory store's atomic `increment` admits one.
    const { now } = createFakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('ip:race')));
    const allowed = results.filter((result) => result.allowed).length;
    assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);
  });

  it('allows exactly one of 100 concurrent checks on the Valkey store', async () => {
    // The fake client's `eval` is synchronous, so the script's INCR semantics
    // are what make this atomic — the same guarantee the real Lua script gives.
    const { dependencies } = fakeClientDependencies();
    const store = new ValkeyCacheStore({ valkeyUrl: 'redis://h' }, dependencies);
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000 });

    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('ip:race')));
    const allowed = results.filter((result) => result.allowed).length;
    assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);

    await store.close();
  });

  it('serializes same-key checks when the store has no increment', async () => {
    // A custom store without `increment` falls back to read-then-write; the
    // limiter must serialize those calls so a single process stays correct.
    const { now } = createFakeClock();
    const inner = new MemoryCacheStore({ now });
    const store: CacheStore = {
      get: (key) => inner.get(key),
      set: (key, value, ttlMs) => inner.set(key, value, ttlMs),
      delete: (key) => inner.delete(key),
      remember: (key, ttlMs, loader) => inner.remember(key, ttlMs, loader),
      close: () => inner.close(),
    };
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => limiter.check('ip:fallback')),
    );
    const allowed = results.filter((result) => result.allowed).length;
    assert.equal(allowed, 1, `expected exactly 1 allowed, got ${allowed}`);
  });

  it('does not poison the serialization chain when a check rejects', async () => {
    const { now } = createFakeClock();
    let failNext = true;
    const store: CacheStore = {
      get: () => (failNext ? Promise.reject(new Error('backend down')) : Promise.resolve(null)),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      remember: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
    };
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });

    await assert.rejects(limiter.check('k'));
    failNext = false;
    const result = await limiter.check('k');
    assert.equal(result.allowed, true);
  });
});

describe('rateLimitResponse', () => {
  it('returns a value-free 429', () => {
    const response = rateLimitResponse();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('sets Retry-After when a finite value is supplied', () => {
    assert.equal(rateLimitResponse(29.5).headers.get('retry-after'), '30');
    assert.equal(rateLimitResponse(Number.NaN).headers.get('retry-after'), null);
  });
});

describe('guardRateLimit', () => {
  it('allows under the limit and blocks over it', async () => {
    const { now } = createFakeClock();
    const store = new MemoryCacheStore({ now });
    const limiter = new FixedWindowRateLimiter({ store, limit: 1, windowMs: 1000, now });
    const calls: string[] = [];
    const handler = guardRateLimit(
      limiter,
      (context: { key: string }) => context.key,
      (context) => {
        calls.push(context.key);
        return new Response('ok');
      },
    );

    assert.equal((await handler({ key: 'a' })).status, 200);
    assert.equal((await handler({ key: 'a' })).status, 429);
    assert.deepEqual(calls, ['a']);
  });
});
