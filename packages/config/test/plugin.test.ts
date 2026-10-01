/** Tests for `configPlugin`: the service token, the schema, the commands, and the default export. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';

import configDefault, {
  ConfigError,
  JsailsConfigEntry,
  configPlugin,
  configToken,
  createMemoryConfigStore,
} from '../src/index.js';
import { siteConfig } from './fixtures.js';

describe('configPlugin', () => {
  it('provides the config service to the app', async () => {
    const plugin = configPlugin({ sets: [siteConfig], overrides: { site: { title: 'Forced' } } });
    const runtime = await runExtensions([plugin]);
    const config = runtime.services.get(configToken);
    assert.equal(config, plugin.config);
    assert.equal((await config.get(siteConfig)).title, 'Forced');
    await runtime.close();
  });

  it('declares the table only when values are persisted', () => {
    assert.equal(configPlugin({ sets: [siteConfig] }).schema, undefined);
    const persisted = configPlugin({ sets: [siteConfig], store: createMemoryConfigStore() });
    assert.deepEqual(persisted.schema?.entities, [JsailsConfigEntry]);
  });

  it('contributes the export and import commands and is the default export', () => {
    const plugin = configDefault({ sets: [siteConfig] });
    assert.deepEqual(
      plugin.commands?.map((command) => command.name),
      ['config:export', 'config:import'],
    );
  });

  it('fails at definition on bad options', () => {
    assert.throws(() => configPlugin({ sets: [siteConfig], store: {} as never }), ConfigError);
    assert.throws(() => configPlugin({ sets: [siteConfig], syncDir: '' }), ConfigError);
  });
});
