/**
 * Tests for the page routes: GET render, `handleGet` short-circuit, POST
 * origin/CSRF gating and `handlePost` delegation, the 404 catch-all, the
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
  DEFAULT_ADMIN_PATH,
  DEFAULT_ADMIN_TITLE,
  defineAdminPage,
  type AdminTheme,
  type AdminThemeCustomization,
} from '../../src/index.js';
import { DEFAULT_ADMIN_THEME } from '../../src/panel.js';
import { createAdminTestApp, SESSION } from '../fixtures.js';

interface PanelOptions {
  readonly path?: string;
  readonly title?: string;
  readonly theme?: AdminTheme;
  readonly themeCustomization?: AdminThemeCustomization;
  readonly resolveSession?: (request: Request) => Session | null | Promise<Session | null>;
  readonly authorize?: (session: Session | null) => boolean | Promise<boolean>;
  readonly pages?: Parameters<typeof defineAdminPage>[0][];
  readonly clientScripts?: readonly string[];
}

/** A panel app whose `pages` are plain specs, defined here. */
function createPagesApp(options: PanelOptions = {}): Promise<TestApplication> {
  const { pages, ...rest } = options;
  return createAdminTestApp({
    ...rest,
    ...(pages === undefined ? {} : { pages: pages.map(defineAdminPage) }),
  });
}

describe('admin page routes', () => {
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
    const response = await postForm(app, `${DEFAULT_ADMIN_PATH}/settings`, {
      _csrf: SESSION.csrfToken,
    });
    assert.equal(response.status, 405);
    await app.close();
  });

  it('rejects a page POST without a same-origin Origin or a valid CSRF token', async () => {
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
      body: new URLSearchParams({ _csrf: SESSION.csrfToken }).toString(),
    });
    assert.equal(noOrigin.status, 403);

    const badCsrf = await postForm(app, `${DEFAULT_ADMIN_PATH}/settings`, {
      _csrf: 'wrong-token',
    });
    assert.equal(badCsrf.status, 403);

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
      _csrf: SESSION.csrfToken,
      name: 'world',
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /got world/);

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
