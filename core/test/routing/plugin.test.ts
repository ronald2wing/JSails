/**
 * Routing plugin tests.
 *
 * The routing plugin is auto-injected by createApplication, so these tests
 * verify the plugin's contract directly and its integration at the application
 * level. File-based route discovery is exercised through the real
 * discoverRoutes (covered by routing.test.ts); the focus here is the
 * service-token plumbing and the boot-order inversion.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { AppConfigError, validateAppConfig } from '../../src/app/config/index.js';
import { definePlugin } from '../../src/extensions/plugin-contract.js';
import { isPluginFactory } from '../../src/plugins/contract/define-plugin.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { checkOptionSchema } from '../../src/plugins/contract/option-schemas.js';
import { routingPlugin } from '../../src/routing/plugin.js';
import { routeManifestToken } from '../../src/routing/token.js';
import type { RouteManifest } from '../../src/routing/routes.js';
import { testPlugin } from '../../src/testing/plugin-harness.js';
import { writeFixture } from '../fixtures/app.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-routing-plugin-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const PAGE_SOURCE = 'export default function Page() { return null; };\n';

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

describe('routingPlugin', () => {
  it('is a plugin factory named routing that provides the manifest token', () => {
    assert.ok(isPluginFactory(routingPlugin));
    assert.equal(routingPlugin.definition.name, 'routing');
    assert.deepEqual(routingPlugin.definition.provides, [routeManifestToken]);
    assert.deepEqual(checkOptionSchema(routingPlugin.definition.options!), []);
  });

  it('sets up inertly and discovers routes under the application root', async () => {
    const dir = join(root, 'plugin-setup');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);
    writeFixture(dir, 'pages/about.js', PAGE_SOURCE);

    const run = await testPlugin(routingPlugin(), { rootDir: dir });
    try {
      assert.deepEqual(run.provided, [routeManifestToken]);
      const manifest = run.services.get(routeManifestToken);
      assert.ok(manifest.byRoute.has('/'));
      assert.ok(manifest.byRoute.has('/about'));
    } finally {
      await run.close();
    }
  });

  it('reads the configured pages directory', async () => {
    const dir = join(root, 'plugin-pages-dir');
    writeFixture(dir, 'views/contact.js', PAGE_SOURCE);

    const run = await testPlugin(routingPlugin({ pagesDir: 'views' }), { rootDir: dir });
    try {
      assert.ok(run.services.get(routeManifestToken).byRoute.has('/contact'));
    } finally {
      await run.close();
    }
  });

  describe('invalid options', () => {
    const SECRET = 'zz-secret-input';
    const cases: readonly { readonly name: string; readonly input: unknown }[] = [
      { name: 'a non-object', input: SECRET },
      { name: 'an unknown option', input: { [SECRET]: true } },
      { name: 'the root, which the host supplies', input: { rootDir: SECRET } },
      { name: 'an empty pages directory', input: { pagesDir: '' } },
      { name: 'a non-string API directory', input: { apiDir: 7 } },
    ];
    for (const { name, input } of cases) {
      it(`refuses ${name} with config.invalid_options, echoing no input`, () => {
        const factory = routingPlugin as unknown as (input: unknown) => unknown;
        assert.throws(
          () => factory(input),
          (error: unknown) => {
            assert.ok(ConfigErrors.is(error, 'invalid_options'));
            assert.equal(
              `${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET),
              false,
            );
            return true;
          },
        );
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: auto-injected default plugin
// ---------------------------------------------------------------------------

describe('createApplication: routing plugin injection', () => {
  it('discovers routes through the auto-injected routing plugin', async () => {
    const dir = join(root, 'injection');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);
    writeFixture(dir, 'pages/about.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    // extensions is empty — only the auto-injected routing plugin runs.
    const app = await createApplication(config);

    const manifest = app.manifest;
    assert.ok(manifest.byRoute.has('/'));
    assert.ok(manifest.byRoute.has('/about'));
    assert.equal(manifest.entries.length, 2);

    await app.close();
  });

  it('keeps working with config.extensions alongside the auto-injected plugin', async () => {
    const dir = join(root, 'with-extensions');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const events: string[] = [];
    const config = makeConfig(dir, {
      extensions: [
        {
          name: 'test-ext',
          setup() {
            events.push('test-ext');
            return () => events.push('test-ext-dispose');
          },
        },
      ],
    });

    const app = await createApplication(config);

    assert.ok(app.manifest.byRoute.has('/'));
    assert.deepEqual(events, ['test-ext']);

    await app.close();
    assert.deepEqual(events, ['test-ext', 'test-ext-dispose']);
  });

  it('an extension can read the manifest from the registry during its setup', async () => {
    const dir = join(root, 'consume-manifest');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    let consumedManifest: RouteManifest | undefined;
    const config = makeConfig(dir, {
      extensions: [
        definePlugin({
          name: 'consumer',
          requires: [routeManifestToken],
          setup({ services }) {
            consumedManifest = services.get(routeManifestToken);
          },
        }),
      ],
    });

    const app = await createApplication(config);

    assert.ok(consumedManifest !== undefined, 'extension should read the manifest');
    assert.ok(consumedManifest.byRoute.has('/'));
    assert.equal(consumedManifest, app.manifest);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Health-route collision
// ---------------------------------------------------------------------------

describe('createApplication: health-path collision', () => {
  it('rejects a health path that collides with a discovered route, naming the file', async () => {
    const dir = join(root, 'health-collision');
    writeFixture(dir, 'pages/health.js', PAGE_SOURCE);

    await assert.rejects(
      createApplication(makeConfig(dir, { healthPath: '/health' })),
      (error: unknown) => {
        assert.ok(error instanceof AppConfigError);
        assert.match(error.message, /collides with the page route "\/health"/);
        assert.match(error.message, /health\.js/);
        return true;
      },
    );
  });

  it('allows a health path that does not collide', async () => {
    const dir = join(root, 'health-ok');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const app = await createApplication(makeConfig(dir, { healthPath: '/up' }));
    assert.ok(app.manifest.byRoute.has('/'));
    await app.close();
  });

  it('allows a disabled health path', async () => {
    const dir = join(root, 'health-disabled');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const app = await createApplication(makeConfig(dir, { healthPath: false }));
    assert.ok(app.manifest.byRoute.has('/'));
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: config.extensions-only apps
// ---------------------------------------------------------------------------

describe('createApplication: backward compatibility', () => {
  it('an app with only config.extensions still discovers routes', async () => {
    const dir = join(root, 'backcompat');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);
    writeFixture(dir, 'pages/blog/[id].js', PAGE_SOURCE);

    const events: string[] = [];
    const config = makeConfig(dir, {
      extensions: [
        {
          name: 'greeter',
          setup() {
            events.push('greeter');
            return () => events.push('greeter-dispose');
          },
        },
      ],
    });

    const app = await createApplication(config);

    assert.ok(app.manifest.byRoute.has('/'));
    assert.ok(app.manifest.byRoute.has('/blog/:id'));
    assert.deepEqual(events, ['greeter']);

    await app.close();
    assert.deepEqual(events, ['greeter', 'greeter-dispose']);
  });

  it('an app with neither plugins.use nor extensions still boots and discovers routes', async () => {
    const dir = join(root, 'no-extensions');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    const app = await createApplication(config);

    assert.ok(app.manifest.byRoute.has('/'));
    await app.close();
  });
});
