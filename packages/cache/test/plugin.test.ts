/**
 * `cache` plugin tests: the namespaced cache service and which root store
 * backs it, the opt-in lease store and where its keys live (apart from the
 * cache, optionally on a second server), ownership and cleanup, and the
 * definePlugin contract (value-free option validation before any setup, an
 * inert setup). The stores themselves are exercised by their own test files.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CacheErrors,
  cacheStoreToken,
  cacheTagsToken,
  cacheToken,
  leaseToken,
  type CacheStore,
  type LeaseStore,
} from 'jsails/cache';
import { definePlugin, runExtensions, type JsailsPlugin } from 'jsails/extensions';
import {
  checkOptionSchema,
  ConfigErrors,
  definePlugin as defineKernelPlugin,
  describePluginEnv,
  fn,
} from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';
import { z } from 'jsails/zod';
import { valkeyPlugin, valkeyToken, type ValkeyConnections } from 'jsails/plugin-sdk';

import { cachePlugin, MemoryCacheStore, MemoryLeaseStore, ValkeyLeaseStore } from '../src/index.js';
import { fakeValkey } from './fake-valkey-client.js';

/** Port 1 refuses every connection; the plugin never connects at setup anyway. */
const REFUSED_URL = 'redis://127.0.0.1:1';

const rootDir = import.meta.dirname;

// The plugin falls back to `VALKEY_URL`; the cache stage of
// `verify:integrations` sets it for this package, and these cases choose the
// backend themselves. Each test file runs in its own process.
delete process.env['VALKEY_URL'];

/** A plugin that provides `connections` as the app's Valkey, and never closes them. */
function providedValkey(connections: ValkeyConnections): JsailsPlugin {
  return definePlugin({
    name: 'test-valkey',
    setup({ services }) {
      services.provide(valkeyToken, connections);
    },
  });
}

/** A plugin that provides a root store under `cacheStoreToken`, as an application would. */
const storePlugin = defineKernelPlugin({
  name: 'test-cache-store',
  options: z.object({ store: fn<() => CacheStore>() }).strict(),
  provides: [cacheStoreToken],
  setup({ options, services }) {
    services.provide(cacheStoreToken, options.store());
  },
});

function providedStore(store: CacheStore) {
  return storePlugin({ store: () => store });
}

describe('cachePlugin cache service', () => {
  it('hands each consumer its own namespace of one in-memory root by default', async () => {
    const runtime = await runExtensions([cachePlugin()], { rootDir });
    try {
      const service = runtime.services.get(cacheToken);
      const pages = service.cache('pages');
      const feeds = service.cache('feeds');
      assert.equal(service.cache('pages'), pages, 'one name, one view');
      await pages.set('k', 'pages', 60_000);
      await feeds.set('k', 'feeds', 60_000);
      assert.deepEqual([await pages.get('k'), await feeds.get('k')], ['pages', 'feeds']);
      assert.ok(Object.isFrozen(service));
      assert.throws(
        () => service.cache('a:b'),
        (error: unknown) => CacheErrors.is(error, 'invalid_namespace'),
      );
    } finally {
      await runtime.close();
    }
  });

  it('a consumer closing its namespace stops it for no other consumer', async () => {
    const runtime = await runExtensions([cachePlugin()], { rootDir });
    try {
      const service = runtime.services.get(cacheToken);
      const held = service.cache('webhooks');
      await held.set('k', 'v', 60_000);
      await service.cache('webhooks').close();
      assert.equal(await held.get('k'), 'v');
      assert.equal(await service.cache('webhooks').add('k', 'again', 60_000), false);
    } finally {
      await runtime.close();
    }
  });

  it('applies the memory budgets', async () => {
    const runtime = await runExtensions([cachePlugin({ maxBytes: 64, maxEntries: 2 })], {
      rootDir,
    });
    try {
      const cache = runtime.services.get(cacheToken).cache('t');
      await assert.rejects(cache.set('k', 'x'.repeat(100), 1000), (error: unknown) =>
        CacheErrors.is(error, 'too_large'),
      );
      for (const key of ['a', 'b', 'c']) await cache.set(key, 'v', 60_000);
      assert.deepEqual(await cache.getMany(['a', 'b', 'c']), [null, 'v', 'v']);
    } finally {
      await runtime.close();
    }
  });

  it('uses the app Valkey connections, under <app prefix>:cache', async () => {
    const { connections, server } = fakeValkey();
    const runtime = await runExtensions([providedValkey(connections), cachePlugin()], {
      rootDir,
    });
    try {
      await runtime.services.get(cacheToken).cache('pages').set('k', 'v', 60_000);
      assert.deepEqual(server.liveKeys(), ['app:test:cache:pages:k']);
    } finally {
      await runtime.close();
    }
    await connections.close();
  });

  it('honours a cache prefix', async () => {
    const { connections, server } = fakeValkey();
    const runtime = await runExtensions(
      [providedValkey(connections), cachePlugin({ prefix: 'shop:c' })],
      { rootDir },
    );
    try {
      await runtime.services.get(cacheToken).cache('pages').set('k', 'v', 60_000);
      assert.deepEqual(server.liveKeys(), ['shop:c:pages:k']);
    } finally {
      await runtime.close();
    }
    await connections.close();
  });

  it('connects to nothing at setup', async () => {
    const runtime = await runExtensions(
      [valkeyPlugin({ url: REFUSED_URL, appPrefix: 'shop:test' }), cachePlugin({ leases: true })],
      { rootDir },
    );
    try {
      assert.ok(runtime.services.get(cacheToken));
      assert.ok(runtime.services.get(leaseToken) instanceof ValkeyLeaseStore);
    } finally {
      await runtime.close();
    }
  });

  it('namespaces a root another plugin provides and never closes it', async () => {
    const provided = new MemoryCacheStore();
    const runtime = await runExtensions(
      [providedStore(provided), cachePlugin({ store: cacheStoreToken })],
      { rootDir },
    );
    try {
      await runtime.services.get(cacheToken).cache('pages').set('k', 'v', 60_000);
      assert.equal(await provided.namespace('pages').get('k'), 'v');
    } finally {
      await runtime.close();
    }
    assert.equal(await provided.get('still-open'), null, 'a caller-provided store stays open');
  });

  it('keeps the cache in memory with store memory, even beside the app Valkey', async () => {
    const { connections, server } = fakeValkey();
    const runtime = await runExtensions(
      [providedValkey(connections), cachePlugin({ store: 'memory' })],
      { rootDir },
    );
    try {
      await runtime.services.get(cacheToken).cache('pages').set('k', 'v', 60_000);
      assert.deepEqual(server.liveKeys(), []);
    } finally {
      await runtime.close();
    }
    await connections.close();
  });

  it('builds its own Valkey connections from VALKEY_URL and closes them', async () => {
    const runtime = await runExtensions([cachePlugin({ store: 'valkey' })], {
      rootDir,
      env: { VALKEY_URL: REFUSED_URL },
    });
    const cache = runtime.services.get(cacheToken).cache('pages');
    assert.equal(runtime.services.has(valkeyToken), false, 'its connections are its own');
    await runtime.close();
    await assert.rejects(cache.get('k'), (error: unknown) => CacheErrors.is(error, 'closed'));
  });

  it('fails setup for store valkey without a Valkey', async () => {
    await assert.rejects(
      runExtensions([cachePlugin({ store: 'valkey' })], { rootDir, env: {} }),
      (error: unknown) => {
        assert.ok(CacheErrors.is(error, 'invalid_option'));
        assert.deepEqual(error.context, { option: 'store' });
        return true;
      },
    );
  });

  it('closes the root it owns, so every namespace stops', async () => {
    const runtime = await runExtensions([cachePlugin()], { rootDir });
    const cache = runtime.services.get(cacheToken).cache('pages');
    await runtime.close();
    await runtime.close();
    await assert.rejects(cache.get('k'), (error: unknown) => CacheErrors.is(error, 'closed'));
  });
});

describe('cachePlugin leases', () => {
  it('provides no lease store unless asked', async () => {
    for (const leases of [undefined, false]) {
      const runtime = await runExtensions([cachePlugin(leases === undefined ? {} : { leases })], {
        rootDir,
      });
      try {
        assert.equal(runtime.services.has(leaseToken), false);
      } finally {
        await runtime.close();
      }
    }
  });

  it('provides an in-memory lease store without Valkey, apart from the cache', async () => {
    const runtime = await runExtensions([cachePlugin({ leases: true, maxEntries: 1 })], {
      rootDir,
    });
    try {
      const leases: LeaseStore = runtime.services.get(leaseToken);
      assert.ok(leases instanceof MemoryLeaseStore);
      const lease = await leases.acquire('job', 60_000);
      assert.ok(lease !== null);
      const cache = runtime.services.get(cacheToken).cache('job');
      for (let write = 0; write < 50; write += 1) await cache.set(String(write), 'v', 60_000);
      assert.equal(await leases.acquire('job', 60_000), null, 'cache pressure left the lease');
    } finally {
      await runtime.close();
    }
  });

  it('keeps Valkey leases under <app prefix>:lease, or the given prefix', async () => {
    for (const [options, expected] of [
      [true, 'app:test:lease:k:job'],
      [{ prefix: 'locks' }, 'locks:k:job'],
    ] as const) {
      const { connections, server } = fakeValkey();
      const runtime = await runExtensions(
        [providedValkey(connections), cachePlugin({ leases: options })],
        { rootDir },
      );
      try {
        assert.ok((await runtime.services.get(leaseToken).acquire('job', 60_000)) !== null);
        assert.ok(server.liveKeys().includes(expected), server.liveKeys().join(', '));
      } finally {
        await runtime.close();
      }
      await connections.close();
    }
  });

  it('gives leases their own server with leases.url, and closes that provider', async () => {
    const runtime = await runExtensions([cachePlugin({ leases: { url: REFUSED_URL } })], {
      rootDir,
    });
    const leases = runtime.services.get(leaseToken);
    assert.ok(leases instanceof ValkeyLeaseStore);
    assert.ok(
      runtime.services.get(cacheToken).cache('x') !== undefined,
      'the cache stays in memory without app Valkey',
    );
    await runtime.close();
    await assert.rejects(leases.acquire('job', 1000), (error: unknown) =>
      CacheErrors.is(error, 'closed'),
    );
  });

  it('closes the lease store it owns', async () => {
    const runtime = await runExtensions([cachePlugin({ leases: true })], { rootDir });
    const leases = runtime.services.get(leaseToken);
    await runtime.close();
    await assert.rejects(leases.acquire('k', 1000), (error: unknown) =>
      CacheErrors.is(error, 'closed'),
    );
  });
});

describe('cachePlugin tag tokens', () => {
  it('keeps the tokens in the root store under jsails.tags', async () => {
    const provided = new MemoryCacheStore();
    const runtime = await runExtensions(
      [providedStore(provided), cachePlugin({ store: cacheStoreToken })],
      { rootDir },
    );
    try {
      const [token] = await runtime.services.get(cacheTagsToken).tokens(['t']);
      assert.equal(await provided.namespace('jsails.tags').get('t'), token);
    } finally {
      await runtime.close();
    }
  });

  it('carries invalidations on the Valkey bus when the cache is on Valkey', async () => {
    const { connections, server } = fakeValkey();
    const runtime = await runExtensions([providedValkey(connections), cachePlugin()], {
      rootDir,
    });
    try {
      const tags = runtime.services.get(cacheTagsToken);
      await tags.tokens(['t']);
      assert.equal(server.subscriberCount('app:test:cache:tags'), 1);
      await tags.invalidate(['t']);
      assert.ok(server.commands.includes('publish'));
    } finally {
      await runtime.close();
    }
    await connections.close();
  });

  it('keeps the bus off with tags.bus false, and with a memory store unless asked', async () => {
    for (const options of [{ tags: { bus: false } }, { store: 'memory' as const }]) {
      const { connections, server } = fakeValkey();
      const runtime = await runExtensions([providedValkey(connections), cachePlugin(options)], {
        rootDir,
      });
      try {
        const tags = runtime.services.get(cacheTagsToken);
        await tags.tokens(['t']);
        await tags.invalidate(['t']);
        assert.ok(!server.commands.includes('subscribe'));
        assert.ok(!server.commands.includes('publish'));
      } finally {
        await runtime.close();
      }
      await connections.close();
    }
  });

  it('puts an explicit store on the bus with tags.bus true, which needs Valkey', async () => {
    const { connections, server } = fakeValkey();
    const runtime = await runExtensions(
      [providedValkey(connections), cachePlugin({ store: 'memory', tags: { bus: true } })],
      { rootDir },
    );
    try {
      await runtime.services.get(cacheTagsToken).tokens(['t']);
      assert.equal(server.subscriberCount('app:test:cache:tags'), 1);
    } finally {
      await runtime.close();
    }
    await connections.close();
    await assert.rejects(
      runExtensions([cachePlugin({ store: 'memory', tags: { bus: true } })], { rootDir }),
      (error: unknown) => {
        const cause = (error as { cause?: unknown }).cause ?? error;
        return CacheErrors.is(cause, 'invalid_option') || CacheErrors.is(error, 'invalid_option');
      },
    );
  });

  it('closes the tag table with the app', async () => {
    const runtime = await runExtensions([cachePlugin()], { rootDir });
    const tags = runtime.services.get(cacheTagsToken);
    await runtime.close();
    await assert.rejects(tags.tokens(['t']), (error: unknown) => CacheErrors.is(error, 'closed'));
  });
});

describe('cachePlugin contract', () => {
  it('sets up inertly, providing the cache, the tags and the asked-for leases', async () => {
    const run = await testPlugin(cachePlugin({ leases: true }));
    try {
      assert.deepEqual(run.provided, [cacheToken, leaseToken, cacheTagsToken]);
    } finally {
      await run.close();
    }
  });

  it('sets up inertly on its own Valkey connections', async () => {
    const run = await testPlugin(cachePlugin(), { env: { VALKEY_URL: REFUSED_URL } });
    try {
      assert.ok(run.services.get(cacheToken));
    } finally {
      await run.close();
    }
  });

  it('declares its tokens and its environment', () => {
    assert.deepEqual(checkOptionSchema(cachePlugin.definition.options!), []);
    assert.deepEqual(cachePlugin.definition.optional, [valkeyToken]);
    assert.equal(cachePlugin.definition.provides, undefined, 'leases decide what it provides');
    assert.deepEqual(cachePlugin().provides, [cacheToken, cacheTagsToken]);
    assert.deepEqual(cachePlugin({ store: cacheStoreToken }).requires, [cacheStoreToken]);
    assert.deepEqual(cachePlugin({ store: 'memory' }).requires, []);
    assert.deepEqual(
      describePluginEnv('cache', cachePlugin.definition.env!).map((variable) => variable.name),
      ['VALKEY_URL'],
    );
  });
});

describe('cachePlugin options', () => {
  const SECRET = 's3cr3t-input';
  const cases: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'a non-object', input: SECRET },
    { name: 'an array', input: [] },
    { name: 'an unknown option', input: { [SECRET]: true } },
    { name: 'a store instance', input: { store: new MemoryCacheStore() } },
    { name: 'an unknown store kind', input: { store: SECRET } },
    { name: 'a token of another family', input: { store: cacheToken } },
    { name: 'a prefix with whitespace', input: { prefix: `two ${SECRET}` } },
    { name: 'a zero byte budget', input: { maxBytes: 0 } },
    { name: 'a fractional entry budget', input: { maxEntries: 1.5 } },
    { name: 'a lease string', input: { leases: SECRET } },
    { name: 'a lease array', input: { leases: [] } },
    { name: 'a lease store', input: { leases: { store: new MemoryLeaseStore() } } },
    { name: 'an empty lease prefix', input: { leases: { prefix: '' } } },
    {
      name: 'a lease URL of another scheme',
      input: { leases: { url: `http://user:${SECRET}@host` } },
    },
    { name: 'a tags string', input: { tags: SECRET } },
    { name: 'a zero sync interval', input: { tags: { syncMs: 0 } } },
    { name: 'a non-boolean bus', input: { tags: { bus: SECRET } } },
  ];
  for (const { name, input } of cases) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = cachePlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          assert.equal(`${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET), false);
          return true;
        },
      );
    });
  }

  it('exposes stable token names', () => {
    assert.equal(cacheToken.name, 'cache');
    assert.equal(cacheTagsToken.name, 'cache.tags');
    assert.equal(cacheStoreToken.name, 'cache.store');
    assert.equal(leaseToken.name, 'lease');
  });
});
