/** Tests for `discoverPlugins`: dependency and bundle sources, opt-out, conflicts, ordering, and read failures. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  discoverPlugins,
  PluginDiscoveryError,
  type PluginFs,
} from '../../src/plugins/discovery/index.js';
import { bundleManifestJson } from './manifest-fixture.js';

/** A minimal valid manifest fixture. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return bundleManifestJson({
    id: 'acme',
    version: '1.0.0',
    jsailsCompat: '^0.1.0',
    entry: './index.js',
    ...overrides,
  });
}

/** A package.json that self-identifies as a plugin. */
function pluginPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'acme', version: '1.0.0', jsails: manifest(overrides) };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-discovery-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function makeDir(name: string): string {
  const dir = join(fixturesRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('dependency source', () => {
  it('discovers a dependency that self-identifies through its jsails field', () => {
    const root = makeDir('dep-basic');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), pluginPackage());

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.issues.length, 0);
    assert.equal(result.plugins.length, 1);
    const plugin = result.plugins[0]!;
    assert.equal(plugin.id, 'acme');
    assert.equal(plugin.source, 'dependency');
    assert.equal(plugin.packageName, 'my-plugin');
    assert.equal(plugin.version, '1.0.0');
  });

  it('skips a dependency that has no jsails field', () => {
    const root = makeDir('dep-skip');
    writeJson(join(root, 'package.json'), {
      dependencies: { lodash: '^4.0.0' },
    });
    writeJson(join(root, 'node_modules', 'lodash', 'package.json'), {
      name: 'lodash',
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 0);
    assert.equal(result.issues.length, 0);
  });

  it('resolves a scoped package name into the nested node_modules path', () => {
    const root = makeDir('dep-scoped');
    writeJson(join(root, 'package.json'), {
      dependencies: { '@acme/tasks': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', '@acme', 'tasks', 'package.json'), pluginPackage());

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.packageName, '@acme/tasks');
  });

  it('reports a declared dependency whose package is not installed', () => {
    const root = makeDir('dep-missing');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 0);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.code, 'dependency_missing');
    assert.equal(result.issues[0]!.source, 'dependency');
  });

  it('reports a dependency package.json that cannot be read as a file', () => {
    const root = makeDir('dep-unreadable');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    // A directory where package.json should be makes readFileSync throw EISDIR.
    mkdirSync(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      recursive: true,
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 0);
    assert.equal(result.issues[0]!.code, 'dependency_unreadable');
  });

  it('reports an invalid manifest and omits the plugin', () => {
    const root = makeDir('dep-invalid');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: {
        id: 'Bad!',
        version: '1.0.0',
        jsailsCompat: '^0.1.0',
        entry: './x',
      },
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 0);
    assert.equal(result.issues[0]!.code, 'invalid_manifest');
  });
});

describe('bundle source', () => {
  /** Write a bundle manifest where the installer puts it: `<pluginsDir>/<id>/<version>/`. */
  function writeBundle(pluginsDir: string, value: Record<string, unknown>): void {
    writeJson(
      join(pluginsDir, String(value['id']), String(value['version']), 'manifest.json'),
      value,
    );
  }

  it('discovers a bundle manifest in the plugins folder', () => {
    const root = makeDir('bundle-basic');
    writeBundle(join(root, 'storage', 'plugins'), manifest());

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.issues.length, 0);
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.source, 'bundle');
    assert.equal(result.plugins[0]!.bundleDir, join(root, 'storage', 'plugins', 'acme', '1.0.0'));
  });

  it('honors an explicit pluginsDir', () => {
    const root = makeDir('bundle-dir');
    writeBundle(join(root, 'custom'), manifest());

    const result = discoverPlugins({
      rootDir: root,
      pluginsDir: join(root, 'custom'),
    });
    assert.equal(result.plugins.length, 1);
  });

  it('records a declared manifest.plugins dependency as an edge', () => {
    const root = makeDir('bundle-declared-dep');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeBundle(pluginsDir, manifest({ id: 'meta', plugins: [{ id: 'acme', range: '^1.0.0' }] }));
    writeBundle(pluginsDir, manifest({ id: 'acme' }));

    const result = discoverPlugins({ rootDir: root });
    // Bundle-to-bundle declared dependency is an install edge, same as npm.
    assert.deepEqual(result.edges, [{ from: 'meta', to: 'acme' }]);
    assert.equal(result.plugins.length, 2);
  });

  it('reports a disabled_required_plugin for a declared dependency that is disabled', () => {
    const root = makeDir('bundle-declared-disabled');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeBundle(pluginsDir, manifest({ id: 'meta', plugins: [{ id: 'acme', range: '^1.0.0' }] }));
    writeBundle(pluginsDir, manifest({ id: 'acme' }));

    const result = discoverPlugins({ rootDir: root, disabled: ['acme'] });
    assert.ok(
      result.issues.some((issue) => issue.code === 'disabled_required_plugin'),
      'expected a disabled_required_plugin issue for a declared bundle dependency',
    );
  });

  it('never reads a manifest nested below <id>/<version>/', () => {
    const root = makeDir('bundle-nested');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeBundle(pluginsDir, manifest());
    // A second identity hidden inside the reviewed bundle, and one placed
    // where an unversioned layout would have put it.
    writeJson(
      join(pluginsDir, 'acme', '1.0.0', 'node_modules', 'evil', 'manifest.json'),
      manifest({ id: 'evil' }),
    );
    writeJson(join(pluginsDir, 'other', 'manifest.json'), manifest({ id: 'other' }));

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((plugin) => plugin.id),
      ['acme'],
    );
  });

  it('refuses a manifest whose id or version differs from its directories', () => {
    const root = makeDir('bundle-mismatch');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeJson(join(pluginsDir, 'acme', '1.0.0', 'manifest.json'), manifest({ id: 'auth' }));
    writeJson(
      join(pluginsDir, 'tasks', '1.0.0', 'manifest.json'),
      manifest({ id: 'tasks', version: '2.0.0' }),
    );

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(
      result.issues.map((issue) => [issue.code, issue.pluginId]),
      [
        ['bundle_mismatch', 'acme'],
        ['bundle_mismatch', 'tasks'],
      ],
    );
  });

  it('reports an installed version directory without a manifest', () => {
    const root = makeDir('bundle-no-manifest');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeJson(join(pluginsDir, 'acme', '1.0.0', 'package', 'manifest.json'), manifest());

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.issues[0]!.code, 'manifest_missing');
  });

  it('allows multiple versions of the same id', () => {
    const root = makeDir('bundle-multi');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeBundle(pluginsDir, manifest());
    writeBundle(pluginsDir, manifest({ version: '2.0.0' }));

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 2);
  });

  it('skips staging directories, non-version directories, and symlinks', () => {
    const root = makeDir('bundle-symlink');
    const pluginsDir = join(root, 'storage', 'plugins');
    writeBundle(pluginsDir, manifest());
    writeJson(join(pluginsDir, '.staging-abc', '1.0.0', 'manifest.json'), manifest());
    writeJson(join(pluginsDir, 'acme', 'latest', 'manifest.json'), manifest());
    symlinkSync(join(pluginsDir, 'acme', '1.0.0'), join(pluginsDir, 'acme', '1.0.1'));
    mkdirSync(join(pluginsDir, 'linked', '1.0.0'), { recursive: true });
    symlinkSync(
      join(pluginsDir, 'acme', '1.0.0', 'manifest.json'),
      join(pluginsDir, 'linked', '1.0.0', 'manifest.json'),
    );

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((plugin) => `${plugin.id}@${plugin.version}`),
      ['acme@1.0.0'],
    );
  });
});

describe('disabled opt-out', () => {
  it('removes a plugin by id via the disabled option', () => {
    const root = makeDir('disabled-option');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), pluginPackage());

    const result = discoverPlugins({ rootDir: root, disabled: ['acme'] });
    assert.equal(result.plugins.length, 0);
  });

  it('removes a plugin by id via jsails.plugins.disabled', () => {
    const root = makeDir('disabled-package');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
      jsails: { plugins: { disabled: ['acme'] } },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), pluginPackage());

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 0);
  });
});

describe('duplicate conflicts', () => {
  it('rejects the same id across the dependency and bundle sources', () => {
    const root = makeDir('dup-cross');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), pluginPackage());
    writeJson(join(root, 'storage', 'plugins', 'acme', '1.0.0', 'manifest.json'), manifest());

    assert.throws(
      () => discoverPlugins({ rootDir: root }),
      (error: unknown) =>
        error instanceof PluginDiscoveryError && error.code === 'duplicate_cross_source',
    );
  });

  it('rejects two dependencies declaring the same plugin id', () => {
    const root = makeDir('dup-dependency');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), pluginPackage());
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), pluginPackage());

    assert.throws(
      () => discoverPlugins({ rootDir: root }),
      (error: unknown) =>
        error instanceof PluginDiscoveryError && error.code === 'duplicate_dependency_id',
    );
  });
});

describe('ordering and empty input', () => {
  it('sorts plugins by id, then version, then source', () => {
    const root = makeDir('sort');
    writeJson(join(root, 'package.json'), { dependencies: { zzz: '^1.0.0' } });
    writeJson(join(root, 'node_modules', 'zzz', 'package.json'), pluginPackage({ id: 'zzz' }));
    writeJson(
      join(root, 'storage', 'plugins', 'aaa', '2.0.0', 'manifest.json'),
      manifest({ id: 'aaa', version: '2.0.0' }),
    );
    writeJson(
      join(root, 'storage', 'plugins', 'aaa', '1.0.0', 'manifest.json'),
      manifest({ id: 'aaa', version: '1.0.0' }),
    );
    writeJson(
      join(root, 'storage', 'plugins', 'bbb', '1.0.0', 'manifest.json'),
      manifest({ id: 'bbb', version: '1.0.0' }),
    );

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((p) => `${p.id}@${p.version}[${p.source}]`),
      ['aaa@1.0.0[bundle]', 'aaa@2.0.0[bundle]', 'bbb@1.0.0[bundle]', 'zzz@1.0.0[dependency]'],
    );
  });

  it('yields an empty result when no app package or plugins folder exists', () => {
    const root = makeDir('empty');
    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.issues, []);
  });

  it('reads through the injectable fs facade', () => {
    const fs: PluginFs = {
      readFileSync: (path) => {
        if (path === join('/virtual', 'package.json')) {
          return '{"dependencies":{"my-plugin":"^1.0.0"}}';
        }
        return JSON.stringify(pluginPackage());
      },
      readdirSync: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    const result = discoverPlugins({ rootDir: '/virtual', fs });
    assert.equal(result.plugins.length, 1);
    assert.equal(result.plugins[0]!.packageName, 'my-plugin');
  });
});

describe('unexpected read failures', () => {
  it('treats a non-ENOENT app package read as an empty package', () => {
    const fs: PluginFs = {
      readFileSync: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      readdirSync: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    const result = discoverPlugins({ rootDir: '/virtual', fs });
    assert.deepEqual(result.plugins, []);
  });

  it('reports a bundle manifest that cannot be read', () => {
    const pluginsDir = join('/virtual', 'storage', 'plugins');
    const fs: PluginFs = {
      readFileSync: (path) => {
        if (path === join('/virtual', 'package.json')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (path === join(pluginsDir, 'acme', '1.0.0', 'manifest.json')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        throw new Error('unexpected read');
      },
      readdirSync: (path) => {
        if (path === pluginsDir) {
          return [
            {
              name: 'acme',
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        if (path === join(pluginsDir, 'acme')) {
          return [
            {
              name: '1.0.0',
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            },
          ];
        }
        if (path === join(pluginsDir, 'acme', '1.0.0')) {
          return [
            {
              name: 'manifest.json',
              isFile: () => true,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            },
          ];
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    const result = discoverPlugins({ rootDir: '/virtual', fs });
    assert.equal(result.plugins.length, 0);
    assert.equal(result.issues[0]!.source, 'bundle');
    assert.equal(result.issues[0]!.code, 'manifest_unreadable');
  });

  it('reports a bundle manifest that is not valid JSON', () => {
    const root = makeDir('bundle-badjson');
    const path = join(root, 'storage', 'plugins', 'acme', '1.0.0', 'manifest.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'not json', 'utf8');

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 0);
    assert.equal(result.issues[0]!.code, 'invalid_manifest');
  });
});

describe('transitive dependencies', () => {
  it('walks a transitive plugin dependency, recording provenance and one edge', () => {
    const root = makeDir('transitive-chain');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'child-plugin': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });
    writeJson(join(root, 'node_modules', 'child-plugin', 'package.json'), {
      name: 'child-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'child' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.issues.length, 0);
    assert.equal(result.plugins.length, 2);

    const parent = result.plugins.find((p) => p.id === 'parent')!;
    const child = result.plugins.find((p) => p.id === 'child')!;

    assert.equal(parent.root, true);
    assert.deepEqual(parent.requiredBy, []);
    assert.deepEqual(parent.provenanceChain, ['parent']);

    assert.equal(child.root, false);
    assert.deepEqual(child.requiredBy, ['parent']);
    assert.deepEqual(child.provenanceChain, ['child', 'parent']);

    assert.deepEqual(result.edges, [{ from: 'parent', to: 'child' }]);
  });

  it('resolves a scoped transitive dependency name', () => {
    const root = makeDir('transitive-scoped');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { '@acme/child': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });
    writeJson(join(root, 'node_modules', '@acme', 'child', 'package.json'), {
      name: '@acme/child',
      version: '1.0.0',
      jsails: manifest({ id: 'child' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.issues.length, 0);
    const child = result.plugins.find((p) => p.id === 'child')!;
    assert.equal(child.packageName, '@acme/child');
    assert.equal(child.root, false);
    assert.deepEqual(result.edges, [{ from: 'parent', to: 'child' }]);
  });

  it('merges the same id+version reached via multiple parents', () => {
    const root = makeDir('transitive-merge');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      dependencies: { shared: '^1.0.0' },
      jsails: manifest({ id: 'alpha' }),
    });
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), {
      name: 'b-plugin',
      version: '1.0.0',
      dependencies: { shared: '^1.0.0' },
      jsails: manifest({ id: 'beta' }),
    });
    writeJson(join(root, 'node_modules', 'shared', 'package.json'), {
      name: 'shared',
      version: '1.0.0',
      jsails: manifest({ id: 'shared' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.issues.length, 0);
    assert.equal(result.plugins.length, 3);

    const shared = result.plugins.find((p) => p.id === 'shared')!;
    assert.equal(shared.root, false);
    assert.deepEqual(shared.requiredBy, ['alpha', 'beta']);
    assert.deepEqual(shared.provenanceChain, ['alpha', 'beta', 'shared']);
    assert.deepEqual(result.edges, [
      { from: 'alpha', to: 'shared' },
      { from: 'beta', to: 'shared' },
    ]);
  });

  it('reports a transitive dependency that is not installed', () => {
    const root = makeDir('transitive-missing');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'missing-plugin': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.equal(result.plugins.length, 1);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.code, 'transitive_dependency_missing');
    assert.equal(result.issues[0]!.source, 'dependency');
    assert.deepEqual(result.edges, []);
  });

  it('never resolves a transitive dependency beyond rootDir', () => {
    const root = makeDir('transitive-escape');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'escape-plugin': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });
    // The package exists only ABOVE rootDir (one level up, in the shared tmp dir).
    writeJson(join(fixturesRoot, 'node_modules', 'escape-plugin', 'package.json'), {
      name: 'escape-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'escape' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['parent'],
    );
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]!.code, 'transitive_dependency_missing');
  });
});

describe('dependency cycles', () => {
  it('reports a cycle with its chain and stops traversing it', () => {
    const root = makeDir('cycle-basic');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      dependencies: { 'b-plugin': '^1.0.0' },
      jsails: manifest({ id: 'a' }),
    });
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), {
      name: 'b-plugin',
      version: '1.0.0',
      dependencies: { 'a-plugin': '^1.0.0' },
      jsails: manifest({ id: 'b' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['a', 'b'],
    );
    const cycle = result.issues.find((issue) => issue.code === 'dependency_cycle');
    assert.ok(cycle, 'expected a dependency_cycle issue');
    assert.equal(cycle.message, 'dependency cycle: a -> b -> a');
    assert.equal(cycle.pluginId, 'a');
  });
});

describe('conflicting plugin versions', () => {
  it('reports the same id at two different versions without a hard error', () => {
    const root = makeDir('conflict-versions');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'shared', version: '1.0.0' }),
    });
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), {
      name: 'b-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'shared', version: '2.0.0' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((p) => `${p.id}@${p.version}`),
      ['shared@1.0.0', 'shared@2.0.0'],
    );
    const conflict = result.issues.find((issue) => issue.code === 'conflicting_plugin_versions');
    assert.ok(conflict, 'expected a conflicting_plugin_versions issue');
    assert.equal(conflict.pluginId, 'shared');
    assert.equal(conflict.message, 'plugin "shared" has conflicting versions: 1.0.0, 2.0.0');
  });
});

describe('disabled reachability', () => {
  it('prunes a disabled root and its exclusively-owned descendants', () => {
    const root = makeDir('disabled-subtree');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'child-plugin': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });
    writeJson(join(root, 'node_modules', 'child-plugin', 'package.json'), {
      name: 'child-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'child' }),
    });

    const result = discoverPlugins({ rootDir: root, disabled: ['parent'] });
    assert.deepEqual(result.plugins, []);
  });

  it('keeps a descendant also reachable from an enabled root', () => {
    const root = makeDir('disabled-shared');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      dependencies: { shared: '^1.0.0' },
      jsails: manifest({ id: 'enabled-root' }),
    });
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), {
      name: 'b-plugin',
      version: '1.0.0',
      dependencies: { shared: '^1.0.0' },
      jsails: manifest({ id: 'disabled-root' }),
    });
    writeJson(join(root, 'node_modules', 'shared', 'package.json'), {
      name: 'shared',
      version: '1.0.0',
      jsails: manifest({ id: 'shared' }),
    });

    const result = discoverPlugins({
      rootDir: root,
      disabled: ['disabled-root'],
    });
    assert.deepEqual(result.plugins.map((p) => p.id).sort(), ['enabled-root', 'shared']);
  });

  it('reports an enabled plugin that requires a disabled plugin id', () => {
    const root = makeDir('disabled-required');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'child-plugin': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });
    writeJson(join(root, 'node_modules', 'child-plugin', 'package.json'), {
      name: 'child-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'child' }),
    });

    const result = discoverPlugins({ rootDir: root, disabled: ['child'] });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['parent'],
    );
    const issue = result.issues.find((issue) => issue.code === 'disabled_required_plugin');
    assert.ok(issue, 'expected a disabled_required_plugin issue');
    assert.equal(issue.pluginId, 'parent');
  });
});

describe('enabled allowlist', () => {
  it('returns only plugins whose id is listed in enabled', () => {
    const root = makeDir('enabled-filter');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'alpha' }),
    });
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), {
      name: 'b-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'beta' }),
    });

    const result = discoverPlugins({ rootDir: root, enabled: ['beta'] });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['beta'],
    );
    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.skipped, [{ id: 'alpha', reason: 'not-enabled' }]);
  });

  it('emits enabled_plugin_missing for a listed id that is not installed, without throwing', () => {
    const root = makeDir('enabled-missing');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'alpha' }),
    });

    const result = discoverPlugins({
      rootDir: root,
      enabled: ['alpha', 'ghost'],
    });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['alpha'],
    );
    const missing = result.issues.find((issue) => issue.code === 'enabled_plugin_missing');
    assert.ok(missing, 'expected an enabled_plugin_missing issue');
    assert.equal(missing.pluginId, 'ghost');
    assert.deepEqual(result.skipped, [{ id: 'ghost', reason: 'missing' }]);
  });

  it('lets disabled win over enabled for a listed id', () => {
    const root = makeDir('enabled-disabled');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'alpha' }),
    });

    const result = discoverPlugins({
      rootDir: root,
      enabled: ['alpha'],
      disabled: ['alpha'],
    });
    assert.deepEqual(result.plugins, []);
    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.skipped, [{ id: 'alpha', reason: 'disabled' }]);
  });

  it('skips a discovered plugin not in the list without emitting an issue for it', () => {
    const root = makeDir('enabled-no-issue');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0', 'b-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'alpha' }),
    });
    writeJson(join(root, 'node_modules', 'b-plugin', 'package.json'), {
      name: 'b-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'beta' }),
    });

    const result = discoverPlugins({ rootDir: root, enabled: ['alpha'] });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['alpha'],
    );
    assert.equal(result.issues.length, 0);
    assert.deepEqual(result.skipped, [{ id: 'beta', reason: 'not-enabled' }]);
  });

  it('gates transitive dependencies by id, leaving the graph and provenance intact', () => {
    const root = makeDir('enabled-transitive');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'child-plugin': '^1.0.0' },
      jsails: manifest({ id: 'parent' }),
    });
    writeJson(join(root, 'node_modules', 'child-plugin', 'package.json'), {
      name: 'child-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'child' }),
    });

    const result = discoverPlugins({ rootDir: root, enabled: ['child'] });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['child'],
    );
    assert.deepEqual(result.skipped, [{ id: 'parent', reason: 'not-enabled' }]);
    assert.deepEqual(result.edges, [{ from: 'parent', to: 'child' }]);
    assert.deepEqual(result.plugins[0]!.provenanceChain, ['child', 'parent']);
  });

  it('omitting enabled preserves the current behavior with no skipped field', () => {
    const root = makeDir('enabled-omitted');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'a-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'alpha' }),
    });

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['alpha'],
    );
    assert.equal('skipped' in result, false);
  });

  it('orders skipped entries deterministically by id, then reason', () => {
    const root = makeDir('enabled-order');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'm-plugin': '^1.0.0', 'a-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'm-plugin', 'package.json'), {
      name: 'm-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'm' }),
    });
    writeJson(join(root, 'node_modules', 'a-plugin', 'package.json'), {
      name: 'a-plugin',
      version: '1.0.0',
      jsails: manifest({ id: 'a' }),
    });
    writeJson(
      join(root, 'storage', 'plugins', 'z', '1.0.0', 'manifest.json'),
      manifest({ id: 'z' }),
    );

    const result = discoverPlugins({
      rootDir: root,
      enabled: ['a', 'ghost'],
      disabled: ['z'],
    });
    assert.deepEqual(
      result.plugins.map((p) => p.id),
      ['a'],
    );
    assert.deepEqual(result.skipped, [
      { id: 'ghost', reason: 'missing' },
      { id: 'm', reason: 'not-enabled' },
      { id: 'z', reason: 'disabled' },
    ]);
  });
});
