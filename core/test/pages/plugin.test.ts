/**
 * Pages plugin tests.
 *
 * The pages plugin is auto-injected by createApplication, so these tests
 * verify the plugin's contract directly and its integration at the application
 * level. Page rendering and static-export behavior is exercised through the
 * real preactPageRenderer and generateStaticSite (covered by pages/ tests);
 * the focus here is the service-token plumbing and the default-override seam.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createApplication } from '../../src/app/application.js';
import { validateAppConfig } from '../../src/app/config/index.js';
import type { PluginContext } from '../../src/extensions/index.js';
import { ConfigErrors } from '../../src/plugins/contract/errors.js';
import { isPluginFactory } from '../../src/plugins/contract/define-plugin.js';
import { testPlugin } from '../../src/testing/plugin-harness.js';
import type { PageOutcome, PageRenderer } from '../../src/contracts/render.js';
import type { RouteManifestEntry } from '../../src/routing/routes.js';
import { pagesPlugin, pageRendererToken, staticSiteToken } from '../../src/pages/plugin.js';
import { writeFixture } from '../fixtures/app.js';
import { documentOutcome } from '../../src/pages/page.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-pages-plugin-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

// A minimal page that returns a plain string — no Preact import needed because
// the default renderer handles strings/promises/text through renderToString.
// The Preact runtime (h/Fragment) is called by the renderer, not by the page.
const PAGE_SOURCE = "export default function Page() { return 'hello-from-default-renderer'; }\n";

function makeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  return validateAppConfig({ rootDir: dir, port: 0, ...overrides }, { cwd: dir });
}

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

describe('pagesPlugin', () => {
  it('is a plugin factory named pages that takes no options', () => {
    assert.ok(isPluginFactory(pagesPlugin));
    assert.equal(pagesPlugin.definition.name, 'pages');
    assert.equal(pagesPlugin.definition.options, undefined);
    assert.deepEqual(pagesPlugin.definition.provides, [pageRendererToken, staticSiteToken]);
    assert.equal(pagesPlugin().name, 'pages');
  });

  it('sets up inertly and provides the renderer and the static-site generator', async () => {
    const run = await testPlugin(pagesPlugin());
    try {
      assert.deepEqual(run.provided, [pageRendererToken, staticSiteToken]);
      assert.equal(typeof run.services.get(pageRendererToken).render, 'function');
      assert.equal(typeof run.services.get(staticSiteToken), 'function');
    } finally {
      await run.close();
    }
  });

  it('refuses any option with config.invalid_options, echoing no input', () => {
    const factory = pagesPlugin as unknown as (input: unknown) => unknown;
    for (const input of ['zz-secret-input', { 'zz-secret-input': true }]) {
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          assert.equal(
            `${String(error)}${JSON.stringify(error.payload)}`.includes('zz-secret-input'),
            false,
          );
          return true;
        },
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: default renderer (no config.renderer)
// ---------------------------------------------------------------------------

describe('createApplication: default renderer auto-injection', () => {
  it('renders a page with the default Preact renderer when config.renderer is absent', async () => {
    const dir = join(root, 'default-renderer-fetch');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    // No renderer in config — the auto-injected pages plugin provides it.
    const config = makeConfig(dir);
    const app = await createApplication(config);

    const response = await app.fetch(new Request('http://localhost/'));

    assert.equal(response.status, 200);
    const html = await response.text();
    // The Preact renderer emits the page wrapped in a minimal document shell.
    assert.match(html, /hello-from-default-renderer/);
    assert.match(html, /<!DOCTYPE html/);

    await app.close();
  });

  it('static-exports pages with the default renderer when config.renderer is absent', async () => {
    const dir = join(root, 'default-renderer-build');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    const app = await createApplication(config);
    const result = await app.build();

    assert.deepEqual(result.written, [join(dir, 'out', 'index.html')]);
    assert.deepEqual(result.skipped, []);

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /hello-from-default-renderer/);
    assert.match(html, /<!DOCTYPE html/);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: config.renderer overrides the default
// ---------------------------------------------------------------------------

describe('createApplication: config.renderer override', () => {
  it('uses config.renderer instead of the default when one is set', async () => {
    const dir = join(root, 'override-renderer');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const calls: Array<{ route: string }> = [];
    const customRenderer: PageRenderer = {
      render(entry: RouteManifestEntry): PageOutcome {
        calls.push({ route: entry.route });
        return documentOutcome('<html><body><p>custom-renderer-output</p></body></html>');
      },
    };

    const config = makeConfig(dir, { renderer: customRenderer });
    const app = await createApplication(config);

    const response = await app.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /custom-renderer-output/);
    // The default renderer's <h1> must not appear.
    assert.equal(html.includes('hello-from-default-renderer'), false);

    assert.deepEqual(calls, [{ route: '/' }]);

    await app.close();
  });

  it('config.renderer also overrides the static-export renderer', async () => {
    const dir = join(root, 'override-build');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const customRenderer: PageRenderer = {
      render(entry: RouteManifestEntry): PageOutcome {
        return documentOutcome(`<html><body><p>custom-static-${entry.route}</p></body></html>`);
      },
    };

    const config = makeConfig(dir, { renderer: customRenderer });
    const app = await createApplication(config);
    await app.build();

    const html = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(html, /custom-static-\//);
    assert.equal(html.includes('hello-from-default-renderer'), false);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: config.extensions-only apps
// ---------------------------------------------------------------------------

describe('createApplication: backward compatibility', () => {
  it('an app with only config.extensions still renders pages with the default renderer', async () => {
    const dir = join(root, 'extensions-only-render');
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

    const response = await app.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /hello-from-default-renderer/);

    assert.deepEqual(events, ['test-ext']);

    await app.close();
    assert.deepEqual(events, ['test-ext', 'test-ext-dispose']);
  });

  it('an app with neither plugins.use nor extensions still renders + static-exports', async () => {
    const dir = join(root, 'no-extensions-render');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    const config = makeConfig(dir);
    const app = await createApplication(config);

    // Fetch a page through the default renderer.
    const response = await app.fetch(new Request('http://localhost/'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /hello-from-default-renderer/);

    // Static-export.
    const result = await app.build();
    assert.equal(result.written.length, 1);
    const fileHtml = readFileSync(join(dir, 'out', 'index.html'), 'utf8');
    assert.match(fileHtml, /hello-from-default-renderer/);

    await app.close();
  });

  it('an extension can consume the page renderer from the registry during its setup', async () => {
    const dir = join(root, 'consume-renderer');
    writeFixture(dir, 'pages/index.js', PAGE_SOURCE);

    let consumedRenderer: PageRenderer | undefined;
    const config = makeConfig(dir, {
      extensions: [
        {
          name: 'consumer',
          requires: [pageRendererToken],
          setup({ services }: PluginContext) {
            consumedRenderer = services.get(pageRendererToken);
          },
        },
      ],
    });

    const app = await createApplication(config);

    assert.ok(consumedRenderer !== undefined, 'extension should read the page renderer');
    assert.equal(typeof consumedRenderer.render, 'function');

    await app.close();
  });
});
