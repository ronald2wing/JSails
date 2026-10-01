/**
 * Audit regressions for the cache package (CNT-01): each test states the
 * correct behaviour for one audited defect. Any that fails is listed, with the
 * failure it shows, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CacheErrors } from 'jsails/cache';
import { createValkeyConnections, DEFAULT_VALKEY_TIMEOUTS } from 'jsails/plugin-sdk';
import { auditCase, blackholeServer, settlesWithin } from 'jsails/testing';

import {
  FixedWindowRateLimiter,
  MemoryCacheStore,
  ValkeyCacheStore,
  ValkeyLeaseStore,
} from '../src/index.js';
import { fakeValkey } from './fake-valkey-client.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

test(
  ...auditCase(
    'cache/claim-evicted-by-counters',
    'a long-lived claim survives a burst of unrelated short-lived counters',
  ),
  async () => {
    const store = new MemoryCacheStore({ maxEntries: 100 });
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60_000 });
    assert.equal(await store.add('webhook:stripe:sig-1', '1', WEEK_MS), true);
    for (let index = 0; index < 200; index += 1) {
      await limiter.check(`throttle:login:203.0.113.${String(index)}`);
    }
    assert.equal(
      await store.add('webhook:stripe:sig-1', '1', WEEK_MS),
      false,
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
    'cache/rate-limit-namespace',
    'two limiters with different windows never share a counter for one key',
  ),
  async () => {
    const { connections } = fakeValkey();
    const now = () => 0;
    try {
      for (const shared of [{}, { connections }]) {
        const perSecond = new FixedWindowRateLimiter({ ...shared, limit: 1, windowMs: 1000, now });
        const perMinute = new FixedWindowRateLimiter({
          ...shared,
          limit: 1,
          windowMs: 60_000,
          now,
        });
        assert.equal((await perSecond.check('login:ada')).allowed, true);
        assert.equal(
          (await perMinute.check('login:ada')).allowed,
          true,
          "the per-minute limiter counted the per-second limiter's hit",
        );
      }
    } finally {
      await connections.close();
    }
  },
);

test(
  ...auditCase(
    'cache/mutex-integer-ttl',
    'the Valkey lease store refuses a fractional TTL instead of sending it to SET PX',
  ),
  async () => {
    const { connections, server } = fakeValkey();
    const store = new ValkeyLeaseStore({ connections });
    try {
      await assert.rejects(store.acquire('job:nightly', 1500.5), (error: unknown) =>
        CacheErrors.is(error, 'invalid_ttl'),
      );
      assert.deepEqual(server.commands, [], 'nothing reached the server');
    } finally {
      await connections.close();
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
    const connections = createValkeyConnections(blackhole.url('redis'), {
      appPrefix: 'app:test',
      name: 'audit',
    });
    t.after(() => connections.close());
    const store = new ValkeyCacheStore({ connections });
    t.after(() => store.close());
    // The provider's default connect deadline bounds the read; the margin
    // covers timers under a loaded test run.
    const outcome = await settlesWithin(
      store.get('page:/').then(
        () => 'resolved',
        () => 'rejected',
      ),
      DEFAULT_VALKEY_TIMEOUTS.connectMs + 2000,
      'a cache read against a silent Valkey',
    );
    assert.equal(outcome, 'rejected', 'a read against a silent Valkey resolved');
  },
);
