import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InstallPlanError,
  planPluginInstall,
  planPluginRollback,
  planPluginUpdate,
  parsePluginDirectoryEntry,
  type InstalledPlugin,
} from '../../src/directory/index.js';
import { PLUGIN_STATE_VERSION, type PluginState } from 'jsails/plugins';

const FRAMEWORK = '1.5.0';
const INCOMPATIBLE_FRAMEWORK = '2.0.0';

function entry(overrides: Record<string, unknown> = {}) {
  return parsePluginDirectoryEntry({
    id: 'acme-tasks',
    name: 'Acme Tasks',
    description: 'Task management for teams.',
    categories: ['productivity'],
    featured: false,
    latestVersion: '1.2.3',
    frameworkRange: '>=1.0.0 <2.0.0',
    specifier: 'acme-tasks@1.2.3',
    ...overrides,
  });
}

function state(entries: Record<string, { active: string; enabled: boolean }> = {}): PluginState {
  return { version: PLUGIN_STATE_VERSION, plugins: entries };
}

describe('planPluginInstall', () => {
  it('plans a fresh install at the latest version', () => {
    const plan = planPluginInstall(entry(), state(), FRAMEWORK);
    assert.deepEqual(plan, {
      action: 'install',
      pluginId: 'acme-tasks',
      toVersion: '1.2.3',
      specifier: 'acme-tasks@1.2.3',
    });
    assert.equal(Object.isFrozen(plan), true);
  });

  it('rejects an install when the plugin is already recorded in state', () => {
    assert.throws(
      () =>
        planPluginInstall(
          entry(),
          state({ 'acme-tasks': { active: '1.0.0', enabled: true } }),
          FRAMEWORK,
        ),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'already_installed',
    );
  });

  it('rejects an incompatible framework version', () => {
    assert.throws(
      () => planPluginInstall(entry(), state(), INCOMPATIBLE_FRAMEWORK),
      (error: unknown) =>
        error instanceof InstallPlanError && error.code === 'incompatible_version',
    );
  });

  it('rejects a malformed framework version', () => {
    assert.throws(
      () => planPluginInstall(entry(), state(), 'nope'),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'invalid_framework',
    );
  });
});

describe('planPluginUpdate', () => {
  it('plans an upgrade to the latest version', () => {
    const installed: InstalledPlugin = { version: '1.0.0' };
    const plan = planPluginUpdate(entry(), installed, FRAMEWORK);
    assert.deepEqual(plan, {
      action: 'update',
      pluginId: 'acme-tasks',
      fromVersion: '1.0.0',
      toVersion: '1.2.3',
      specifier: 'acme-tasks@1.2.3',
    });
  });

  it('rejects an update when already at the latest version', () => {
    assert.throws(
      () => planPluginUpdate(entry(), { version: '1.2.3' }, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'up_to_date',
    );
  });

  it('rejects an update when the installed version is newer', () => {
    assert.throws(
      () => planPluginUpdate(entry(), { version: '2.0.0' }, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'not_upgrade',
    );
  });

  it('rejects an update for an unknown plugin', () => {
    assert.throws(
      () => planPluginUpdate(entry(), undefined, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'unknown_plugin',
    );
  });

  it('rejects a malformed active version', () => {
    assert.throws(
      () => planPluginUpdate(entry(), { version: 'nope' }, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'invalid_installed',
    );
  });

  it('rejects an incompatible framework version', () => {
    assert.throws(
      () => planPluginUpdate(entry(), { version: '1.0.0' }, INCOMPATIBLE_FRAMEWORK),
      (error: unknown) =>
        error instanceof InstallPlanError && error.code === 'incompatible_version',
    );
  });
});

describe('planPluginRollback', () => {
  it('plans a rollback to the previous version', () => {
    const installed: InstalledPlugin = { version: '1.2.3', previousVersion: '1.1.0' };
    const plan = planPluginRollback(entry(), installed, FRAMEWORK);
    assert.deepEqual(plan, {
      action: 'rollback',
      pluginId: 'acme-tasks',
      fromVersion: '1.2.3',
      toVersion: '1.1.0',
      specifier: 'acme-tasks@1.2.3',
    });
  });

  it('rejects a rollback without a previous version', () => {
    assert.throws(
      () => planPluginRollback(entry(), { version: '1.2.3' }, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'no_previous_version',
    );
  });

  it('rejects a rollback whose previous version equals the active version', () => {
    assert.throws(
      () => planPluginRollback(entry(), { version: '1.2.3', previousVersion: '1.2.3' }, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'same_version',
    );
  });

  it('rejects a rollback with a malformed previous version', () => {
    assert.throws(
      () => planPluginRollback(entry(), { version: '1.2.3', previousVersion: 'x.y.z' }, FRAMEWORK),
      (error: unknown) =>
        error instanceof InstallPlanError && error.code === 'invalid_previous_version',
    );
  });

  it('rejects a rollback for an unknown plugin', () => {
    assert.throws(
      () => planPluginRollback(entry(), undefined, FRAMEWORK),
      (error: unknown) => error instanceof InstallPlanError && error.code === 'unknown_plugin',
    );
  });

  it('rejects an incompatible framework version', () => {
    assert.throws(
      () =>
        planPluginRollback(
          entry(),
          { version: '1.2.3', previousVersion: '1.1.0' },
          INCOMPATIBLE_FRAMEWORK,
        ),
      (error: unknown) =>
        error instanceof InstallPlanError && error.code === 'incompatible_version',
    );
  });

  it('never echoes raw ids or versions in its message', () => {
    try {
      planPluginInstall(entry(), state(), 'SECRET-VERSION');
      assert.fail('expected an InstallPlanError');
    } catch (error) {
      assert.ok(error instanceof InstallPlanError);
      assert.ok(!error.message.includes('SECRET-VERSION'), error.message);
    }
  });
});
