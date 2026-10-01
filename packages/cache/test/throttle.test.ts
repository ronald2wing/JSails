/**
 * `throttle` tests: the allow decision, the blocked decision's value-free 429
 * with a `Retry-After` derived from the window reset, the shared default
 * store, and option validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFakeClock } from 'jsails/testing';
import { MemoryCacheStore, throttle } from '../src/index.js';

describe('throttle', () => {
  it('allows up to the limit and then returns a 429 with Retry-After', async () => {
    const { now, advance } = createFakeClock(500);
    const store = new MemoryCacheStore({ now });
    const options = { key: 'login:s1', limit: 2, windowMs: 1000, store, now };

    const first = await throttle(options);
    assert.deepEqual(first, { allowed: true, remaining: 1, resetAt: 1000, response: null });
    const second = await throttle(options);
    assert.equal(second.remaining, 0);

    const blocked = await throttle(options);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.response);
    assert.equal(blocked.response.status, 429);
    assert.equal(blocked.response.headers.get('retry-after'), '1');
    assert.equal(blocked.response.headers.get('cache-control'), 'no-store');

    advance(500);
    assert.equal((await throttle(options)).allowed, true, 'the next window starts fresh');
  });

  it('shares one in-memory store across calls that omit store', async () => {
    const key = `shared:${Date.now()}`;
    assert.equal((await throttle({ key, limit: 1, windowMs: 60_000 })).allowed, true);
    assert.equal((await throttle({ key, limit: 1, windowMs: 60_000 })).allowed, false);
  });

  it('rejects invalid options at call time', async () => {
    await assert.rejects(throttle(null as never), TypeError);
    await assert.rejects(throttle({ key: '', limit: 1, windowMs: 1000 }), TypeError);
    await assert.rejects(throttle({ key: 'k', limit: 0, windowMs: 1000 }), TypeError);
    await assert.rejects(throttle({ key: 'k', limit: 1, windowMs: 1.5 }), TypeError);
    await assert.rejects(
      throttle({ key: 'k', limit: 1, windowMs: 1000, now: 1 as never }),
      TypeError,
    );
  });
});
