/**
 * Tests for `defineConfig` and the config service: resolution order, writes,
 * overrides, and the read cache (single flight, invalidation on write in this
 * and another process, no query on a warm read).
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, type TestContext } from 'node:test';

import { MemoryCacheStore, cachePlugin } from '@jsails/cache';
import { definePlugin, fn } from 'jsails/kernel';
import { z } from 'jsails/zod';
import { cacheStoreToken, defineCache, type CacheServices, type CacheStore } from 'jsails/cache';
import type { JsailsDataSource } from 'jsails/database';
import { runExtensions } from 'jsails/extensions';
import { createEmptyDataSource, tempDir } from 'jsails/testing';
import type { Logger } from 'typeorm';

import {
  CONFIG_CACHE,
  type Config,
  ConfigError,
  type ConfigStore,
  createConfig,
  createMemoryConfigStore,
  defineConfig,
  text,
} from '../src/index.js';
import { JsailsConfigEntry, createDatabaseConfigStore } from '../src/database/index.js';
import { mailConfig, siteConfig } from './fixtures.js';

function rejectsWith(code: ConfigError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ConfigError && error.code === code;
}

describe('defineConfig', () => {
  it('refuses a name that cannot be a sync file name', () => {
    for (const name of ['Site', '../x', 'a..b', '', 'site/x']) {
      assert.throws(
        () => defineConfig(name, { fields: { a: text() } }),
        rejectsWith('invalid_set'),
      );
    }
  });

  it('refuses an empty or hand-rolled field list', () => {
    assert.throws(() => defineConfig('a', { fields: {} }), rejectsWith('invalid_set'));
    assert.throws(
      () => defineConfig('a', { fields: { x: { kind: 'text' } as never } }),
      rejectsWith('invalid_field'),
    );
  });
});

describe('createConfig', () => {
  it('resolves defaults, then stored values, then overrides', async () => {
    const store = createMemoryConfigStore();
    await store.write([{ name: 'site', values: { title: 'Stored', perPage: 20 } }]);
    const config = createConfig({
      store,
      sets: [siteConfig],
      overrides: { site: { perPage: 50 } },
    });
    const values = await config.get(siteConfig);
    assert.equal(values.title, 'Stored');
    assert.equal(values.perPage, 50);
    assert.equal(values.theme, 'light');
    assert.equal((await config.active(siteConfig)).perPage, 20);
    assert.deepEqual(config.overridden(siteConfig), ['perPage']);
  });

  it('falls back to the default for a stale stored value', async () => {
    const store = createMemoryConfigStore();
    await store.write([{ name: 'site', values: { perPage: 'many', gone: true } }]);
    const config = createConfig({ store, sets: [siteConfig] });
    const values = (await config.get(siteConfig)) as Record<string, unknown>;
    assert.equal(values['perPage'], 10);
    assert.equal('gone' in values, false);
  });

  it('writes checked keys, keeps others, and drops stale stored keys', async () => {
    const store = createMemoryConfigStore();
    await store.write([{ name: 'site', values: { title: 'Kept', gone: 1 } }]);
    const config = createConfig({ store, sets: [siteConfig] });
    await config.set(siteConfig, { perPage: 30 });
    assert.deepEqual(await store.read('site'), { title: 'Kept', perPage: 30 });
  });

  it('refuses unknown, invalid, and overridden keys', async () => {
    const config = createConfig({
      store: createMemoryConfigStore(),
      sets: [siteConfig],
      overrides: { site: { title: 'Forced' } },
    });
    await assert.rejects(config.set(siteConfig, { nope: 1 } as never), rejectsWith('unknown_key'));
    await assert.rejects(config.set(siteConfig, { perPage: 0 }), rejectsWith('invalid_value'));
    await assert.rejects(config.set(siteConfig, { title: 'x' }), rejectsWith('overridden'));
  });

  it('fails at startup on a duplicate set, an unknown override, or an invalid override', () => {
    const store = createMemoryConfigStore();
    assert.throws(
      () => createConfig({ store, sets: [siteConfig, siteConfig] }),
      rejectsWith('duplicate_set'),
    );
    assert.throws(
      () => createConfig({ store, sets: [siteConfig], overrides: { nope: {} } }),
      rejectsWith('unknown_set'),
    );
    assert.throws(
      () => createConfig({ store, sets: [siteConfig], overrides: { site: { perPage: -1 } } }),
      rejectsWith('invalid_value'),
    );
  });

  it('refuses a set it was not given', async () => {
    const config = createConfig({ store: createMemoryConfigStore(), sets: [siteConfig] });
    await assert.rejects(config.get(mailConfig), rejectsWith('unknown_set'));
  });
});

/** A memory store that counts reads and yields before each write. */
function countingStore(): ConfigStore & { reads: number } {
  const inner = createMemoryConfigStore();
  const store: ConfigStore & { reads: number } = {
    reads: 0,
    async read(name) {
      store.reads += 1;
      return inner.read(name);
    },
    async write(entries) {
      await new Promise((resolve) => setImmediate(resolve));
      await inner.write(entries);
    },
  };
  return store;
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

/** The app services of one process over `store`: the cache plugin's tag table and namespaces. */
async function cacheServices(
  t: TestContext,
  store: MemoryCacheStore,
  syncMs?: number,
): Promise<CacheServices> {
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
  return runtime.services;
}

/** A config service whose reads go through a defined cache over `store`. */
async function cachedConfig(
  t: TestContext,
  store: ConfigStore,
  cacheStore = new MemoryCacheStore(),
  syncMs?: number,
): Promise<Config> {
  const services = await cacheServices(t, cacheStore, syncMs);
  return createConfig({ store, sets: [siteConfig], cache: defineCache(services, CONFIG_CACHE) });
}

describe('createConfig read cache', () => {
  it('reads the store once per set while the entry is valid', async (t) => {
    const store = countingStore();
    const config = await cachedConfig(t, store);
    await config.get(siteConfig);
    await config.active(siteConfig);
    await Promise.all([config.get(siteConfig), config.get(siteConfig)]);
    assert.equal(store.reads, 1);
  });

  it('invalidates on set and replace', async (t) => {
    const store = countingStore();
    const config = await cachedConfig(t, store);
    assert.equal((await config.get(siteConfig)).title, 'My site');
    await config.set(siteConfig, { title: 'Saved' });
    assert.equal((await config.get(siteConfig)).title, 'Saved');
    await config.replace([{ name: 'site', values: { title: 'Imported' } }]);
    assert.equal((await config.get(siteConfig)).title, 'Imported');
  });

  it('invalidates even when a write fails, since it may have committed', async (t) => {
    const inner = countingStore();
    let failing = false;
    const store: ConfigStore = {
      read: (name) => inner.read(name),
      async write(entries) {
        await inner.write(entries);
        if (failing) throw new Error('reply lost');
      },
    };
    const config = await cachedConfig(t, store);
    assert.equal((await config.get(siteConfig)).title, 'My site');
    failing = true;
    await assert.rejects(config.set(siteConfig, { title: 'Committed' }), /reply lost/u);
    assert.equal((await config.get(siteConfig)).title, 'Committed');
  });

  it("sees another process's write once its invalidation reaches this process", async (t) => {
    const shared = new MemoryCacheStore();
    const store = countingStore();
    const reader = await cachedConfig(t, store, shared, 20);
    const writer = await cachedConfig(t, store, shared);
    assert.equal((await reader.get(siteConfig)).title, 'My site');
    await writer.set(siteConfig, { title: 'Elsewhere' });
    const deadline = Date.now() + 10_000;
    while ((await reader.get(siteConfig)).title !== 'Elsewhere') {
      assert.ok(Date.now() < deadline, 'the reader never saw the write');
      await sleep(10);
    }
  });

  it('issues no query for a warm read', async (t) => {
    const dataSource = await createEmptyDataSource([JsailsConfigEntry], {
      location: join(tempDir(t), 'config.db'),
    });
    t.after(async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
    });
    const statements = countStatements(dataSource);
    const config = await cachedConfig(t, createDatabaseConfigStore({ dataSource }));
    await config.set(siteConfig, { title: 'Stored' });
    assert.equal((await config.get(siteConfig)).title, 'Stored');
    const before = statements.count;
    assert.equal((await config.get(siteConfig)).title, 'Stored');
    assert.equal((await config.active(siteConfig)).title, 'Stored');
    assert.equal(statements.count - before, 0);
  });

  it('reads through every call without a cache', async () => {
    const store = countingStore();
    const config = createConfig({ store, sets: [siteConfig] });
    await config.get(siteConfig);
    await config.get(siteConfig);
    assert.equal(store.reads, 2);
  });

  it('hands each caller a copy of the cached values', async (t) => {
    const config = await cachedConfig(t, createMemoryConfigStore());
    const first = await config.get(siteConfig);
    (first.links as { home: string }).home = '/mutated';
    assert.deepEqual((await config.get(siteConfig)).links, { home: '/' });
  });

  it('keeps both of two concurrent saves of different keys', async (t) => {
    const store = countingStore();
    const config = await cachedConfig(t, store);
    await Promise.all([
      config.set(siteConfig, { title: 'Both' }),
      config.set(siteConfig, { perPage: 42 }),
    ]);
    const values = await config.get(siteConfig);
    assert.equal(values.title, 'Both');
    assert.equal(values.perPage, 42);
  });

  it('refuses a cache that is not a defined cache', () => {
    const store = createMemoryConfigStore();
    for (const cache of [null, {}, 'cache']) {
      assert.throws(
        () => createConfig({ store, sets: [siteConfig], cache: cache as never }),
        rejectsWith('invalid_options'),
      );
    }
  });
});

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
