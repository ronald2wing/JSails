/** Tests for plugin activation: dependency and bundle sources, load failures, the managed switch, and bare-specifier resolution. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runExtensions } from '../../src/extensions/extension.js';
import { defineEvent } from '../../src/extensions/interceptors.js';
import type { PluginContext } from '../../src/extensions/plugin-contract.js';
import { activatePlugins, isBareSpecifier } from '../../src/plugins/activation.js';
import { PluginPermissionError } from '../../src/plugins/capability-gate.js';
import { PLUGIN_STATE_VERSION, type PluginStateSource } from '../../src/plugins/state-store.js';

/** A minimal valid manifest fixture. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme',
    version: '1.0.0',
    jsailsCompat: '^0.1.0',
    entry: './index.mjs',
    ...overrides,
  };
}

/** A package.json that self-identifies as a plugin with the given manifest id. */
function pluginPackage(id: string): Record<string, unknown> {
  return { name: 'pkg', version: '1.0.0', jsails: manifest({ id }) };
}

/** A valid ESM plugin module: a default-exported plugin named `name`. */
function pluginModule(name: string): string {
  return `export default { name: ${JSON.stringify(name)}, setup() {} };\n`;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-activation-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('dependency source activation', () => {
  it('imports and activates a plugin when its id is code-enabled', async () => {
    const root = makeDir('dep-activated');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), pluginModule('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'acme');
    assert.equal(typeof result.plugins[0]!.setup, 'function');
  });

  it('skips a non-enabled plugin without importing it', async () => {
    const root = makeDir('dep-not-enabled');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'acme-plugin': '^1.0.0', 'other-plugin': '^1.0.0' },
    });
    // A module that throws on import proves activation never touched it.
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), 'throw new Error("boom");\n');
    writeJson(join(root, 'node_modules', 'other-plugin', 'package.json'), pluginPackage('other'));
    writeFile(join(root, 'node_modules', 'other-plugin', 'index.mjs'), pluginModule('other'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['other'] });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['other'],
    );
    assert.deepEqual(result.skipped, [{ id: 'acme', reason: 'not-enabled' }]);
    assert.deepEqual(result.issues, []);
  });
});

describe('bundle source activation', () => {
  it('imports a bundle plugin via its manifest entry', async () => {
    const root = makeDir('bundle-activated');
    writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest());
    writeFile(join(root, 'storage', 'plugins', 'acme', 'index.mjs'), pluginModule('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'acme');
  });
});

describe('load failures', () => {
  it('reports plugin_load_failed for an invalid export and a throwing import, without aborting the rest', async () => {
    const root = makeDir('load-failures');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'bad-export': '^1.0.0', 'bad-throw': '^1.0.0', good: '^1.0.0' },
    });
    writeJson(
      join(root, 'node_modules', 'bad-export', 'package.json'),
      pluginPackage('bad-export'),
    );
    writeFile(join(root, 'node_modules', 'bad-export', 'index.mjs'), 'export default 42;\n');
    writeJson(join(root, 'node_modules', 'bad-throw', 'package.json'), pluginPackage('bad-throw'));
    writeFile(join(root, 'node_modules', 'bad-throw', 'index.mjs'), 'throw new Error("boom");\n');
    writeJson(join(root, 'node_modules', 'good', 'package.json'), pluginPackage('good'));
    writeFile(join(root, 'node_modules', 'good', 'index.mjs'), pluginModule('good'));

    const result = await activatePlugins({
      rootDir: root,
      codeEnabled: ['bad-export', 'bad-throw', 'good'],
    });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['good'],
    );
    assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
      'plugin_load_failed',
      'plugin_load_failed',
    ]);
    assert.deepEqual(result.issues.map((issue) => issue.pluginId).sort(), [
      'bad-export',
      'bad-throw',
    ]);
    // Value-free: messages never echo module contents or thrown error text.
    for (const issue of result.issues) {
      assert.equal(issue.message.includes('boom'), false);
      assert.equal(issue.message.includes('42'), false);
    }
  });

  it('orders plugins deterministically by id', async () => {
    const root = makeDir('ordering');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'multi-plugin': '^1.0.0', 'named-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'multi-plugin', 'package.json'), pluginPackage('multi'));
    writeFile(
      join(root, 'node_modules', 'multi-plugin', 'index.mjs'),
      'export default [{ name: "mb", setup() {} }, { name: "ma", setup() {} }];\n',
    );
    writeJson(join(root, 'node_modules', 'named-plugin', 'package.json'), pluginPackage('named'));
    writeFile(
      join(root, 'node_modules', 'named-plugin', 'index.mjs'),
      'export const plugins = [{ name: "named", setup() {} }];\n',
    );

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['multi', 'named'] });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['ma', 'mb', 'named'],
    );
  });
});

describe('managed/non-managed switch', () => {
  it('rejects a managed activation without a state source, value-free', async () => {
    const root = makeDir('managed-missing-source');
    await assert.rejects(
      activatePlugins({ rootDir: root, managed: true }),
      (error: unknown) => error instanceof Error && /requires a state source/.test(error.message),
    );
  });

  it('performs zero stateSource calls when not managed', async () => {
    const root = makeDir('non-managed');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), pluginModule('acme'));

    let calls = 0;
    const stateSource: PluginStateSource = {
      load: () => {
        calls += 1;
        return { version: PLUGIN_STATE_VERSION, plugins: {} };
      },
      save: () => {
        calls += 1;
      },
    };

    const result = await activatePlugins({
      rootDir: root,
      codeEnabled: ['acme'],
      managed: false,
      stateSource,
    });

    assert.equal(calls, 0);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['acme'],
    );
  });

  it('enables a plugin from managed state when no code list is present', async () => {
    const root = makeDir('managed-enabled');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage('acme'));
    writeFile(join(root, 'node_modules', 'acme-plugin', 'index.mjs'), pluginModule('acme'));

    const stateSource: PluginStateSource = {
      load: async () => ({
        version: PLUGIN_STATE_VERSION,
        plugins: { acme: { active: '1.0.0', enabled: true } },
      }),
      save: async () => {},
    };

    const result = await activatePlugins({ rootDir: root, managed: true, stateSource });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['acme'],
    );
  });
});

describe('isBareSpecifier', () => {
  it('returns false for relative paths (./ and ../)', () => {
    assert.equal(isBareSpecifier('./index.mjs'), false);
    assert.equal(isBareSpecifier('../src/main.mjs'), false);
    assert.equal(isBareSpecifier('./nested/deep.mjs'), false);
  });

  it('returns false for POSIX absolute paths', () => {
    assert.equal(isBareSpecifier('/absolute/path/main.mjs'), false);
  });

  it('returns false for Windows drive-letter paths', () => {
    assert.equal(isBareSpecifier('C:\\path\\to\\module.mjs'), false);
    assert.equal(isBareSpecifier('D:/path/to/module.mjs'), false);
  });

  it('returns true for bare module specifiers', () => {
    assert.equal(isBareSpecifier('jsails/auth'), true);
    assert.equal(isBareSpecifier('@acme/blog'), true);
    assert.equal(isBareSpecifier('pkg'), true);
    assert.equal(isBareSpecifier('my-plugin'), true);
  });
});

describe('bare specifier entry resolution', () => {
  it('resolves an own-package bare entry from the plugin location, not from core', async () => {
    // The package lives only under the app's node_modules (a temp directory),
    // so resolving the specifier from core's own location would fail.
    const root = makeDir('bare-spec');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    const packageDir = join(root, 'node_modules', 'acme-plugin');
    writeJson(join(packageDir, 'package.json'), {
      name: 'acme-plugin',
      version: '1.0.0',
      type: 'module',
      exports: { '.': './index.mjs' },
      jsails: manifest({ id: 'acme', entry: 'acme-plugin' }),
    });
    writeFile(join(packageDir, 'index.mjs'), pluginModule('bare-plugin'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.name, 'bare-plugin');
  });

  it('refuses a bare entry that names another package', async () => {
    const root = makeDir('bare-foreign');
    writeJson(join(root, 'package.json'), { dependencies: { 'acme-plugin': '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), {
      name: 'acme-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'acme', entry: 'zod' }),
    });

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.plugins, []);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['invalid_entry'],
    );
  });
});

describe('entry validation', () => {
  // A URL-scheme entry is already refused by the manifest schema, so the
  // bundle never reaches activation; a path escape is refused at activation.
  for (const [label, entry, codes] of [
    ['a parent-directory escape', '../outside.mjs', ['invalid_entry']],
    ['an absolute path', '/etc/passwd', ['invalid_entry']],
    ['a node: builtin', 'node:child_process', ['invalid_manifest', 'enabled_plugin_missing']],
    [
      'a data: url',
      'data:text/javascript,export default 1',
      ['invalid_manifest', 'enabled_plugin_missing'],
    ],
  ] as const) {
    it(`refuses a bundle entry that is ${label}`, async () => {
      const root = makeDir(`bundle-entry-${label.replace(/[^a-z]+/g, '-')}`);
      writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest({ entry }));
      writeFile(join(root, 'storage', 'plugins', 'outside.mjs'), pluginModule('outside'));

      const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

      assert.deepEqual(result.plugins, []);
      assert.deepEqual(
        result.issues.map((issue) => issue.code),
        codes,
      );
    });
  }

  it('resolves a bundle entry without a ./ prefix inside the bundle', async () => {
    const root = makeDir('bundle-entry-plain');
    writeJson(
      join(root, 'storage', 'plugins', 'acme', 'manifest.json'),
      manifest({ entry: 'index.mjs' }),
    );
    writeFile(join(root, 'storage', 'plugins', 'acme', 'index.mjs'), pluginModule('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.deepEqual(result.issues, []);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['acme'],
    );
  });

  it('reports a value-free failure class for a missing entry module', async () => {
    const root = makeDir('bundle-entry-missing');
    writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest());

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.code, 'plugin_load_failed');
    assert.equal(result.issues[0]!.detail, 'ERR_MODULE_NOT_FOUND');
  });
});

describe('managed bundle versions', () => {
  /** Install two versions of `acme`; the inactive one throws if it is ever imported. */
  function twoVersions(name: string): string {
    const root = makeDir(name);
    for (const version of ['1.0.0', '2.0.0']) {
      const dir = join(root, 'storage', 'plugins', 'acme', version, 'package');
      writeJson(join(dir, 'manifest.json'), manifest({ version }));
      writeFile(
        join(dir, 'index.mjs'),
        `if (globalThis.__activeAcme !== ${JSON.stringify(version)}) throw new Error('wrong version');\n` +
          pluginModule(`acme-${version}`),
      );
    }
    return root;
  }

  function stateWithActive(active: string): PluginStateSource {
    return {
      load: () => ({
        version: PLUGIN_STATE_VERSION,
        plugins: { acme: { active, enabled: true } },
      }),
      save: () => {},
    };
  }

  const globals = globalThis as { __activeAcme?: string };
  after(() => {
    delete globals.__activeAcme;
  });

  it('loads only the recorded active version, and follows a rollback', async () => {
    const root = twoVersions('managed-two-versions');

    globals.__activeAcme = '2.0.0';
    const upgraded = await activatePlugins({
      rootDir: root,
      managed: true,
      stateSource: stateWithActive('2.0.0'),
    });
    assert.deepEqual(upgraded.issues, []);
    assert.deepEqual(
      upgraded.plugins.map((plugin) => plugin.name),
      ['acme-2.0.0'],
    );

    globals.__activeAcme = '1.0.0';
    const rolledBack = await activatePlugins({
      rootDir: root,
      managed: true,
      stateSource: stateWithActive('1.0.0'),
    });
    assert.deepEqual(rolledBack.issues, []);
    assert.deepEqual(
      rolledBack.plugins.map((plugin) => plugin.name),
      ['acme-1.0.0'],
    );
  });

  it('reports an active version that is not installed and loads nothing', async () => {
    const root = twoVersions('managed-missing-active');
    const result = await activatePlugins({
      rootDir: root,
      managed: true,
      stateSource: stateWithActive('3.0.0'),
    });
    assert.deepEqual(result.plugins, []);
    assert.ok(result.issues.some((issue) => issue.code === 'active_version_missing'));
  });

  it('loads none of several versions when no active version is recorded', async () => {
    const root = twoVersions('unmanaged-ambiguous');
    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });
    assert.deepEqual(result.plugins, []);
    assert.ok(result.issues.some((issue) => issue.code === 'ambiguous_bundle_version'));
  });

  it('ignores installer staging leftovers and manifests nested inside a bundle', async () => {
    const root = makeDir('staging-and-nested');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeJson(join(pluginsDir, 'acme', '1.0.0', 'manifest.json'), manifest());
    writeFile(join(pluginsDir, 'acme', '1.0.0', 'index.mjs'), pluginModule('acme'));
    writeJson(
      join(pluginsDir, 'acme', '1.0.0', 'node_modules', 'dep', 'manifest.json'),
      manifest({ id: 'nested' }),
    );
    writeJson(join(pluginsDir, '.staging-abc', 'manifest.json'), manifest());
    writeFile(join(pluginsDir, '.staging-abc', 'index.mjs'), 'throw new Error("staging");\n');

    const result = await activatePlugins({
      rootDir: root,
      managed: true,
      stateSource: stateWithActive('1.0.0'),
    });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['acme'],
    );
  });
});

describe('declared permissions', () => {
  function routePlugin(name: string): string {
    return `export default { name: ${JSON.stringify(name)}, setup(ctx) { ctx.configureHttp(() => {}); } };\n`;
  }

  it('refuses a setup capability the manifest does not declare', async () => {
    const root = makeDir('permission-missing');
    writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest());
    writeFile(join(root, 'storage', 'plugins', 'acme', 'index.mjs'), routePlugin('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });
    await assert.rejects(runExtensions(result.plugins), (error: unknown) => {
      assert.ok(error instanceof PluginPermissionError);
      assert.equal(error.code, 'missing_permission');
      assert.equal(error.permission, 'http.routes');
      return true;
    });
  });

  for (const [label, call, permission] of [
    ['observe', `ctx.interceptorRegistry.observe('app.started', () => {})`, 'events.observe'],
    ['intercept', `ctx.interceptorRegistry.intercept('app.op', () => {})`, 'interceptors.register'],
  ] as const) {
    it(`refuses interceptorRegistry.${label} when the manifest does not declare it`, async () => {
      const root = makeDir(`permission-registry-${label}`);
      writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest());
      writeFile(
        join(root, 'storage', 'plugins', 'acme', 'index.mjs'),
        `export default { name: 'acme', setup(ctx) { ${call}; } };\n`,
      );

      const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });
      await assert.rejects(runExtensions(result.plugins), (error: unknown) => {
        assert.ok(error instanceof PluginPermissionError);
        assert.equal(error.code, 'missing_permission');
        assert.equal(error.permission, permission);
        return true;
      });
    });
  }

  it('keeps the shared registry open when a gated plugin calls seal', async () => {
    const root = makeDir('permission-registry-seal');
    writeJson(join(root, 'storage', 'plugins', 'acme', 'manifest.json'), manifest());
    writeFile(
      join(root, 'storage', 'plugins', 'acme', 'index.mjs'),
      `export default { name: 'acme', setup(ctx) { ctx.interceptorRegistry.seal(); } };\n`,
    );

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });
    const started = defineEvent('activation-test.seal');
    let observed = false;
    const runtime = await runExtensions([
      ...result.plugins,
      {
        name: 'later',
        setup(ctx) {
          (ctx as PluginContext).interceptorRegistry.observe(started, () => {
            observed = true;
          });
        },
      },
    ]);
    await runtime.interceptors.emit(started, undefined);
    assert.equal(observed, true);
    await runtime.close();
  });

  it('allows a capability the manifest declares', async () => {
    const root = makeDir('permission-declared');
    writeJson(
      join(root, 'storage', 'plugins', 'acme', 'manifest.json'),
      manifest({ permissions: ['http.routes'] }),
    );
    writeFile(join(root, 'storage', 'plugins', 'acme', 'index.mjs'), routePlugin('acme'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['acme'] });
    const runtime = await runExtensions(result.plugins);
    assert.equal(runtime.httpHooks.length, 1);
    await runtime.close();
  });
});

describe('autoload failures', () => {
  it('reports an autoload specifier that fails to import without aborting activation', async () => {
    const root = makeDir('autoload-failure');
    writeJson(join(root, 'package.json'), { dependencies: { 'auto-plugin': '^1.0.0' } });
    const packageDir = join(root, 'node_modules', 'auto-plugin');
    writeJson(join(packageDir, 'package.json'), {
      name: 'auto-plugin',
      version: '1.0.0',
      jsails: manifest({
        id: 'auto',
        autoload: { mode: 'selected', specifiers: ['auto-plugin/does-not-exist'] },
      }),
    });
    writeFile(join(packageDir, 'index.mjs'), pluginModule('auto'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['auto'] });

    assert.deepEqual(
      result.plugins.map((plugin) => plugin.name),
      ['auto'],
    );
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ['autoload_failed'],
    );
    assert.deepEqual(result.autoload, []);
  });

  it('refuses autoload specifiers that name another package', async () => {
    const root = makeDir('autoload-foreign');
    writeJson(join(root, 'package.json'), { dependencies: { 'auto-plugin': '^1.0.0' } });
    const packageDir = join(root, 'node_modules', 'auto-plugin');
    writeJson(join(packageDir, 'package.json'), {
      name: 'auto-plugin',
      version: '1.0.0',
      jsails: manifest({
        id: 'auto',
        autoload: { mode: 'selected', specifiers: ['zod'] },
      }),
    });
    writeFile(join(packageDir, 'index.mjs'), pluginModule('auto'));

    const result = await activatePlugins({ rootDir: root, codeEnabled: ['auto'] });

    assert.deepEqual(
      result.issues.map((issue) => [issue.code, issue.detail]),
      [['autoload_failed', 'invalid_specifier']],
    );
  });
});
