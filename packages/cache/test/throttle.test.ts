/**
 * `throttle` tests: the allow decision, the blocked decision's value-free 429
 * with a `Retry-After` derived from the window reset, the shared in-process
 * counters, counting over Valkey, and option validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CacheErrors } from 'jsails/cache';
import { createFakeClock } from 'jsails/testing';

import { throttle } from '../src/index.js';
import { fakeValkey } from './fake-valkey-client.js';

describe('throttle', () => {
  it('allows up to the limit and then returns a 429 with Retry-After', async () => {
    const { now, advance } = createFakeClock(500);
    const options = { key: 'login:s1', limit: 2, windowMs: 1000, now };

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

  it('shares in-process counters across calls with the same shape', async () => {
    const key = `shared:${String(Date.now())}`;
    assert.equal((await throttle({ key, limit: 1, windowMs: 60_000 })).allowed, true);
    assert.equal((await throttle({ key, limit: 1, windowMs: 60_000 })).allowed, false);
    assert.equal(
      (await throttle({ key, limit: 1, windowMs: 30_000 })).allowed,
      true,
      'another window length counts apart',
    );
  });

  it('admits exactly the limit of a concurrent burst', async () => {
    const options = { key: `burst:${String(Date.now())}`, limit: 2, windowMs: 60_000 };
    const decisions = await Promise.all(Array.from({ length: 6 }, () => throttle(options)));
    assert.equal(decisions.filter((decision) => decision.allowed).length, 2);
  });

  it('counts over the app Valkey connections when given them', async () => {
    const { connections, server } = fakeValkey();
    const options = { key: 'api:1', limit: 1, windowMs: 60_000, connections, now: () => 0 };
    assert.equal((await throttle(options)).allowed, true);
    assert.equal((await throttle(options)).allowed, false);
    assert.deepEqual(server.liveKeys(), ['app:test:ratelimit:api:1:1:60000:0']);
    await connections.close();
  });

  it('rejects invalid options at call time', async () => {
    const invalid = async (run: () => Promise<unknown>, code: 'invalid_option' | 'invalid_key') => {
      await assert.rejects(run, (error: unknown) => CacheErrors.is(error, code));
    };
    await invalid(() => throttle(null as never), 'invalid_option');
    await invalid(() => throttle({ key: '', limit: 1, windowMs: 1000 }), 'invalid_key');
    await invalid(() => throttle({ key: 'k', limit: 0, windowMs: 1000 }), 'invalid_option');
    await invalid(() => throttle({ key: 'k', limit: 1, windowMs: 1.5 }), 'invalid_option');
    await invalid(
      () => throttle({ key: 'k', limit: 1, windowMs: 1000, now: 1 as never }),
      'invalid_option',
    );
  });
});
