/**
 * Tests for `pluginManagerAdmin`: option validation (every rejection is a
 * value-free `PluginManagerError`) and the frozen admin plugin it returns.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PluginManagerError, pluginManagerAdmin } from '../src/index.js';
import {
  createDirectory,
  createInstaller,
  createStateSource,
  DIRECTORY_FRAMEWORK,
} from './fixtures.js';

describe('pluginManagerAdmin option validation', () => {
  it('rejects a non-boolean managed or downloads flag', () => {
    assert.throws(() => pluginManagerAdmin({ managed: 'yes' as never }), PluginManagerError);
    assert.throws(() => pluginManagerAdmin({ downloads: 1 as never }), PluginManagerError);
  });

  it('rejects a state source that is not a plugin state source', () => {
    assert.throws(() => pluginManagerAdmin({ stateSource: {} as never }), PluginManagerError);
  });

  it('rejects an installer that is not a plugin installer', () => {
    assert.throws(() => pluginManagerAdmin({ installer: {} as never }), PluginManagerError);
  });

  it('rejects an invalid enabled list', () => {
    assert.throws(() => pluginManagerAdmin({ enabled: 'acme' as never }), PluginManagerError);
    assert.throws(() => pluginManagerAdmin({ enabled: [42 as never] }), PluginManagerError);
  });

  it('rejects an invalid pluginsDir', () => {
    assert.throws(() => pluginManagerAdmin({ pluginsDir: '' }), PluginManagerError);
  });

  it('rejects an invalid directory option', () => {
    assert.throws(() => pluginManagerAdmin({ directory: {} as never }), PluginManagerError);
    assert.throws(() => pluginManagerAdmin({ directory: null as never }), PluginManagerError);
  });

  it('rejects an invalid frameworkVersion option', () => {
    assert.throws(
      () => pluginManagerAdmin({ frameworkVersion: 'not-a-version' }),
      PluginManagerError,
    );
  });

  it('accepts a directory and framework version, freezing the options', () => {
    const directory = createDirectory();
    const plugin = pluginManagerAdmin({ directory, frameworkVersion: DIRECTORY_FRAMEWORK });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'admin-plugin-manager');
  });

  it('accepts a fully configured plugin and freezes its options', () => {
    const installer = createInstaller().installer;
    const stateSource = createStateSource().source;
    const plugin = pluginManagerAdmin({
      managed: true,
      downloads: true,
      installer,
      stateSource,
      enabled: ['acme'],
    });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'admin-plugin-manager');
  });
});
