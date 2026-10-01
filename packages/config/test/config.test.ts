/** Tests for `defineConfig` and the config service: resolution order, writes, and overrides. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConfigError,
  type ConfigStore,
  createConfig,
  createMemoryConfigStore,
  defineConfig,
  text,
} from '../src/index.js';
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

describe('createConfig read cache', () => {
  it('reads the store once per set within the TTL', async () => {
    const store = countingStore();
    const config = createConfig({ store, sets: [siteConfig] });
    await config.get(siteConfig);
    await config.active(siteConfig);
    await Promise.all([config.get(siteConfig), config.get(siteConfig)]);
    assert.equal(store.reads, 1);
  });

  it('invalidates on set and replace', async () => {
    const store = countingStore();
    const config = createConfig({ store, sets: [siteConfig] });
    assert.equal((await config.get(siteConfig)).title, 'My site');
    await config.set(siteConfig, { title: 'Saved' });
    assert.equal((await config.get(siteConfig)).title, 'Saved');
    await config.replace([{ name: 'site', values: { title: 'Imported' } }]);
    assert.equal((await config.get(siteConfig)).title, 'Imported');
  });

  it('sees another process write once the TTL lapses', async () => {
    let clock = 0;
    const store = countingStore();
    const config = createConfig({ store, sets: [siteConfig], cacheTtlMs: 1000, now: () => clock });
    await config.get(siteConfig);
    await store.write([{ name: 'site', values: { title: 'Elsewhere' } }]);
    assert.equal((await config.get(siteConfig)).title, 'My site');
    clock = 1000;
    assert.equal((await config.get(siteConfig)).title, 'Elsewhere');
  });

  it('reads through every call when cacheTtlMs is 0', async () => {
    const store = countingStore();
    const config = createConfig({ store, sets: [siteConfig], cacheTtlMs: 0 });
    await config.get(siteConfig);
    await config.get(siteConfig);
    assert.equal(store.reads, 2);
  });

  it('hands each caller a copy of the cached values', async () => {
    const config = createConfig({ store: createMemoryConfigStore(), sets: [siteConfig] });
    const first = await config.get(siteConfig);
    (first.links as { home: string }).home = '/mutated';
    assert.deepEqual((await config.get(siteConfig)).links, { home: '/' });
  });

  it('keeps both of two concurrent saves of different keys', async () => {
    const store = countingStore();
    const config = createConfig({ store, sets: [siteConfig] });
    await Promise.all([
      config.set(siteConfig, { title: 'Both' }),
      config.set(siteConfig, { perPage: 42 }),
    ]);
    const values = await config.get(siteConfig);
    assert.equal(values.title, 'Both');
    assert.equal(values.perPage, 42);
  });

  it('refuses an invalid cacheTtlMs', () => {
    const store = createMemoryConfigStore();
    for (const cacheTtlMs of [-1, Number.NaN, '5' as never]) {
      assert.throws(
        () => createConfig({ store, sets: [siteConfig], cacheTtlMs }),
        rejectsWith('invalid_options'),
      );
    }
  });
});
