/**
 * Feature-flags core tests: the in-memory store's resolution and default-
 * inactive behavior, scope isolation, the service's read cache (one set read
 * per scope, invalidation on write in this and another process, no query on a
 * warm check against a real SQLite table), the `resolveFeature` branch helper,
 * the plugin's token/service wiring (with a provided store used verbatim), and
 * the value-free error guarantee.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { MemoryCacheStore, cachePlugin } from '@jsails/cache';
import { checkOptionSchema, ConfigErrors, definePlugin, fn } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';
import { z } from 'jsails/zod';
import {
  cacheStoreToken,
  createCacheSlot,
  defineCache,
  type Cache,
  type CacheStore,
} from 'jsails/cache';
import type { JsailsDataSource } from 'jsails/database';
import { runExtensions } from 'jsails/extensions';
import { createEmptyDataSource, tempDir } from 'jsails/testing';
import { cacheTagsToken, cacheToken } from 'jsails/cache';
import type { Logger } from 'typeorm';

import { FLAGS_CACHE, createFeatureFlags, type FlagSet } from '../src/flags.js';
import { JsailsFeatureFlag, createDatabaseFlagStore } from '../src/database/index.js';
import {
  FeatureFlagError,
  createMemoryFlagStore,
  featureStoreToken,
  flagsPlugin,
  flagsToken,
  resolveFeature,
  type FeatureFlags,
  type FeatureStore,
} from '../src/index.js';

/** A read cache that loads on every call, as in a process without the cache plugin. */
function uncached(): Cache<FlagSet> {
  return createCacheSlot<FlagSet>('test.flags').cache;
}

/** A plugin providing a shared root store under `cacheStoreToken`, as two processes would share one. */
const sharedStorePlugin = definePlugin({
  name: 'test-cache-store',
  options: z.object({ store: fn<() => CacheStore>() }).strict(),
  provides: [cacheStoreToken],
  setup({ options, services }) {
    services.provide(cacheStoreToken, options.store());
  },
});

/** The flags read cache of one app process over `store`. */
async function definedCache(
  t: TestContext,
  store = new MemoryCacheStore(),
  syncMs?: number,
): Promise<Cache<FlagSet>> {
  const runtime = await runExtensions(
    [
      sharedStorePlugin({ store: () => store }),
      cachePlugin({
        store: cacheStoreToken,
        ...(syncMs === undefined ? {} : { tags: { syncMs } }),
      }),
    ],
    { rootDir: import.meta.dirname },
  );
  t.after(() => runtime.close());
  return defineCache(runtime.services, FLAGS_CACHE);
}

/** A plugin providing a flag store under `featureStoreToken`, as an application would. */
const featureStorePlugin = definePlugin({
  name: 'test-feature-store',
  options: z.object({ store: fn<() => FeatureStore>() }).strict(),
  provides: [featureStoreToken],
  setup({ options, services }) {
    services.provide(featureStoreToken, options.store());
  },
});

/** A flag store that counts `all` calls. */
function countingStore(): FeatureStore & { readonly reads: () => number } {
  const inner = createMemoryFlagStore();
  let reads = 0;
  return {
    get: (key, scope) => inner.get(key, scope),
    set: (key, value, scope) => inner.set(key, value, scope),
    delete: (key, scope) => inner.delete(key, scope),
    all: async (scope) => {
      reads += 1;
      return inner.all(scope);
    },
    reads: () => reads,
  };
}

/** Count every SQL statement `dataSource` sends, through TypeORM's logger seam. */
function countStatements(dataSource: JsailsDataSource): { readonly count: number } {
  const counter = { count: 0 };
  const logger = dataSource.logger;
  dataSource.logger = new Proxy(logger, {
    get(target, property, receiver) {
      if (property === 'logQuery') {
        return (...args: Parameters<Logger['logQuery']>) => {
          counter.count += 1;
          return target.logQuery(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return counter;
}

describe('createMemoryFlagStore', () => {
  it('returns null for an unset flag (default inactive)', async () => {
    const store = createMemoryFlagStore();
    assert.equal(await store.get('missing'), null);
    assert.deepEqual(await store.all(), {});
  });

  it('round-trips set/get and distinguishes off from unset', async () => {
    const store = createMemoryFlagStore();

    await store.set('new-checkout', true);
    assert.equal(await store.get('new-checkout'), true);

    await store.set('new-checkout', false);
    assert.equal(await store.get('new-checkout'), false, 'off is distinct from unset');

    await store.delete('new-checkout');
    assert.equal(await store.get('new-checkout'), null);
  });

  it('delete is a no-op for an absent flag', async () => {
    const store = createMemoryFlagStore();
    await store.delete('never-set');
    assert.equal(await store.get('never-set'), null);
  });

  it('lists every flag in a scope through all()', async () => {
    const store = createMemoryFlagStore();

    await store.set('a', true);
    await store.set('b', false);
    await store.set('c', true, 'scoped');

    assert.deepEqual(await store.all(), { a: true, b: false });
    assert.deepEqual(await store.all('scoped'), { c: true });
    assert.deepEqual(await store.all('empty'), {});
  });
});

describe('scope isolation', () => {
  it('keeps the global scope and each scoped namespace independent', async () => {
    const store = createMemoryFlagStore();

    await store.set('dark-mode', true);
    await store.set('dark-mode', true, 'user-1');
    await store.set('dark-mode', false, 'user-2');

    assert.equal(await store.get('dark-mode'), true);
    assert.equal(await store.get('dark-mode', 'user-1'), true);
    assert.equal(await store.get('dark-mode', 'user-2'), false);
    assert.equal(await store.get('dark-mode', 'user-3'), null, 'unset scope defaults inactive');

    assert.deepEqual(await store.all(), { 'dark-mode': true });
    assert.deepEqual(await store.all('user-1'), { 'dark-mode': true });
    assert.deepEqual(await store.all('user-2'), { 'dark-mode': false });
  });

  it('deleting a scoped flag never touches another scope or the global scope', async () => {
    const store = createMemoryFlagStore();

    await store.set('beta', true);
    await store.set('beta', true, 'user-1');

    await store.delete('beta', 'user-1');

    assert.equal(await store.get('beta'), true);
    assert.equal(await store.get('beta', 'user-1'), null);
  });
});

describe('createFeatureFlags', () => {
  function service(): FeatureFlags {
    return createFeatureFlags(createMemoryFlagStore(), uncached());
  }

  it('isActive defaults to inactive for an unset flag', async () => {
    const flags = service();
    assert.equal(await flags.isActive('unknown'), false);
  });

  it('activate/deactivate flip a flag and survive reads', async () => {
    const flags = service();

    assert.equal(await flags.isActive('beta'), false);

    await flags.activate('beta');
    assert.equal(await flags.isActive('beta'), true);

    await flags.deactivate('beta');
    assert.equal(await flags.isActive('beta'), false);
  });

  it('activate/deactivate respect the scope', async () => {
    const flags = service();

    await flags.activate('beta', 'user-1');
    assert.equal(await flags.isActive('beta'), false, 'global scope is untouched');
    assert.equal(await flags.isActive('beta', 'user-1'), true);

    assert.deepEqual(await flags.all('user-1'), { beta: true });
  });
});

describe('createFeatureFlags read cache', () => {
  it("reads a scope's whole set once and evaluates every check in memory", async (t) => {
    const store = countingStore();
    await store.set('a', true);
    await store.set('b', false);
    const flags = createFeatureFlags(store, await definedCache(t));
    assert.equal(await flags.isActive('a'), true);
    assert.equal(await flags.isActive('b'), false);
    assert.equal(await flags.isActive('c'), false);
    assert.deepEqual(await flags.all(), { a: true, b: false });
    assert.equal(store.reads(), 1);
    assert.equal(await flags.isActive('a', 'user-1'), false);
    assert.equal(store.reads(), 2, 'each scope is its own entry');
  });

  it('invalidates every scope on a write through the service', async (t) => {
    const store = countingStore();
    const flags = createFeatureFlags(store, await definedCache(t));
    assert.equal(await flags.isActive('beta', 'user-1'), false);
    await flags.activate('beta', 'user-1');
    assert.equal(await flags.isActive('beta', 'user-1'), true);
    await flags.deactivate('beta', 'user-1');
    assert.equal(await flags.isActive('beta', 'user-1'), false);
  });

  it('invalidates even when a write fails, since it may have committed', async (t) => {
    const inner = createMemoryFlagStore();
    const store: FeatureStore = {
      ...inner,
      set: async (key, value, scope) => {
        await inner.set(key, value, scope);
        throw new Error('reply lost');
      },
    };
    const flags = createFeatureFlags(store, await definedCache(t));
    assert.equal(await flags.isActive('beta'), false);
    await assert.rejects(flags.activate('beta'), /reply lost/u);
    assert.equal(await flags.isActive('beta'), true);
  });

  it("sees another process's write once its invalidation reaches this process", async (t) => {
    const shared = new MemoryCacheStore();
    const store = createMemoryFlagStore();
    const reader = createFeatureFlags(store, await definedCache(t, shared, 20));
    const writer = createFeatureFlags(store, await definedCache(t, shared));
    assert.equal(await reader.isActive('beta'), false);
    await writer.activate('beta');
    const deadline = Date.now() + 10_000;
    while (!(await reader.isActive('beta'))) {
      assert.ok(Date.now() < deadline, 'the reader never saw the write');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it('issues no query for a warm check', async (t) => {
    const dataSource = await createEmptyDataSource([JsailsFeatureFlag], {
      location: join(tempDir(t), 'flags.db'),
    });
    t.after(() => dataSource.destroy());
    const statements = countStatements(dataSource);
    const flags = createFeatureFlags(
      createDatabaseFlagStore({ dataSource }),
      await definedCache(t),
    );
    await flags.activate('beta');
    assert.equal(await flags.isActive('beta'), true);
    const before = statements.count;
    assert.equal(await flags.isActive('beta'), true);
    assert.equal(await flags.isActive('other'), false);
    assert.deepEqual(await flags.all(), { beta: true });
    assert.equal(statements.count - before, 0);
  });
});

describe('resolveFeature', () => {
  it('resolves the active branch only', async () => {
    const store = createMemoryFlagStore();
    await store.set('new-ui', true);
    const feature = resolveFeature(createFeatureFlags(store, uncached()), 'new-ui');

    assert.equal(await feature.active('on'), 'on');
    assert.equal(await feature.inactive('off'), undefined);
  });

  it('resolves the inactive branch only', async () => {
    const store = createMemoryFlagStore();
    const feature = resolveFeature(createFeatureFlags(store, uncached()), 'new-ui');

    assert.equal(await feature.active('on'), undefined);
    assert.equal(await feature.inactive('off'), 'off');
  });

  it('composes into a single selection with ??', async () => {
    const store = createMemoryFlagStore();
    await store.set('new-ui', true, 'user-1');
    const feature = resolveFeature(createFeatureFlags(store, uncached()), 'new-ui', 'user-1');

    const result = (await feature.active('new')) ?? (await feature.inactive('old'));
    assert.equal(result, 'new');
  });

  it('validates the key eagerly without reading the store', () => {
    assert.throws(
      () => resolveFeature(createFeatureFlags(createMemoryFlagStore(), uncached()), ''),
      FeatureFlagError,
    );
    assert.throws(
      () => resolveFeature(createFeatureFlags(createMemoryFlagStore(), uncached()), 'ok', ''),
      FeatureFlagError,
    );
  });
});

describe('flagsPlugin', () => {
  it('has name "flags" and a stable token', () => {
    assert.equal(flagsToken.name, 'flags');
    assert.equal(flagsPlugin().name, 'flags');
  });

  it('provides a FeatureFlags service under the token', async () => {
    const runtime = await runExtensions([cachePlugin({ store: 'memory' }), flagsPlugin()], {
      rootDir: import.meta.dirname,
    });
    try {
      const flags: FeatureFlags = runtime.services.get(flagsToken);
      assert.equal(typeof flags.isActive, 'function');
      assert.equal(await flags.isActive('anything'), false);
    } finally {
      await runtime.close();
    }
  });

  it('uses the store another plugin provides, verbatim', async () => {
    const store = createMemoryFlagStore();
    await store.set('pre-seeded', true);

    const runtime = await runExtensions(
      [
        cachePlugin({ store: 'memory' }),
        featureStorePlugin({ store: () => store }),
        flagsPlugin({ store: featureStoreToken }),
      ],
      {
        rootDir: import.meta.dirname,
      },
    );
    try {
      const flags = runtime.services.get(flagsToken);
      assert.equal(
        await flags.isActive('pre-seeded'),
        true,
        'the provided store backs the service',
      );
      assert.equal(await flags.isActive('other'), false);
    } finally {
      await runtime.close();
    }
  });

  const SECRET = 'zz-secret-input';
  const invalidOptions: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'null', input: null },
    { name: 'an array', input: [] },
    { name: 'an unknown option', input: { [SECRET]: true } },
    { name: 'a store instance', input: { store: createMemoryFlagStore() } },
    { name: 'a token of another family', input: { store: flagsToken } },
    { name: 'a null store', input: { store: null } },
  ];
  for (const { name, input } of invalidOptions) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = flagsPlugin as unknown as (input: unknown) => unknown;
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

  it('sets up inertly over the cache services and provides only flagsToken', async () => {
    const cache = await runExtensions([cachePlugin({ store: 'memory' })], {
      rootDir: import.meta.dirname,
    });
    try {
      const run = await testPlugin(flagsPlugin(), {
        services: [
          [cacheToken, cache.services.get(cacheToken)],
          [cacheTagsToken, cache.services.get(cacheTagsToken)],
        ],
      });
      try {
        assert.deepEqual(run.provided, [flagsToken]);
        assert.equal(await run.services.get(flagsToken).isActive('anything'), false);
      } finally {
        await run.close();
      }
    } finally {
      await cache.close();
    }
  });

  it('declares its options and the services they name', () => {
    assert.deepEqual(checkOptionSchema(flagsPlugin.definition.options!), []);
    assert.deepEqual(flagsPlugin().requires, [cacheToken, cacheTagsToken]);
    assert.deepEqual(flagsPlugin({ store: featureStoreToken }).requires, [
      cacheToken,
      cacheTagsToken,
      featureStoreToken,
    ]);
  });

  it('needs the cache plugin', async () => {
    await assert.rejects(
      runExtensions([flagsPlugin()], { rootDir: import.meta.dirname }),
      /cache/u,
    );
  });

  it('caches the flag set its service reads while the app runs', async () => {
    const store = countingStore();
    const runtime = await runExtensions(
      [
        cachePlugin({ store: 'memory' }),
        featureStorePlugin({ store: () => store }),
        flagsPlugin({ store: featureStoreToken }),
      ],
      { rootDir: import.meta.dirname },
    );
    try {
      const flags = runtime.services.get(flagsToken);
      await flags.isActive('a');
      await flags.isActive('b');
      assert.equal(store.reads(), 1);
    } finally {
      await runtime.close();
    }
  });

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([cachePlugin({ store: 'memory' }), flagsPlugin()], {
      rootDir: import.meta.dirname,
    });
    await runtime.close();
    await runtime.close();
  });
});

describe('value-free errors', () => {
  it('rejects an empty key without echoing it', async () => {
    const store = createMemoryFlagStore();
    await assert.rejects(store.get(''), (error: unknown) => {
      assert.ok(error instanceof FeatureFlagError);
      assert.equal(
        error.message,
        'a feature flag key must be a non-empty string of at most 190 characters',
      );
      return true;
    });
  });

  it('rejects an over-long key without echoing its content', async () => {
    const store = createMemoryFlagStore();
    const secret = `SECRET_${'x'.repeat(200)}`;
    await assert.rejects(store.set(secret, true), (error: unknown) => {
      assert.ok(error instanceof FeatureFlagError);
      assert.ok(!error.message.includes('SECRET'), 'the key is never echoed');
      assert.ok(!error.message.includes('xxx'), 'the key body is never echoed');
      return true;
    });
  });

  it('rejects an empty scope and a non-boolean value', async () => {
    const store = createMemoryFlagStore();
    await assert.rejects(store.get('ok', ''), FeatureFlagError);
    await assert.rejects(store.set('ok', 'yes' as never), FeatureFlagError);
  });
});

describe('import/construction laziness', () => {
  it('constructing a store, service, or plugin performs no I/O', () => {
    // These are synchronous constructors: any connection would already have to
    // exist at this point, so this documents that none is opened.
    const store: FeatureStore = createMemoryFlagStore();
    assert.equal(typeof store.get, 'function');
    assert.equal(typeof flagsPlugin().name, 'string');
  });
});
