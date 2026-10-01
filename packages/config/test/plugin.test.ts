/**
 * Tests for `configPlugin` on the `definePlugin` contract: the services it
 * provides, the read cache it binds over the `cache` plugin, the store another
 * plugin provides, option validation when the factory is called, and the
 * default export `plugins.use` calls.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cachePlugin } from '@jsails/cache';
import { cacheTagsToken, cacheToken } from 'jsails/cache';
import { runExtensions } from 'jsails/extensions';
import { checkOptionSchema, definePlugin, fn, loadPluginContribution } from 'jsails/kernel';
import { testPlugin } from 'jsails/testing';
import { z } from 'jsails/zod';

import configDefault, {
  configPlugin,
  configStoreToken,
  configSyncToken,
  configToken,
  createMemoryConfigStore,
  type ConfigStore,
} from '../src/index.js';
import { JsailsConfigEntry } from '../src/database/index.js';
import { siteConfig } from './fixtures.js';

const rootDir = import.meta.dirname;

/** A plugin providing a store under `configStoreToken`, as an application would. */
const storePlugin = definePlugin({
  name: 'test-config-store',
  options: z.object({ store: fn<() => ConfigStore>() }).strict(),
  provides: [configStoreToken],
  setup({ options, services }) {
    services.provide(configStoreToken, options.store());
  },
});

/** A memory store that counts its reads. */
function countingStore(): ConfigStore & { readonly reads: () => number } {
  const inner = createMemoryConfigStore();
  let count = 0;
  return {
    reads: () => count,
    read: async (name) => {
      count += 1;
      return inner.read(name);
    },
    write: (entries) => inner.write(entries),
  };
}

describe('configPlugin', () => {
  it('provides the config service, with code overrides, and the sync directory', async () => {
    const runtime = await runExtensions(
      [
        cachePlugin({ store: 'memory' }),
        configPlugin({ sets: [siteConfig], overrides: { site: { title: 'Forced' } } }),
      ],
      { rootDir },
    );
    const config = runtime.services.get(configToken);
    assert.equal((await config.get(siteConfig)).title, 'Forced');
    assert.deepEqual(runtime.services.get(configSyncToken), {
      dir: join(rootDir, 'config', 'sync'),
    });
    await runtime.close();
  });

  it('resolves a relative syncDir against the app root and keeps an absolute one', async () => {
    for (const [syncDir, expected] of [
      ['settings', join(rootDir, 'settings')],
      [join(rootDir, 'abs'), join(rootDir, 'abs')],
    ] as const) {
      const runtime = await runExtensions(
        [cachePlugin({ store: 'memory' }), configPlugin({ sets: [siteConfig], syncDir })],
        { rootDir },
      );
      assert.equal(runtime.services.get(configSyncToken).dir, expected);
      await runtime.close();
    }
  });

  it('reads and writes the store another plugin provides, through its defined cache', async () => {
    const store = countingStore();
    const runtime = await runExtensions(
      [
        cachePlugin({ store: 'memory' }),
        storePlugin({ store: () => store }),
        configPlugin({ sets: [siteConfig], store: configStoreToken }),
      ],
      { rootDir },
    );
    const config = runtime.services.get(configToken);
    assert.equal((await config.get(siteConfig)).title, 'My site');
    await config.get(siteConfig);
    assert.equal(store.reads(), 1, 'the cache serves the second read');
    await config.set(siteConfig, { title: 'Saved' });
    assert.equal((await config.get(siteConfig)).title, 'Saved');
    await runtime.close();

    const next = await runExtensions(
      [
        cachePlugin({ store: 'memory' }),
        storePlugin({ store: () => store }),
        configPlugin({ sets: [siteConfig], store: configStoreToken }),
      ],
      { rootDir },
    );
    assert.equal(
      (await next.services.get(configToken).get(siteConfig)).title,
      'Saved',
      'the store kept it',
    );
    await next.close();
  });

  it('needs the cache plugin, and the store it names', async () => {
    await assert.rejects(
      runExtensions([configPlugin({ sets: [siteConfig] })], { rootDir }),
      /cache/u,
    );
    await assert.rejects(
      runExtensions(
        [
          cachePlugin({ store: 'memory' }),
          configPlugin({ sets: [siteConfig], store: configStoreToken }),
        ],
        { rootDir },
      ),
      /config\.store/u,
    );
  });

  it('refuses bad options when the factory is called, value-free', () => {
    const invalid = (options: unknown) => () => configPlugin(options as never);
    assert.throws(invalid({ sets: [siteConfig], store: {} }), { code: 'config.invalid_options' });
    assert.throws(invalid({ sets: [siteConfig], syncDir: '' }), { code: 'config.invalid_options' });
    assert.throws(invalid({ sets: [siteConfig, siteConfig] }), { code: 'config.invalid_options' });
    assert.throws(
      invalid({ sets: [siteConfig], overrides: { site: { perPage: 4242 } } }),
      (error: Error) => {
        assert.equal((error as Error & { code?: string }).code, 'config.invalid_options');
        assert.ok(!error.message.includes('4242'));
        return true;
      },
    );
    assert.throws(invalid({ sets: [siteConfig], commands: [] }), {
      code: 'config.invalid_options',
    });
  });

  it('sets up inertly, reading nothing until the service is used', async () => {
    const cache = await runExtensions([cachePlugin({ store: 'memory' })], { rootDir });
    const store = countingStore();
    try {
      const run = await testPlugin(configPlugin({ sets: [siteConfig], store: configStoreToken }), {
        services: [
          [cacheToken, cache.services.get(cacheToken)],
          [cacheTagsToken, cache.services.get(cacheTagsToken)],
          [configStoreToken, store],
        ],
        rootDir,
      });
      try {
        assert.deepEqual(run.provided, [configToken, configSyncToken]);
        assert.equal(store.reads(), 0);
        assert.equal((await run.services.get(configToken).get(siteConfig)).title, 'My site');
        assert.equal(store.reads(), 1);
      } finally {
        await run.close();
      }
    } finally {
      await cache.close();
    }
  });

  it('owns the jsails_config table whichever store the app provides', async () => {
    const schema = await loadPluginContribution(configPlugin({ sets: [siteConfig] }), 'schema');
    assert.deepEqual(schema?.models, [JsailsConfigEntry]);
  });

  it('declares an option schema the kernel can describe, and is the default export', () => {
    assert.deepEqual(checkOptionSchema(configPlugin.definition.options!), []);
    assert.equal(configDefault, configPlugin);
  });
});
