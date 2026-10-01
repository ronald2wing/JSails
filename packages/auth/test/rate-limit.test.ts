/**
 * Tests for the credential throttle: email normalization, the in-memory
 * fixed-window limiter's keying and window, and the fail-closed hook
 * evaluation. The client address the limiter keys on is resolved by core
 * (`core/test/security/request-origin.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMemoryRateLimiter,
  normalizeEmail,
  rateLimitAllows,
  type RateLimitAttempt,
} from '../src/rate-limit.js';

function attempt(email: string | null, ip: string | null = '10.0.0.1'): RateLimitAttempt {
  return { email, ip, route: 'login', request: new Request('http://localhost/') };
}

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
  });
});

describe('createMemoryRateLimiter', () => {
  it('allows the limit within a window, then denies until the window passes', () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert.equal(limiter('a@b.co', attempt('a@b.co')), true);
    assert.equal(limiter('A@B.co', attempt('A@B.co')), true);
    assert.equal(limiter('a@b.co', attempt('a@b.co')), false);
    now = 1000;
    assert.equal(limiter('a@b.co', attempt('a@b.co')), true);
  });

  it('keeps separate buckets per client address and per route', () => {
    const limiter = createMemoryRateLimiter({ limit: 1 });
    assert.equal(limiter('a@b.co', attempt('a@b.co', '10.0.0.1')), true);
    assert.equal(limiter('a@b.co', attempt('a@b.co', '10.0.0.1')), false);
    // Someone elsewhere cannot lock the account owner out.
    assert.equal(limiter('a@b.co', attempt('a@b.co', '10.0.0.2')), true);
    assert.equal(limiter('a@b.co', { ...attempt('a@b.co', '10.0.0.1'), route: 'register' }), true);
  });

  it('denies one address spraying a password across many emails', () => {
    const limiter = createMemoryRateLimiter({ limit: 10, perAddressLimit: 5 });
    const results = Array.from({ length: 7 }, (_, i) =>
      limiter(`user${i}@b.co`, attempt(`user${i}@b.co`, '10.0.0.9')),
    );
    assert.deepEqual(results, [true, true, true, true, true, false, false]);
    // Another client and an address-less transport are unaffected.
    assert.equal(limiter('user0@b.co', attempt('user0@b.co', '10.0.0.10')), true);
    assert.equal(limiter('user9@b.co', attempt('user9@b.co', null)), true);
  });

  it('caps one address at a hundred attempts per window by default', () => {
    const limiter = createMemoryRateLimiter();
    for (let i = 0; i < 100; i += 1) {
      assert.equal(limiter(`u${i}@b.co`, attempt(`u${i}@b.co`)), true);
    }
    assert.equal(limiter('fresh@b.co', attempt('fresh@b.co')), false);
  });

  it('keeps a spraying address bucket from being evicted by its own fresh emails', () => {
    const limiter = createMemoryRateLimiter({ perAddressLimit: 3, maxKeys: 4 });
    const results = Array.from({ length: 10 }, (_, i) =>
      limiter(`s${i}@b.co`, attempt(`s${i}@b.co`)),
    );
    assert.deepEqual(
      results.slice(3),
      Array.from({ length: 7 }, () => false),
    );
  });

  it('bounds the number of tracked keys', () => {
    const limiter = createMemoryRateLimiter({ limit: 1, maxKeys: 2 });
    assert.equal(limiter('a@b.co', attempt('a@b.co')), true);
    assert.equal(limiter('b@b.co', attempt('b@b.co')), true);
    assert.equal(limiter('c@b.co', attempt('c@b.co')), true);
    // The oldest window was evicted to make room, so it starts afresh.
    assert.equal(limiter('a@b.co', attempt('a@b.co')), true);
  });

  it('does not count a denied attempt', () => {
    const limiter = createMemoryRateLimiter({ limit: 1, perAddressLimit: 2 });
    assert.equal(limiter('a@b.co', attempt('a@b.co')), true);
    // Denied on the per-email bucket: the per-address bucket must not be charged.
    assert.equal(limiter('a@b.co', attempt('a@b.co')), false);
    assert.equal(limiter('b@b.co', attempt('b@b.co')), true);
  });

  it('keeps denied attempts from evicting another client out of its window', () => {
    const limiter = createMemoryRateLimiter({ limit: 1, perAddressLimit: 1, maxKeys: 4 });
    assert.equal(limiter('victim@b.co', attempt('victim@b.co', '10.0.0.9')), true);
    assert.equal(limiter('u0@b.co', attempt('u0@b.co', '10.0.0.1')), true);
    // An exhausted address floods fresh emails; denied, they open no windows.
    for (let i = 1; i < 20; i += 1) {
      assert.equal(limiter(`u${i}@b.co`, attempt(`u${i}@b.co`, '10.0.0.1')), false);
    }
    assert.equal(limiter('victim@b.co', attempt('victim@b.co', '10.0.0.9')), false);
  });

  it('counts an attempt that names no email against the client address', () => {
    const limiter = createMemoryRateLimiter({ limit: 10, perAddressLimit: 2 });
    assert.equal(limiter(null, attempt(null, '10.0.0.1')), true);
    assert.equal(limiter(null, attempt(null, '10.0.0.1')), true);
    assert.equal(limiter(null, attempt(null, '10.0.0.1')), false);
    // The address bucket is shared with attempts that do name an email.
    assert.equal(limiter('a@b.co', attempt('a@b.co', '10.0.0.1')), false);
    assert.equal(limiter(null, attempt(null, '10.0.0.2')), true);
    // Without an address either, such attempts share one bucket per route.
    assert.equal(limiter(null, attempt(null, null)), true);
    assert.equal(limiter(null, attempt(null, null)), true);
    assert.equal(limiter(null, attempt(null, null)), false);
  });

  it('rejects invalid options', () => {
    assert.throws(() => createMemoryRateLimiter({ limit: 0 }), TypeError);
    assert.throws(() => createMemoryRateLimiter({ windowMs: 1.5 }), TypeError);
    assert.throws(() => createMemoryRateLimiter({ perAddressLimit: 0 }), TypeError);
  });
});

describe('rateLimitAllows', () => {
  it('hands the hook the normalized email and fails closed', async () => {
    const seen: (string | null)[] = [];
    const base = { ip: null, route: 'login' as const, request: new Request('http://x/') };
    assert.equal(
      await rateLimitAllows(
        (email, details) => {
          seen.push(email, details.email);
          return true;
        },
        ' Ada@X.io',
        base,
      ),
      true,
    );
    assert.deepEqual(seen, ['ada@x.io', 'ada@x.io']);
    assert.equal(await rateLimitAllows(() => 'yes' as never, 'a@b.co', base), false);
    const seenWithout: (string | null)[] = [];
    await rateLimitAllows(
      (email, details) => {
        seenWithout.push(email, details.email);
        return true;
      },
      null,
      base,
    );
    assert.deepEqual(seenWithout, [null, null]);
    assert.equal(
      await rateLimitAllows(
        () => {
          throw new Error('down');
        },
        'a@b.co',
        base,
      ),
      false,
    );
  });
});
