/** Tests for `discoverPlugins`: plugin packages, declared edges, conflicts, ordering, and read failures. */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  discoverPlugins,
  PluginDiscoveryError,
  type PluginFs,
} from '../../src/plugins/discovery/index.js';
import { packageManifestJson } from './manifest-fixture.js';

/** A minimal valid manifest fixture. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return packageManifestJson({
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
    assert.equal(plugin.packageName, 'my-plugin');
    assert.equal(plugin.root, true);
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

describe('declared plugin dependencies', () => {
  it('records a declared manifest.plugins dependency as an edge', () => {
    const root = makeDir('declared-dep');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'meta-plugin': '^1.0.0', 'acme-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'meta-plugin', 'package.json'), {
      name: 'meta-plugin',
      jsails: manifest({ id: 'meta', plugins: [{ id: 'acme', range: '^1.0.0' }] }),
    });
    writeJson(join(root, 'node_modules', 'acme-plugin', 'package.json'), pluginPackage());

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(result.edges, [{ from: 'meta', to: 'acme' }]);
    assert.equal(result.plugins.length, 2);
  });

  it('never reads the storage folder the old installer wrote bundles to', () => {
    const root = makeDir('no-bundles');
    writeJson(join(root, 'storage', 'plugins', 'acme', '1.0.0', 'manifest.json'), manifest());

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.issues, []);
  });
});

describe('duplicate conflicts', () => {
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
  it('sorts plugins by id, then version', () => {
    const root = makeDir('sort');
    const packages = {
      zzz: ['zzz', '1.0.0'],
      'aaa-two': ['aaa', '2.0.0'],
      'aaa-one': ['aaa', '1.0.0'],
      bbb: ['bbb', '1.0.0'],
    } as const;
    writeJson(join(root, 'package.json'), {
      dependencies: Object.fromEntries(Object.keys(packages).map((name) => [name, '^1.0.0'])),
    });
    for (const [name, [id, version]] of Object.entries(packages)) {
      writeJson(join(root, 'node_modules', name, 'package.json'), {
        name,
        jsails: manifest({ id, version }),
      });
    }

    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(
      result.plugins.map((p) => `${p.id}@${p.version}`),
      ['aaa@1.0.0', 'aaa@2.0.0', 'bbb@1.0.0', 'zzz@1.0.0'],
    );
  });

  it('yields an empty result when no app package exists', () => {
    const root = makeDir('empty');
    const result = discoverPlugins({ rootDir: root });
    assert.deepEqual(result.plugins, []);
    assert.deepEqual(result.issues, []);
  });

  it('reads through an injected fs facade that only reads files', () => {
    const fs: PluginFs = {
      readFileSync: (path) => {
        if (path === join('/virtual', 'package.json')) {
          return '{"dependencies":{"my-plugin":"^1.0.0"}}';
        }
        return JSON.stringify(pluginPackage());
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
    };
    const result = discoverPlugins({ rootDir: '/virtual', fs });
    assert.deepEqual(result.plugins, []);
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
