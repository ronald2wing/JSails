/**
 * Browser navigations get an HTML not-found/error page with the right status;
 * API paths and non-HTML clients keep the JSON envelope.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import {
  builtInErrorPage,
  createApiPathMatcher,
  prefersHtml,
} from '../../src/server/error-pages.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'error-pages-'));
after(() => rmSync(root, { recursive: true, force: true }));

writeFixture(
  root,
  'pages/broken.mjs',
  `export default () => { throw new Error('render secret'); };\n`,
);
writeFixture(root, 'api/ok.mjs', `export const GET = () => Response.json({ ok: true });\n`);
const manifest = discoverRoutes(root);

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const quiet = (): void => undefined;

describe('HTML error pages', () => {
  it('serves an HTML 404 to a browser navigation', async () => {
    const app = await createApp({ manifest, onError: quiet });
    const res = await app.fetch(
      new Request('http://localhost/missing', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /404 Not Found/);
  });

  it('keeps the JSON envelope for API paths and non-HTML clients', async () => {
    const app = await createApp({ manifest, onError: quiet });
    const api = await app.fetch(
      new Request('http://localhost/api/missing', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(api.status, 404);
    assert.match(api.headers.get('content-type') ?? '', /application\/json/);

    const fetchDefault = await app.fetch(
      new Request('http://localhost/missing', { headers: { accept: '*/*' } }),
    );
    assert.match(fetchDefault.headers.get('content-type') ?? '', /application\/json/);
  });

  it('serves an HTML 500 for a failing page render without leaking the error', async () => {
    const app = await createApp({ manifest, renderer: preactPageRenderer, onError: quiet });
    const res = await app.fetch(
      new Request('http://localhost/broken', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(res.status, 500);
    const html = await res.text();
    assert.match(html, /500 Internal Server Error/);
    assert.doesNotMatch(html, /render secret/);
  });

  it('uses the app errorPage renderer, falling back to the built-in page when it throws', async () => {
    const app = await createApp({
      manifest,
      onError: quiet,
      errorPage: (error, context) => `<p>custom ${error.status} ${context.url.pathname}</p>`,
    });
    const res = await app.fetch(
      new Request('http://localhost/gone', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(res.status, 404);
    assert.equal(await res.text(), '<p>custom 404 /gone</p>');

    const failing = await createApp({
      manifest,
      onError: quiet,
      errorPage: () => {
        throw new Error('renderer broke');
      },
    });
    const fallback = await failing.fetch(
      new Request('http://localhost/gone', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(fallback.status, 404);
    assert.match(await fallback.text(), /404 Not Found/);
  });

  it('serves an HTML 405 (keeping Allow) to a browser on a page path, JSON on an API path', async () => {
    const app = await createApp({ manifest, renderer: preactPageRenderer, onError: quiet });
    const page = await app.fetch(
      new Request('http://localhost/broken', {
        method: 'DELETE',
        headers: { accept: BROWSER_ACCEPT },
      }),
    );
    assert.equal(page.status, 405);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('allow') ?? '', /GET/);
    assert.match(await page.text(), /405 Method Not Allowed/);

    const api = await app.fetch(
      new Request('http://localhost/api/ok', {
        method: 'DELETE',
        headers: { accept: BROWSER_ACCEPT },
      }),
    );
    assert.equal(api.status, 405);
    assert.match(api.headers.get('content-type') ?? '', /application\/json/);
    assert.match(api.headers.get('allow') ?? '', /GET/);
  });

  it('serves an HTML 413 to a browser on a page path, JSON on an API path', async () => {
    const app = await createApp({
      manifest,
      renderer: preactPageRenderer,
      onError: quiet,
      maxBodyBytes: 8,
    });
    const oversized = (path: string): Request =>
      new Request(`http://localhost${path}`, {
        method: 'POST',
        body: 'x'.repeat(64),
        headers: { accept: BROWSER_ACCEPT, 'content-length': '64' },
      });
    const page = await app.fetch(oversized('/broken'));
    assert.equal(page.status, 413);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /413 Payload Too Large/);

    const api = await app.fetch(oversized('/api/ok'));
    assert.equal(api.status, 413);
    assert.match(api.headers.get('content-type') ?? '', /application\/json/);
  });

  it('escapes the message it shows', () => {
    assert.match(builtInErrorPage({ status: 403, message: '<script>' }), /&lt;script&gt;/);
  });

  it('treats locale-prefixed and framework paths as API paths', () => {
    const isApi = createApiPathMatcher(['/api/posts'], ['fr']);
    assert.equal(isApi('/api/posts'), true);
    assert.equal(isApi('/fr/api/posts'), true);
    assert.equal(isApi('/_jsails/component'), true);
    assert.equal(isApi('/about'), false);
    const html = new Request('http://x/about', {
      headers: { accept: 'application/json, text/html;q=0.5' },
    });
    assert.equal(prefersHtml(html, isApi), false);
  });
});
