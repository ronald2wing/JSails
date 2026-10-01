/**
 * Tests for plugin manifest v1 (`checkPluginManifest`, `parsePluginManifest`,
 * `parsePackageManifest`, `parseBundleManifest`) and the semver helpers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkPluginManifest,
  isValidSemverRange,
  isValidSemverVersion,
  parseBundleManifest,
  parsePackageManifest,
  parsePluginManifest,
  parseSemver,
  PluginManifestError,
  satisfiesRange,
  type PluginManifestSource,
} from '../../src/plugins/manifest/index.js';

/** A minimal valid package manifest. */
function packageManifest(): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'acme-tasks',
    version: '1.2.3',
    name: 'Tasks',
    summary: 'A task list for the admin.',
    publisher: 'acme',
    jsailsCompat: '^1.0.0',
    apiTier: 'stable',
    entry: '@acme/tasks',
  };
}

/** A minimal valid bundle manifest. */
function bundleManifest(): Record<string, unknown> {
  return { ...packageManifest(), entry: './index.mjs', marketplace: true };
}

/** The issue codes of a manifest that must be refused. */
function codes(raw: unknown, source: PluginManifestSource = 'package'): string[] {
  const result = checkPluginManifest(raw, source);
  assert.equal(result.ok, false, 'the manifest must be refused');
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

/** The issue paths of a manifest that must be refused, joined for comparison. */
function paths(raw: unknown, source: PluginManifestSource = 'package'): string[] {
  const result = checkPluginManifest(raw, source);
  assert.equal(result.ok, false, 'the manifest must be refused');
  return result.ok ? [] : result.issues.map((issue) => issue.path.join('.'));
}

describe('plugin manifest v1', () => {
  it('parses a minimal package manifest and fills the defaults', () => {
    const manifest = parsePackageManifest(packageManifest());
    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.id, 'acme-tasks');
    assert.equal(manifest.apiTier, 'stable');
    assert.equal(manifest.browserSafe, false);
    assert.equal(manifest.marketplace, false);
    assert.deepEqual(manifest.permissions, []);
    assert.deepEqual(manifest.plugins, []);
    assert.equal(manifest.settings, undefined);
    assert.ok(Object.isFrozen(manifest));
    assert.ok(Object.isFrozen(manifest.permissions));
  });

  it('parses every field of a package manifest', () => {
    const manifest = parsePackageManifest({
      ...packageManifest(),
      browserSafe: true,
      permissions: ['http.routes', 'data.own', 'admin.pages', 'net.fetch:api.acme.dev'],
      plugins: [{ id: 'acme-core', range: '^2.0.0' }],
      settings: {
        type: 'object',
        properties: { apiKey: { type: 'string', format: 'secret' } },
        required: ['apiKey'],
      },
      schema: { tablePrefix: 'acme_tasks_' },
      admin: { nav: [{ label: 'Tasks', path: '/tasks' }] },
      host: { imports: ['jsails', 'jsails/http', '@jsails/admin'] },
      marketplace: true,
      commands: [{ name: 'tasks:prune', summary: 'Delete done tasks.', module: '@acme/tasks/cli' }],
      generators: [{ name: 'task', summary: 'Generate a task type.', module: '@acme/tasks/make' }],
      autoload: { mode: 'selected', specifiers: ['@acme/tasks/helpers'] },
      env: [
        { name: 'TASKS_TOKEN', kind: 'secret', required: true, generate: true },
        { name: 'TASKS_URL', kind: 'url' },
      ],
    });
    assert.deepEqual(manifest.settings?.required, ['apiKey']);
    assert.deepEqual(manifest.schema, { tablePrefix: 'acme_tasks_' });
    assert.deepEqual(manifest.env?.[1], {
      name: 'TASKS_URL',
      kind: 'url',
      required: false,
      generate: false,
    });
    assert.equal(manifest.commands?.[0]?.name, 'tasks:prune');
  });

  it('parses a bundle manifest', () => {
    const manifest = parseBundleManifest({
      ...bundleManifest(),
      permissions: ['data.own'],
      schema: { tablePrefix: 'acme_tasks_', file: 'models.json' },
    });
    assert.equal(manifest.entry, './index.mjs');
    assert.equal(manifest.schema?.file, 'models.json');
  });

  it('requires the format version and the descriptive fields', () => {
    for (const field of [
      'manifestVersion',
      'id',
      'version',
      'name',
      'summary',
      'publisher',
      'jsailsCompat',
      'apiTier',
      'entry',
    ]) {
      const raw = packageManifest();
      delete raw[field];
      assert.deepEqual(paths(raw), [field], field);
    }
    assert.deepEqual(paths({ ...packageManifest(), manifestVersion: 2 }), ['manifestVersion']);
  });

  it('rejects unknown fields, including the removed integrity fields', () => {
    for (const field of ['checksums', 'signature', 'settingsSchema']) {
      assert.deepEqual(codes({ ...packageManifest(), [field]: {} }), ['unknown_field'], field);
    }
  });

  it('rejects a name or summary that is blank or spans lines', () => {
    assert.deepEqual(paths({ ...packageManifest(), name: '   ' }), ['name']);
    assert.deepEqual(paths({ ...packageManifest(), summary: 'one\ntwo' }), ['summary']);
  });

  it('rejects a version that is not semver', () => {
    assert.deepEqual(codes({ ...packageManifest(), version: '1.2' }), ['invalid_version']);
  });

  describe('jsailsCompat', () => {
    it('accepts one caret or tilde range for a stable plugin', () => {
      for (const range of ['^1.0.0', '~1.4.2', '^0.3.0']) {
        assert.equal(
          checkPluginManifest({ ...packageManifest(), jsailsCompat: range }, 'package').ok,
          true,
        );
      }
    });

    it('rejects any other range', () => {
      for (const range of [
        '1.0.0',
        '>=1.0.0 <2.0.0',
        '^1.0.0 || ^2.0.0',
        '*',
        '^1.0',
        '^1.0.0-rc.1',
        'x',
      ]) {
        assert.deepEqual(
          codes({ ...packageManifest(), jsailsCompat: range }),
          ['invalid_compat_range'],
          range,
        );
      }
    });

    it('requires a tilde range for an experimental plugin', () => {
      const experimental = { ...packageManifest(), apiTier: 'experimental' };
      assert.deepEqual(codes({ ...experimental, jsailsCompat: '^1.2.0' }), [
        'experimental_requires_tilde',
      ]);
      assert.equal(
        checkPluginManifest({ ...experimental, jsailsCompat: '~1.2.0' }, 'package').ok,
        true,
      );
    });
  });

  describe('permissions', () => {
    it('rejects a permission the registry does not define', () => {
      for (const permission of ['database.read', 'network.connect', 'logging.write']) {
        assert.deepEqual(
          codes({ ...packageManifest(), permissions: [permission] }),
          ['unknown_permission'],
          permission,
        );
      }
    });

    it('checks scopes', () => {
      assert.deepEqual(codes({ ...packageManifest(), permissions: ['net.fetch'] }), [
        'scope_required',
      ]);
      assert.deepEqual(codes({ ...packageManifest(), permissions: ['mail.send:x'] }), [
        'scope_not_allowed',
      ]);
      assert.deepEqual(codes({ ...packageManifest(), permissions: ['env.read:JSAILS_ENV'] }), [
        'reserved_scope',
      ]);
    });

    it('rejects a duplicate permission', () => {
      assert.deepEqual(paths({ ...packageManifest(), permissions: ['mail.send', 'mail.send'] }), [
        'permissions.1',
      ]);
    });

    it('requires data.own for owned tables and admin.pages for admin navigation', () => {
      assert.deepEqual(paths({ ...packageManifest(), schema: { tablePrefix: 'acme_' } }), [
        'schema',
      ]);
      assert.deepEqual(
        paths({ ...packageManifest(), admin: { nav: [{ label: 'Tasks', path: '/tasks' }] } }),
        ['admin.nav'],
      );
      assert.equal(
        checkPluginManifest({ ...packageManifest(), admin: { nav: [] } }, 'package').ok,
        true,
      );
    });
  });

  describe('plugins', () => {
    it('rejects an invalid range, a duplicate id, and a self dependency', () => {
      assert.deepEqual(
        codes({ ...packageManifest(), plugins: [{ id: 'acme-core', range: 'nope' }] }),
        ['invalid_range'],
      );
      assert.deepEqual(
        paths({
          ...packageManifest(),
          plugins: [
            { id: 'acme-core', range: '^1.0.0' },
            { id: 'acme-core', range: '^2.0.0' },
          ],
        }),
        ['plugins.1.id'],
      );
      assert.deepEqual(
        codes({ ...packageManifest(), plugins: [{ id: 'acme-tasks', range: '^1.0.0' }] }),
        ['self_dependency'],
      );
    });
  });

  describe('settings', () => {
    it('reports settings-schema issues under the settings path', () => {
      const result = checkPluginManifest(
        {
          ...packageManifest(),
          settings: { type: 'object', properties: { token: { type: 'string', pattern: '^a' } } },
        },
        'package',
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(result.issues[0]?.path, ['settings', 'properties', 'token', 'pattern']);
        assert.equal(result.issues[0]?.code, 'unknown_keyword');
      }
    });
  });

  describe('entry', () => {
    it('refuses a URL in either carrier', () => {
      for (const entry of [
        'node:fs',
        'data:text/javascript,1',
        'https://x.test/a.js',
        'file:///a.js',
      ]) {
        assert.deepEqual(codes({ ...packageManifest(), entry }), ['invalid_entry'], entry);
        assert.deepEqual(codes({ ...bundleManifest(), entry }, 'bundle'), ['invalid_entry'], entry);
      }
    });

    it('accepts the package specifier or a path inside the package', () => {
      for (const entry of ['@acme/tasks/plugin', './dist/plugin.js', 'dist/plugin.js']) {
        assert.equal(
          checkPluginManifest({ ...packageManifest(), entry }, 'package').ok,
          true,
          entry,
        );
      }
    });

    it('refuses a path that leaves its root', () => {
      for (const entry of ['../x.js', './a/../../x.js', '/abs.js', 'C:/x.js', 'a\\b.js', './']) {
        assert.deepEqual(codes({ ...bundleManifest(), entry }, 'bundle'), ['invalid_entry'], entry);
      }
    });
  });

  describe('bundle carrier', () => {
    it('rejects every npm-only field', () => {
      const npmOnly = {
        commands: [{ name: 'x', summary: 'X.', module: '@acme/tasks/x' }],
        generators: [{ name: 'y', summary: 'Y.', module: '@acme/tasks/y' }],
        autoload: { mode: 'all' },
        env: [{ name: 'TASKS_URL', kind: 'url' }],
      };
      for (const [field, value] of Object.entries(npmOnly)) {
        assert.deepEqual(
          codes({ ...bundleManifest(), [field]: value }, 'bundle'),
          ['npm_only_field'],
          field,
        );
        assert.equal(
          checkPluginManifest({ ...packageManifest(), [field]: value }, 'package').ok,
          true,
          field,
        );
      }
    });

    it('names every npm-only field and still checks the rest of the manifest', () => {
      const result = checkPluginManifest(
        { ...bundleManifest(), commands: 'not a list', env: null, marketplace: false },
        'bundle',
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(
          result.issues.map((found) => [found.path.join('.'), found.code]),
          [
            ['commands', 'npm_only_field'],
            ['env', 'npm_only_field'],
            ['marketplace', 'bundle_requires_marketplace'],
          ],
        );
      }
    });

    it('requires marketplace: true, a file entry, and a schema file', () => {
      assert.deepEqual(codes({ ...bundleManifest(), marketplace: false }, 'bundle'), [
        'bundle_requires_marketplace',
      ]);
      assert.deepEqual(codes({ ...bundleManifest(), entry: '@acme/tasks' }, 'bundle'), [
        'invalid_entry',
      ]);
      assert.deepEqual(
        codes(
          { ...bundleManifest(), permissions: ['data.own'], schema: { tablePrefix: 'acme_' } },
          'bundle',
        ),
        ['schema_file_required'],
      );
      assert.deepEqual(
        codes(
          {
            ...bundleManifest(),
            permissions: ['data.own'],
            schema: { tablePrefix: 'acme_', file: '../models.json' },
          },
          'bundle',
        ),
        ['invalid_path'],
      );
    });
  });

  describe('npm-only fields', () => {
    it('rejects duplicate names and a generated non-secret', () => {
      assert.deepEqual(
        paths({
          ...packageManifest(),
          commands: [
            { name: 'tasks:prune', summary: 'A.', module: '@acme/tasks/a' },
            { name: 'tasks:prune', summary: 'B.', module: '@acme/tasks/b' },
          ],
        }),
        ['commands.1.name'],
      );
      assert.deepEqual(
        codes({ ...packageManifest(), env: [{ name: 'TASKS_URL', kind: 'url', generate: true }] }),
        ['generate_requires_secret'],
      );
      assert.deepEqual(paths({ ...packageManifest(), env: [{ name: 'lower', kind: 'url' }] }), [
        'env.0.name',
      ]);
    });

    it('requires a command module to be a bare specifier', () => {
      assert.deepEqual(
        paths({
          ...packageManifest(),
          commands: [{ name: 'tasks:prune', summary: 'A.', module: './cli.js' }],
        }),
        ['commands.0.module'],
      );
    });
  });

  describe('errors', () => {
    it('throws a value-free PluginManifestError from parsePluginManifest', () => {
      const secret = 'sk_live_do_not_echo_me';
      const raw = {
        ...packageManifest(),
        id: secret,
        version: secret,
        entry: `https://${secret}.test/x.js`,
        permissions: [secret],
        settings: { type: 'object', properties: { a: { type: 'string', default: 5 } } },
        extra: secret,
      };
      assert.throws(
        () => parsePluginManifest(raw, 'package'),
        (error: unknown) => {
          assert.ok(error instanceof PluginManifestError);
          assert.equal(error.code, 'invalid_manifest');
          assert.ok(!error.message.includes(secret));
          assert.ok(!JSON.stringify(error.issues).includes(secret));
          return true;
        },
      );
    });

    it('rejects a non-object without throwing from the check', () => {
      for (const raw of [null, 'x', 1, [], undefined]) {
        assert.equal(checkPluginManifest(raw, 'package').ok, false);
      }
    });
  });
});

describe('semver helpers', () => {
  it('parses a full version into components', () => {
    assert.deepEqual(parseSemver('1.2.3'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    assert.deepEqual(parseSemver('0.10.0-beta.1'), {
      major: 0,
      minor: 10,
      patch: 0,
      prerelease: ['beta', '1'],
    });
    assert.deepEqual(parseSemver('1.2.3+build.7'), {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('rejects malformed versions', () => {
    for (const bad of ['', '1', '1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '1.2.3-']) {
      assert.equal(parseSemver(bad), null, bad);
      assert.equal(isValidSemverVersion(bad), false, bad);
    }
  });

  it('accepts valid versions', () => {
    for (const good of ['0.0.0', '1.2.3', '10.20.30', '1.2.3-beta', '1.2.3-beta.1.2']) {
      assert.equal(isValidSemverVersion(good), true, good);
    }
  });

  it('validates ranges', () => {
    for (const good of ['*', '1.2.x', '^1.2.3', '~1.2', '>=1.0.0 <2.0.0', '1.2.3 - 2.0.0']) {
      assert.equal(isValidSemverRange(good), true, good);
    }
    for (const bad of ['', 'not-a-range', '>=', '1.2.3.4', '>=']) {
      assert.equal(isValidSemverRange(bad), false, bad);
    }
  });

  it('satisfies ranges per node-semver semantics', () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ['1.2.3', '^1.2.0', true],
      ['2.0.0', '^1.2.0', false],
      ['0.2.3', '^0.2.0', true],
      ['0.3.0', '^0.2.0', false],
      ['0.0.3', '^0.0.3', true],
      ['0.0.4', '^0.0.3', false],
      ['1.4.9', '~1.4', true],
      ['1.5.0', '~1.4.0', false],
      ['1.0.0', '~1', true],
      ['2.0.0', '~1', false],
      ['1.2.3', '1.2.x', true],
      ['1.2.3', '*', true],
      ['1.2.3', '1.2.3 - 2.0.0', true],
      ['1.2.3', '>=1.2.3 || <1.0.0', true],
      ['1.2.3', '>=1.0.0 <2.0.0', true],
      ['3.0.0', '>=1.0.0 <2.0.0', false],
      // Prerelease rule: a prerelease only matches a comparator pinning the
      // same [major,minor,patch] tuple AND carrying its own prerelease.
      ['1.2.3-beta', '^1.2.3', false],
      ['1.2.3-beta', '>=1.2.3-beta', true],
      ['3.4.5-alpha.9', '>1.2.3-alpha.3', false],
      ['1.2.3-alpha.7', '>1.2.3-alpha.3', true],
      ['1.2.3', '>1.2.3-alpha.3', true],
      ['1.2.3-beta.1', '~1.2.3-beta', true],
      ['1.2.3', '~1.2.3-beta', true],
      ['1.2.3-beta', '*', false],
      ['1.2.3-beta', '>=1.0.0', false],
      ['1.2.4', '^1.2.3-beta', true],
    ];
    for (const [version, range, expected] of cases) {
      assert.equal(satisfiesRange(version, range), expected, `${version} satisfies ${range}`);
    }
  });

  it('returns false for a bad version or range input', () => {
    assert.equal(satisfiesRange('nope', '^1.0.0'), false);
    assert.equal(satisfiesRange('1.2.3', 'nope'), false);
  });
});
