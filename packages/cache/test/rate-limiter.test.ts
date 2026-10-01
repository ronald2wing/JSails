/**
 * Fixed-window rate limiter tests: window boundaries, per-key and per-shape
 * isolation, atomic counting in process and over Valkey (its own prefix,
 * apart from every cache), the bounded in-process counters, the value-free
 * 429 helper, and the Hono-agnostic guard.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CacheErrors } from 'jsails/cache';
import { createFakeClock } from 'jsails/testing';

import { FixedWindowRateLimiter, guardRateLimit, rateLimitResponse } from '../src/index.js';
import { MemoryWindowCounter } from '../src/window-counter.js';
import { FakeValkeyServer, fakeValkey } from './fake-valkey-client.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to the limit, blocks beyond it, and resets on the next window', async () => {
    const { now, advance } = createFakeClock();
    const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 1000, now });

    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 1, resetAt: 1000 });
    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 0, resetAt: 1000 });
    assert.deepEqual(await limiter.check('ip:1'), { allowed: false, remaining: 0, resetAt: 1000 });

    advance(1000);
    assert.deepEqual(await limiter.check('ip:1'), { allowed: true, remaining: 1, resetAt: 2000 });
  });

  it('keeps independent keys in independent windows', async () => {
    const { now } = createFakeClock();
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now });

    assert.deepEqual(await limiter.check('a'), { allowed: true, remaining: 0, resetAt: 1000 });
    assert.deepEqual(await limiter.check('b'), { allowed: true, remaining: 0, resetAt: 1000 });
  });

  it('rejects invalid options and keys with value-free errors', async () => {
    const invalid = (run: () => unknown, option: string): void => {
      assert.throws(run, (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'invalid_option'));
        assert.deepEqual(error.context, { option });
        return true;
      });
    };
    invalid(() => new FixedWindowRateLimiter(null as never), 'FixedWindowRateLimiter');
    invalid(() => new FixedWindowRateLimiter({ limit: 0, windowMs: 1000 }), 'limit');
    invalid(() => new FixedWindowRateLimiter({ limit: 1.5, windowMs: 1000 }), 'limit');
    invalid(() => new FixedWindowRateLimiter({ limit: 1, windowMs: 0 }), 'windowMs');
    invalid(() => new FixedWindowRateLimiter({ limit: 1, windowMs: 10, now: 1 as never }), 'now');
    invalid(
      () => new FixedWindowRateLimiter({ limit: 1, windowMs: 10, connections: {} as never }),
      'connections',
    );
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000 });
    await assert.rejects(limiter.check(''), (error: unknown) =>
      CacheErrors.is(error, 'invalid_key'),
    );
  });

  it('allows exactly one of 100 concurrent checks when the limit is 1', async () => {
    const { now } = createFakeClock();
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now });

    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('ip:race')));
    assert.equal(results.filter((result) => result.allowed).length, 1);
  });

  it('counts across processes over Valkey, under its own prefix', async () => {
    const { connections, server } = fakeValkey({ server: new FakeValkeyServer(() => 0) });
    const first = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      connections,
      now: () => 0,
    });
    const second = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 60_000,
      connections,
      now: () => 0,
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, (_unused, index) =>
        (index % 2 ? first : second).check('ip:race'),
      ),
    );
    assert.equal(results.filter((result) => result.allowed).length, 1);
    assert.deepEqual(server.liveKeys(), ['app:test:ratelimit:ip:race:1:60000:0']);
    assert.equal(server.ttlOf('app:test:ratelimit:ip:race:1:60000:0'), 60_000);
    await connections.close();
  });

  it('turns a Valkey failure into a value-free cache.unavailable', async () => {
    const { connections, server } = fakeValkey();
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, connections });
    server.failWith = new Error('NOAUTH s3cr3t');
    await assert.rejects(limiter.check('k'), (error: unknown) => {
      assert.ok(CacheErrors.is(error, 'unavailable'));
      assert.deepEqual(error.context, { store: 'rate_limit' });
      assert.ok(!error.message.includes('s3cr3t'));
      return true;
    });
    server.failWith = undefined;
    server.put('app:test:ratelimit:k:1:1000:0', Buffer.from('not a count'), 1000);
    const at0 = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, connections, now: () => 0 });
    await assert.rejects(at0.check('k'), (error: unknown) => CacheErrors.is(error, 'unavailable'));
    await connections.close();
  });
});

describe('MemoryWindowCounter', () => {
  it('stays within its cap, evicting expired counters first, then singletons', async () => {
    const { now, advance } = createFakeClock();
    const counter = new MemoryWindowCounter(now, 4);
    await counter.increment('expiring', 10);
    await counter.increment('busy', 60_000);
    await counter.increment('busy', 60_000);
    await counter.increment('once-a', 60_000);
    advance(20);
    await counter.increment('once-b', 60_000);
    await counter.increment('once-c', 60_000);
    assert.equal(counter.size, 4);
    assert.equal(await counter.increment('busy', 60_000), 3, 'expired went first');

    await counter.increment('once-d', 60_000);
    assert.equal(counter.size, 4);
    assert.equal(await counter.increment('busy', 60_000), 4, 'a singleton went next');
  });

  it('evicts the oldest counter once no singleton is left, never the one written', async () => {
    const { now } = createFakeClock();
    const counter = new MemoryWindowCounter(now, 2);
    for (const key of ['a', 'a', 'b', 'b']) await counter.increment(key, 60_000);
    assert.equal(await counter.increment('c', 60_000), 1);
    assert.equal(counter.size, 2);
    assert.equal(await counter.increment('b', 60_000), 3);
    assert.equal(await counter.increment('a', 60_000), 1, 'the oldest counter was evicted');
  });

  it('restarts a counter whose window expired', async () => {
    const { now, advance } = createFakeClock();
    const counter = new MemoryWindowCounter(now);
    assert.equal(await counter.increment('k', 100), 1);
    assert.equal(await counter.increment('k', 100), 2);
    advance(100);
    assert.equal(await counter.increment('k', 100), 1);
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
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1000, now });
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
