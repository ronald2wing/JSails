/**
 * `defineCache` over the package's stores: the conformance cases on the
 * in-memory cache and lease stores and on the Valkey stores over the fake
 * Valkey, and one cache defined through the `cache` plugin end to end.
 */

import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import { cacheTagsToken, defineCache } from 'jsails/cache';
import { runExtensions } from 'jsails/extensions';
import { defineCacheConformance } from 'jsails/testing';

import {
  cachePlugin,
  MemoryCacheStore,
  MemoryLeaseStore,
  ValkeyCacheStore,
  ValkeyLeaseStore,
} from '../src/index.js';
import { fakeValkey } from './fake-valkey-client.js';

const rootDir = import.meta.dirname;

// The plugin falls back to `VALKEY_URL`; these cases choose the backend.
delete process.env['VALKEY_URL'];

for (const entry of defineCacheConformance(async () => {
  const store = new MemoryCacheStore();
  const leases = new MemoryLeaseStore();
  return {
    store,
    leases,
    close: async () => {
      await leases.close();
      await store.close();
    },
  };
})) {
  test(`MemoryCacheStore: ${entry.name}`, () => entry.run());
}

for (const entry of defineCacheConformance(async () => {
  const { connections } = fakeValkey();
  const store = new ValkeyCacheStore({ connections });
  const leases = new ValkeyLeaseStore({ connections });
  return {
    store,
    leases,
    close: async () => {
      await leases.close();
      await store.close();
      await connections.close();
    },
  };
})) {
  test(`ValkeyCacheStore (fake): ${entry.name}`, () => entry.run());
}

describe('defineCache through cachePlugin', () => {
  it('validates against the tag table the plugin provides', async () => {
    const runtime = await runExtensions([cachePlugin()], { rootDir });
    try {
      const cache = defineCache<number>(runtime.services, {
        name: 'plugin',
        ttlMs: 60_000,
        tier: 'shared',
        tags: () => ['t'],
      });
      assert.equal(await cache.get('k', async () => 1), 1);
      assert.equal(await cache.get('k', async () => 2), 1);
      await runtime.services.get(cacheTagsToken).invalidate(['t']);
      assert.equal(await cache.get('k', async () => 3), 3);
    } finally {
      await runtime.close();
    }
  });
});
