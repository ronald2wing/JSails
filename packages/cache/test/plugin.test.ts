/**
 * `cache` plugin tests: ownership and cleanup of the cache store, the opt-in
 * mutex store, caller-supplied store passthrough, and options validation. The
 * stores themselves are exercised by their own test files; this covers the
 * plugin wiring.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cacheToken, mutexToken, type CacheStore, type MutexStore } from 'jsails/cache';
import { runExtensions } from 'jsails/extensions';
import { cachePlugin } from '../src/index.js';

describe('cachePlugin', () => {
  it('provides the owned store under cacheToken without connecting at setup', async () => {
    const plugin = cachePlugin({ valkeyUrl: 'redis://127.0.0.1:1' });
    assert.equal(plugin.name, 'cache');

    const runtime = await runExtensions([plugin]);
    try {
      const store: CacheStore = runtime.services.get(cacheToken);
      assert.equal(typeof store.get, 'function');
      assert.equal(typeof store.close, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('defaults to the in-memory store when no URL is configured', async () => {
    const runtime = await runExtensions([cachePlugin({})]);
    try {
      const store: CacheStore = runtime.services.get(cacheToken);
      await store.set('k', 'v', 1000);
      assert.equal(await store.get('k'), 'v');
    } finally {
      await runtime.close();
    }
  });

  it('preserves a caller-provided store and never closes it', async () => {
    let closed = false;
    const provided: CacheStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      remember: async (_key, _ttl, loader) => loader(),
      close: async () => {
        closed = true;
      },
    };

    const runtime = await runExtensions([cachePlugin({ store: provided })]);
    try {
      assert.equal(runtime.services.get(cacheToken), provided);
    } finally {
      await runtime.close();
    }
    assert.equal(closed, false, 'a caller-provided store must not be closed');
  });

  it('closes the owned store exactly once', async () => {
    const runtime = await runExtensions([cachePlugin({})]);
    await runtime.close();
    await runtime.close(); // idempotent
  });

  it('exposes a stable cacheToken singleton', () => {
    assert.equal(cacheToken.name, 'cache');
  });

  it('rejects a malformed store', () => {
    assert.throws(() => cachePlugin({ store: null as never }), TypeError);
    assert.throws(() => cachePlugin({ store: {} as CacheStore }), TypeError);
  });

  it('rejects an onError that is not a function', () => {
    assert.throws(() => cachePlugin({ onError: 'not a function' as never }), TypeError);
    assert.throws(() => cachePlugin({ onError: 42 as never }), TypeError);
  });
});

describe('cachePlugin mutex option', () => {
  it('provides no mutex unless asked', async () => {
    const runtime = await runExtensions([cachePlugin()]);
    try {
      assert.equal(runtime.services.has(mutexToken), false);
    } finally {
      await runtime.close();
    }
  });

  it('provides the owned store under mutexToken without connecting at setup', async () => {
    // `valkeyUrl` is intentionally unresolvable; the store is constructed but
    // never connected, so setup passes and the returned object is a MutexStore.
    const plugin = cachePlugin({ valkeyUrl: 'redis://127.0.0.1:1', mutex: true });
    assert.equal(plugin.name, 'cache');

    const runtime = await runExtensions([plugin]);
    try {
      const store: MutexStore = runtime.services.get(mutexToken);
      assert.equal(typeof store.acquire, 'function');
      assert.equal(typeof store.release, 'function');
      assert.equal(typeof store.close, 'function');
    } finally {
      await runtime.close();
    }
  });

  it('defaults to the in-memory store when no URL is configured', async () => {
    const runtime = await runExtensions([cachePlugin({ mutex: {} })]);
    try {
      const store: MutexStore = runtime.services.get(mutexToken);
      assert.equal(await store.acquire('k', 1000), true);
      assert.equal(await store.acquire('k', 1000), false);
      await store.release('k');
      assert.equal(await store.acquire('k', 1000), true);
    } finally {
      await runtime.close();
    }
  });

  it('preserves a caller-provided store and never closes it', async () => {
    let closed = false;
    const provided: MutexStore = {
      acquire: async () => true,
      release: async () => {},
      close: async () => {
        closed = true;
      },
    };

    const runtime = await runExtensions([cachePlugin({ mutex: { store: provided } })]);
    try {
      assert.equal(runtime.services.get(mutexToken), provided);
    } finally {
      await runtime.close();
    }
    assert.equal(closed, false, 'a caller-provided store must not be closed');
  });

  it('closes the owned store on teardown', async () => {
    const runtime = await runExtensions([cachePlugin({ mutex: true })]);
    const store: MutexStore = runtime.services.get(mutexToken);
    await store.acquire('k', 1000);
    await runtime.close();
    // The owned memory store's close clears its map, so the key is free again.
    assert.equal(await store.acquire('k', 1000), true);
  });

  it('rejects a malformed mutex store', () => {
    assert.throws(() => cachePlugin({ mutex: { store: null as never } }), TypeError);
    assert.throws(() => cachePlugin({ mutex: { store: {} as MutexStore } }), TypeError);
    assert.throws(
      () =>
        cachePlugin({
          mutex: { store: { acquire: async () => true } as unknown as MutexStore },
        }),
      TypeError,
    );
  });

  it('rejects a mutex option that is neither boolean nor object', () => {
    assert.throws(() => cachePlugin({ mutex: 'yes' as never }), TypeError);
    assert.throws(() => cachePlugin({ mutex: [] as never }), TypeError);
  });
});
