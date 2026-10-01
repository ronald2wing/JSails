/**
 * Tests for the page routes: GET render, `handleGet` short-circuit, POST
 * origin gating and `handlePost` delegation, the 404 catch-all, the
 * grouped and sorted dashboard navigation, and the theme, theme customization,
 * and client scripts threaded from the panel into page contexts and the
 * framework-owned documents.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import { postForm, type TestApplication } from 'jsails/testing';

import {
  adminHtmlResponse,
  type AdminErrorContext,
  type AdminErrorHandler,
  DEFAULT_ADMIN_PATH,
  DEFAULT_ADMIN_TITLE,
  defineAdminPage,
  type AdminTheme,
  type AdminThemeCustomization,
} from '../../src/index.js';
import { DEFAULT_ADMIN_THEME } from '../../src/panel.js';
import { allowAll, createAdminTestApp } from '../fixtures.js';

interface PanelOptions {
  readonly path?: string;
  readonly title?: string;
  readonly theme?: AdminTheme;
  readonly themeCustomization?: AdminThemeCustomization;
  readonly resolveSession?: (request: Request) => Session | null | Promise<Session | null>;
  readonly authorize?: (session: Session | null) => boolean | Promise<boolean>;
  readonly pages?: Parameters<typeof defineAdminPage>[0][];
  readonly clientScripts?: readonly string[];
  readonly onError?: AdminErrorHandler;
}

/**
 * A panel app whose `pages` are plain specs, defined here. A spec without its
 * own `authorize` gets an explicit allow, since pages are default-deny.
 */
function createPagesApp(options: PanelOptions = {}): Promise<TestApplication> {
  const { pages, ...rest } = options;
  return createAdminTestApp({
    ...rest,
    ...(pages === undefined
      ? {}
      : { pages: pages.map((page) => defineAdminPage({ authorize: allowAll, ...page })) }),
  });
}

describe('admin page routes', () => {
  it('serves a page without its own authorize to no one and hides its link', async () => {
    const app = await createAdminTestApp({
      pages: [defineAdminPage({ slug: 'settings', label: 'Settings', render: () => 'secret' })],
    });
    const get = await app.request(`${DEFAULT_ADMIN_PATH}/settings`);
    assert.equal(get.status, 403);
    assert.doesNotMatch(await get.text(), /secret/);
    const dashboard = await app.request(DEFAULT_ADMIN_PATH);
    assert.doesNotMatch(await dashboard.text(), /settings/);
    await app.close();
  });

  it('renders a page for an authorized request', async () => {
    const app = await createPagesApp({
      title: 'My Admin',
      pages: [{ slug: 'settings', label: 'Settings', render: () => '<h1>Settings page</h1>' }],
    });
    const response = await app.request(`${DEFAULT_ADMIN_PATH}/settings`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /Settings page/);
    await app.close();
  });

  it('serves the dashboard for an authorized request', async () => {
    const app = await createPagesApp({ title: 'My Admin' });
    const response = await app.request(DEFAULT_ADMIN_PATH);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const body = await response.text();
    assert.match(body, /My Admin/);
    await app.close();
  });

  it('uses the default title when none is supplied', async () => {
    const app = await createPagesApp();
    const response = await app.request(DEFAULT_ADMIN_PATH);
    const body = await response.text();
    assert.match(body, new RegExp(DEFAULT_ADMIN_TITLE));
    await app.close();
  });

  it('returns a 404 for an authorized unknown path', async () => {
    const app = await createPagesApp();
    const response = await app.request(`${DEFAULT_ADMIN_PATH}/does-not-exist`);
    assert.equal(response.status, 404);
    await app.close();
  });

  it('rejects a POST to a page without a handlePost with 405', async () => {
    const app = await createPagesApp({
      pages: [{ slug: 'settings', label: 'Settings', render: () => 'x' }],
    });
    const response = await postForm(app, `${DEFAULT_ADMIN_PATH}/settings`, {});
    assert.equal(response.status, 405);
    await app.close();
  });

  it('rejects a cross-site page POST', async () => {
    const app = await createPagesApp({
      pages: [
        {
          slug: 'settings',
          label: 'Settings',
          render: () => 'x',
          handlePost: () => adminHtmlResponse('ok'),
        },
      ],
    });

    const noOrigin = await app.request(`${DEFAULT_ADMIN_PATH}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    assert.equal(noOrigin.status, 403);

    const foreign = await postForm(
      app,
      `${DEFAULT_ADMIN_PATH}/settings`,
      {},
      { origin: 'https://evil.example' },
    );
    assert.equal(foreign.status, 403);

    await app.close();
  });

  it('delegates a page POST to handlePost with the parsed body', async () => {
    const app = await createPagesApp({
      pages: [
        {
          slug: 'echo',
          label: 'Echo',
          render: () => 'x',
          handlePost: (context) => adminHtmlResponse(`<p>got ${context.body['name'] ?? ''}</p>`),
        },
      ],
    });

    const response = await postForm(app, `${DEFAULT_ADMIN_PATH}/echo`, {
      name: 'world',
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /got world/);

    await app.close();
  });

  it("reads a page POST up to the page's own form cap and answers 413 past it", async () => {
    const MiB = 1024 * 1024;
    const sizes: number[] = [];
    const page = (slug: string, maxBodyBytes?: number): Parameters<typeof defineAdminPage>[0] => ({
      slug,
      label: slug,
      render: () => 'x',
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      handlePost: (context) => {
        sizes.push(context.files?.get('file')?.size ?? 0);
        return adminHtmlResponse('ok');
      },
    });
    const app = await createPagesApp({ pages: [page('small'), page('upload', 4 * MiB)] });
    const post = (slug: string) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(2 * MiB)], 'a.bin'));
      return app.request(`${DEFAULT_ADMIN_PATH}/${slug}`, {
        method: 'POST',
        headers: { origin: app.origin },
        body: form,
      });
    };

    assert.equal((await post('upload')).status, 200);
    assert.equal((await post('small')).status, 413);
    assert.deepEqual(sizes, [2 * MiB]);

    await app.close();
  });

  it('mounts under a custom path and leaves the default unmatched', async () => {
    const app = await createPagesApp({ path: '/panel' });
    assert.equal((await app.request('/panel')).status, 200);
    assert.equal((await app.request(DEFAULT_ADMIN_PATH)).status, 404);
    await app.close();
  });
});

describe('admin page handleGet', () => {
  it('returns a handleGet Response unchanged, bypassing render', async () => {
    let rendered = false;
    const app = await createPagesApp({
      pages: [
        {
          slug: 'bytes',
          label: 'Bytes',
          render: () => {
            rendered = true;
            return '<h1>should not render</h1>';
          },
          handleGet: () =>
            new Response('streamed', {
              status: 206,
              headers: {
                'content-type': 'application/octet-stream',
                'content-disposition': 'attachment; filename="a.bin"',
                'x-custom': 'kept',
              },
            }),
        },
      ],
    });

    const response = await app.request(`${DEFAULT_ADMIN_PATH}/bytes`);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="a.bin"');
    assert.equal(response.headers.get('x-custom'), 'kept');
    assert.equal(await response.text(), 'streamed');
    assert.equal(rendered, false, 'render must not run when handleGet returns a Response');

    await app.close();
  });

  it('falls through to render when handleGet returns undefined', async () => {
    const app = await createPagesApp({
      pages: [
        {
          slug: 'mixed',
          label: 'Mixed',
          render: () => '<h1>rendered</h1>',
          handleGet: () => undefined,
        },
      ],
    });

    const response = await app.request(`${DEFAULT_ADMIN_PATH}/mixed`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /rendered/);

    await app.close();
  });

  it('maps a throwing handleGet to the value-free 500', async () => {
    const app = await createPagesApp({
      pages: [
        {
          slug: 'boom',
          label: 'Boom',
          render: () => 'x',
          handleGet: () => {
            throw new Error('detail must not leak');
          },
        },
      ],
    });

    const response = await app.request(`${DEFAULT_ADMIN_PATH}/boom`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /detail must not leak/);

    await app.close();
  });

  it('reports a throwing render through onError without leaking it', async () => {
    const reports: Array<{ error: unknown; context: AdminErrorContext }> = [];
    const app = await createPagesApp({
      onError: (error, context) => {
        reports.push({ error, context });
      },
      pages: [
        {
          slug: 'broken',
          label: 'Broken',
          render: () => {
            throw new Error('database down');
          },
        },
      ],
    });

    const response = await app.request(`${DEFAULT_ADMIN_PATH}/broken`);
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /database down/);
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0]!.context, { surface: 'page', slug: 'broken', operation: 'render' });
    assert.equal((reports[0]!.error as Error).message, 'database down');

    await app.close();
  });

  it('enforces a per-page authorize on GET and POST and hides the link', async () => {
    let posts = 0;
    const app = await createPagesApp({
      pages: [
        { slug: 'open', label: 'Open page', render: () => 'open' },
        {
          slug: 'secret',
          label: 'Secret page',
          authorize: ({ slug }) => slug !== 'secret',
          render: () => 'secret',
          handlePost: () => {
            posts += 1;
            return adminHtmlResponse('ok');
          },
        },
      ],
    });

    assert.equal((await app.request(`${DEFAULT_ADMIN_PATH}/secret`)).status, 403);
    const post = await postForm(app, `${DEFAULT_ADMIN_PATH}/secret`, {});
    assert.equal(post.status, 403);
    assert.equal(posts, 0);
    const dashboard = await (await app.request(DEFAULT_ADMIN_PATH)).text();
    assert.match(dashboard, /Open page/);
    assert.doesNotMatch(dashboard, /Secret page/);

    await app.close();
  });

  it('still denies an unauthorized handleGet request', async () => {
    const app = await createPagesApp({
      authorize: () => false,
      pages: [
        {
          slug: 'bytes',
          label: 'Bytes',
          render: () => 'x',
          handleGet: () => new Response('streamed'),
        },
      ],
    });

    const response = await app.request(`${DEFAULT_ADMIN_PATH}/bytes`);
    assert.equal(response.status, 403);

    await app.close();
  });
});

describe('admin navigation', () => {
  it('renders grouped, sorted navigation with badges', async () => {
    const app = await createPagesApp({
      title: 'My Admin',
      pages: [
        { slug: 'overview', label: 'Overview', sort: 10, render: () => 'overview' },
        { slug: 'users', label: 'Users', group: 'Configuration', sort: 5, render: () => 'users' },
        {
          slug: 'settings',
          label: 'Settings',
          group: 'Configuration',
          sort: 0,
          render: () => 'settings',
        },
        { slug: 'badges', label: 'Badges', badge: 'NEW', render: () => 'badges' },
      ],
    });

    const response = await app.request(DEFAULT_ADMIN_PATH);
    const body = await response.text();

    assert.match(body, /<h2>Configuration<\/h2>/);
    assert.match(body, /NEW/);
    // Within a group, entries sort by weight then label.
    assert.ok(body.indexOf('Settings') < body.indexOf('Users'), 'Settings before Users');
    assert.ok(body.indexOf('Badges') < body.indexOf('Overview'), 'Badges before Overview');
    assert.ok(body.indexOf('Overview') < body.indexOf('Configuration'), 'top-level before groups');

    await app.close();
  });
});

describe('admin page theme', () => {
  it('sets the requested data-theme on the dashboard document', async () => {
    const app = await createPagesApp({ theme: 'dark' });
    const body = await (await app.request(DEFAULT_ADMIN_PATH)).text();
    assert.match(body, /<html[^>]*data-theme="dark"/);
    assert.match(body, /--jsails-bg/);
    await app.close();
  });

  it('defaults the theme to system when omitted', async () => {
    const app = await createPagesApp();
    const body = await (await app.request(DEFAULT_ADMIN_PATH)).text();
    assert.match(body, new RegExp(`data-theme="${DEFAULT_ADMIN_THEME}"`));
    await app.close();
  });

  it('threads the theme into a page render context and the 404 catch-all', async () => {
    let capturedTheme: AdminTheme | undefined;
    const app = await createPagesApp({
      theme: 'light',
      pages: [
        {
          slug: 'settings',
          label: 'Settings',
          render: (context) => {
            capturedTheme = context.theme;
            return '<h1>Settings</h1>';
          },
        },
      ],
    });

    // A page receives the resolved theme on its render context (the page owns
    // its own document shell; the framework does not wrap arbitrary page HTML).
    const page = await (await app.request(`${DEFAULT_ADMIN_PATH}/settings`)).text();
    assert.match(page, /Settings/);
    assert.equal(capturedTheme, 'light');

    // The framework-owned 404 catch-all is themed.
    const missing = await (await app.request(`${DEFAULT_ADMIN_PATH}/nope`)).text();
    assert.match(missing, /<html[^>]*data-theme="light"/);

    await app.close();
  });

  it('threads themeCustomization into the page render context', async () => {
    let capturedCustom: AdminThemeCustomization | undefined;
    const app = await createPagesApp({
      themeCustomization: { css: 'body { color: red; }' },
      pages: [
        {
          slug: 'test',
          label: 'Test',
          render: (ctx) => {
            capturedCustom = ctx.themeCustomization;
            return '<p>ok</p>';
          },
        },
      ],
    });
    await app.request('/admin/test');
    assert.ok(capturedCustom !== undefined);
    assert.equal(capturedCustom.css, 'body { color: red; }');
    await app.close();
  });

  it('renders panel clientScripts into the dashboard document', async () => {
    const app = await createPagesApp({ clientScripts: ['/app.js'] });
    const body = await (await app.request(DEFAULT_ADMIN_PATH)).text();
    assert.match(body, /<script type="module" src="\/app.js"><\/script>/);
    await app.close();
  });
});
