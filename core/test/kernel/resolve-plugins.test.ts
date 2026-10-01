/**
 * Tests for `resolvePlugins`: the graph's order and origins, the validation
 * that runs before any setup, safe mode, the static export, the schema
 * authority, and the locked-mode proof.
 *
 * The proof: a valid bundle on disk where the old installer put it, and
 * managed-looking variables in the process environment, never reach the
 * graph of a locked app, nor of a managed one (no plugin source exists yet);
 * the bundle's module is never evaluated, and a config cannot even name a
 * plugin state source (`config.removed_option`).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { validateAppConfig, type JsailsAppConfig } from '../../src/app/config/index.js';
import { definePlugin as defineExtension } from '../../src/extensions/plugin-contract.js';
import { createServiceToken } from '../../src/extensions/services.js';
import { isSchemaAuthority } from '../../src/kernel/activation/schema-authority.js';
import { createLoadedApp } from '../../src/kernel/load-app.js';
import { activationModeOf, resolvePlugins } from '../../src/kernel/resolve-plugins.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { bundleManifestJson } from '../plugins/manifest-fixture.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-resolve-plugins-'));
after(() => rmSync(root, { recursive: true, force: true }));

let sequence = 0;

function caseDir(): string {
  return mkdtempSync(join(root, `case-${sequence++}-`));
}

function app(dir: string, config: JsailsAppConfig = {}) {
  return createLoadedApp({ rootDir: dir, port: 0, ...config }, { cwd: dir });
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The global a bundle sets when its module is evaluated. */
function importedKey(id: string): string {
  return `__jsailsBundleImported:${id}`;
}

/** Install a valid bundle `<id>@1.0.0` under the default plugins folder. */
function installBundle(dir: string, id: string): void {
  const versionDir = join(dir, 'storage', 'plugins', id, '1.0.0');
  writeFile(
    join(versionDir, 'manifest.json'),
    `${JSON.stringify(
      bundleManifestJson({ id, version: '1.0.0', jsailsCompat: '^0.1.0', entry: './index.mjs' }),
    )}\n`,
  );
  writeFile(
    join(versionDir, 'index.mjs'),
    `globalThis[${JSON.stringify(importedKey(id))}] = true;\nexport default { name: ${JSON.stringify(id)}, setup() {} };\n`,
  );
}

const alpha = createServiceToken<string>('alpha');
const beta = createServiceToken<string>('beta');

describe('resolvePlugins: order and origins', () => {
  it('orders framework plugins, plugins.use and extensions, and names each origin', async () => {
    const dir = caseDir();
    const used = definePlugin({ name: 'used', setup() {} })();
    const graph = await resolvePlugins(
      app(dir, {
        plugins: { use: [used] },
        extensions: [{ name: 'legacy', setup() {} }],
        i18n: { locale: 'en' },
      }),
    );
    assert.deepEqual(
      graph.nodes.map((node) => [node.name, node.origin]),
      [
        ['routing', 'framework'],
        ['pages', 'framework'],
        ['i18n', 'framework'],
        ['used', 'config'],
        ['legacy', 'extension'],
      ],
    );
    assert.deepEqual(graph.roles, ['web', 'worker']);
    assert.equal(graph.mode, 'locked');
    assert.equal(graph.schemaAuthority, undefined);
    assert.equal(Object.isFrozen(graph), true);
  });

  it('puts entries in setup order: providers first, declared order breaking ties', async () => {
    const dir = caseDir();
    const consumer = definePlugin({ name: 'consumer', requires: [alpha], setup() {} })();
    const reader = definePlugin({ name: 'reader', optional: [beta], setup() {} })();
    const bystander = definePlugin({ name: 'bystander', setup() {} })();
    const provider = definePlugin({ name: 'provider', provides: [alpha], setup() {} })();
    const second = definePlugin({
      name: 'second',
      provides: [beta],
      requires: [alpha],
      setup() {},
    })();
    const graph = await resolvePlugins(
      app(dir, { plugins: { use: [consumer, reader, bystander, provider, second] } }),
    );
    assert.deepEqual(
      graph.nodes.map((node) => node.name),
      ['routing', 'pages', 'bystander', 'provider', 'consumer', 'second', 'reader'],
    );
    assert.deepEqual(
      graph.entries.map((entry) => entry.name),
      graph.nodes.map((node) => node.name),
    );
    assert.equal(graph.nodes.find((node) => node.name === 'provider')?.origin, 'config');
  });

  it('takes a bare resolved config as a locked app', async () => {
    const dir = caseDir();
    const graph = await resolvePlugins(validateAppConfig({ rootDir: dir }, { cwd: dir }));
    assert.equal(graph.mode, 'locked');
  });
});

describe('resolvePlugins: live-only plugins', () => {
  const live = createServiceToken<object>('resolve.live', { live: true });

  function liveApp(dir: string, shape: 'static' | 'full') {
    const provider = definePlugin({ name: 'live-provider', provides: [live], setup() {} })();
    const dependent = definePlugin({ name: 'dependent', requires: [live], setup() {} })();
    const site = definePlugin({ name: 'site', setup() {} })();
    return app(dir, {
      shape,
      plugins: { use: [dependent, site, provider] },
      extensions: [
        defineExtension({
          name: 'live-extension',
          describe: () => ({ needsLive: true }),
          setup() {},
        }),
      ],
    });
  }

  const expected = [
    ['dependent', 'config'],
    ['live-provider', 'config'],
    ['live-extension', 'extension'],
  ];

  it('reports plugins.use instances and extensions alike, and a static export drops them', async () => {
    const graph = await resolvePlugins(liveApp(caseDir(), 'static'));
    assert.deepEqual(
      graph.nodes.map((node) => node.name),
      ['routing', 'pages', 'site'],
    );
    assert.deepEqual(
      graph.liveOnly.map((node) => [node.name, node.origin]),
      expected,
    );
    assert.equal(Object.isFrozen(graph.liveOnly), true);
  });

  it('reports the same set for a live process, which runs them', async () => {
    const graph = await resolvePlugins(liveApp(caseDir(), 'full'));
    assert.deepEqual(
      graph.nodes.map((node) => node.name),
      ['routing', 'pages', 'site', 'live-provider', 'live-extension', 'dependent'],
    );
    assert.deepEqual(
      graph.liveOnly.map((node) => [node.name, node.origin]),
      expected,
    );
  });
});

describe('resolvePlugins: validation before setup', () => {
  const setupRan: string[] = [];
  const plugin = (
    name: string,
    tokens: { requires?: readonly (typeof alpha)[]; provides?: readonly (typeof alpha)[] },
  ) =>
    definePlugin({
      name,
      ...(tokens.requires === undefined ? {} : { requires: tokens.requires }),
      ...(tokens.provides === undefined ? {} : { provides: tokens.provides }),
      setup() {
        setupRan.push(name);
      },
    })();

  const misconfigured = async (use: JsailsAppConfig['plugins'], problem: string, at: string) => {
    await assert.rejects(resolvePlugins(app(caseDir(), { plugins: use })), (error: unknown) => {
      assert.ok(ConfigErrors.is(error, 'misconfigured'), String(error));
      assert.equal(error.context.problem, problem);
      assert.equal(error.context.plugin, at);
      return true;
    });
    assert.deepEqual(setupRan, []);
  };

  it('refuses a requires cycle', async () => {
    await misconfigured(
      {
        use: [
          plugin('left', { requires: [beta], provides: [alpha] }),
          plugin('right', { requires: [alpha], provides: [beta] }),
        ],
      },
      'dependency_cycle',
      'left',
    );
  });

  it('refuses a required service no plugin could provide', async () => {
    await misconfigured(
      { use: [plugin('consumer', { requires: [alpha] })] },
      'unsatisfied_service',
      'consumer',
    );
  });

  it('refuses two providers of one service and two plugins of one name', async () => {
    await misconfigured(
      {
        use: [plugin('first', { provides: [alpha] }), plugin('second', { provides: [alpha] })],
      },
      'duplicate_provider',
      'second',
    );
    await misconfigured(
      { use: [plugin('twin', {}), plugin('twin', {})] },
      'duplicate_name',
      'twin',
    );
  });

  it('accepts a requirement a legacy extension may register at setup', async () => {
    const graph = await resolvePlugins(
      app(caseDir(), {
        plugins: { use: [plugin('consumer', { requires: [alpha] })] },
        extensions: [{ name: 'registers-alpha', setup() {} }],
      }),
    );
    assert.equal(graph.entries.length, 4);
  });

  it('orders a provider before its consumer whatever the declaration order', async () => {
    const dir = caseDir();
    const consumer = definePlugin({
      name: 'consumer',
      requires: [alpha],
      setup({ services }) {
        setupRan.push(`consumer:${services.get(alpha)}`);
      },
    })();
    const provider = definePlugin({
      name: 'provider',
      provides: [alpha],
      setup({ services }) {
        services.provide(alpha, 'ready');
      },
    })();
    const application = await createApplication(
      app(dir, { plugins: { use: [consumer, provider] } }),
    );
    try {
      assert.deepEqual(setupRan, ['consumer:ready']);
    } finally {
      setupRan.length = 0;
      await application.close();
    }
  });
});

describe('resolvePlugins: modes', () => {
  it('mints a schema authority only in managed mode outside safe mode', async () => {
    const dir = caseDir();
    const managed = app(dir, { plugins: { activation: { mode: 'managed' } } });
    const graph = await resolvePlugins(managed);
    assert.equal(activationModeOf(managed), 'managed');
    assert.ok(isSchemaAuthority(graph.schemaAuthority));
    assert.equal((await resolvePlugins(managed, { safeMode: true })).schemaAuthority, undefined);
    assert.equal((await resolvePlugins(app(dir))).schemaAuthority, undefined);
    assert.equal(isSchemaAuthority(Object.freeze(Object.create(null) as object)), false);
  });

  it('proves both modes: no bundle reaches the graph, whatever the environment says', async () => {
    const dir = caseDir();
    installBundle(dir, 'acme');
    const variables = {
      JSAILS_PLUGINS_MODE: 'managed',
      JSAILS_ACTIVATION: 'managed',
      JSAILS_PLUGINS_ACTIVATION: 'managed',
      JSAILS_PLUGINS_MANAGED: '1',
    };
    const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
    Object.assign(process.env, variables);
    try {
      const locked = [app(dir), app(dir, { plugins: { activation: { mode: 'locked' } } })];
      for (const loaded of locked) assert.equal(activationModeOf(loaded), 'locked');
      const managed = app(dir, { plugins: { activation: { mode: 'managed' } } });
      for (const loaded of [...locked, managed]) {
        const graph = await resolvePlugins(loaded);
        assert.deepEqual(
          graph.nodes.map((node) => node.origin),
          ['framework', 'framework'],
          'only the framework plugins run',
        );
        assert.equal(graph.mode === 'managed', isSchemaAuthority(graph.schemaAuthority));
        const application = await createApplication(loaded);
        await application.close();
      }
      assert.equal(
        (globalThis as Record<string, unknown>)[importedKey('acme')],
        undefined,
        'the bundle is never imported',
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('refuses a config that names a plugin state source, in either mode', () => {
    const dir = caseDir();
    const source = { load() {}, save() {}, putEntry() {}, removeEntry() {} };
    for (const activation of [{ mode: 'locked' }, { mode: 'managed' }] as const) {
      assert.throws(
        () => app(dir, { plugins: { activation, stateSource: source } } as JsailsAppConfig),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'removed_option'));
          assert.equal(error.context.option, 'plugins.stateSource');
          return true;
        },
      );
    }
  });

  it('mints no schema authority for a static export, even in managed mode', async () => {
    const dir = caseDir();
    const graph = await resolvePlugins(
      app(dir, { shape: 'static', plugins: { activation: { mode: 'managed' } } }),
    );
    assert.deepEqual(graph.roles, ['export']);
    assert.equal(graph.schemaAuthority, undefined);
  });
});
