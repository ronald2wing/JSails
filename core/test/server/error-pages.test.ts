/**
 * Browser navigations get an HTML not-found/error page with the right status;
 * API paths and non-HTML clients keep the problem envelope.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { HttpError } from '../../src/contracts/http.js';
import { createApp } from '../../src/server/app.js';
import {
  builtInErrorPage,
  createApiPathMatcher,
  prefersHtml,
} from '../../src/server/error-pages.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { MAX_ROUTE_BODY_BYTES } from '../../src/server/route-limits.js';
import { currentRequestFrame } from '../../src/server/request-frame.js';
import { appRoutes, writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'error-pages-'));
after(() => rmSync(root, { recursive: true, force: true }));

writeFixture(
  root,
  'pages/broken.mjs',
  `export default () => { throw new Error('render secret'); };\n`,
);
writeFixture(
  root,
  'api/ok.mjs',
  `export const GET = () => Response.json({ ok: true });\nexport const authorize = () => true;\n`,
);
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

  it('keeps the problem envelope for API paths and non-HTML clients', async () => {
    const app = await createApp({ manifest, onError: quiet });
    const api = await app.fetch(
      new Request('http://localhost/api/missing', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(api.status, 404);
    assert.match(api.headers.get('content-type') ?? '', /application\/problem\+json/);

    const fetchDefault = await app.fetch(
      new Request('http://localhost/missing', { headers: { accept: '*/*' } }),
    );
    assert.match(fetchDefault.headers.get('content-type') ?? '', /application\/problem\+json/);
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

  it('serves an HTML 405 (keeping Allow) to a browser on a page path, the envelope on an API path', async () => {
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
    assert.match(api.headers.get('content-type') ?? '', /application\/problem\+json/);
    assert.match(api.headers.get('allow') ?? '', /GET/);
  });

  it('serves an HTML 413 to a browser on a page path, the envelope on an API path', async () => {
    const app = await createApp({
      manifest,
      renderer: preactPageRenderer,
      onError: quiet,
      maxBodyBytes: 8,
    });
    // A length past the largest route cap is refused before routing, so a
    // page path (which answers no POST) still gets its 413.
    const oversized = (path: string): Request =>
      new Request(`http://localhost${path}`, {
        method: 'POST',
        body: 'x'.repeat(64),
        headers: { accept: BROWSER_ACCEPT, 'content-length': String(MAX_ROUTE_BODY_BYTES + 1) },
      });
    const page = await app.fetch(oversized('/broken'));
    assert.equal(page.status, 413);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /413 Content Too Large/);

    const api = await app.fetch(oversized('/api/ok'));
    assert.equal(api.status, 413);
    assert.match(api.headers.get('content-type') ?? '', /application\/problem\+json/);
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
    assert.equal(prefersHtml(html), false);
  });
});

describe('the anonymous not-found page memo', () => {
  /** An app whose error page counts its renders and reads what `read` names. */
  async function counted(read: 'nothing' | 'request' | 'ambient-nonce' = 'nothing') {
    const renders = { count: 0 };
    const app = await createApp({
      manifest,
      renderer: preactPageRenderer,
      onError: quiet,
      identity: {
        hasCredential: (request) => (request.headers.get('cookie') ?? '').includes('sid='),
        resolve: () => null,
      },
      errorPage: (error, context) => {
        renders.count += 1;
        const extra =
          read === 'request'
            ? (context.request.headers.get('accept') ?? '')
            : read === 'ambient-nonce'
              ? (currentRequestFrame()?.cspNonce ?? '')
              : '';
        return `<p>${error.status} ${context.url.pathname}${extra === '' ? '' : ' seen'}</p>`;
      },
    });
    const send = async (path: string, headers: Record<string, string> = {}, method = 'GET') => {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { accept: BROWSER_ACCEPT, ...headers },
        }),
      );
      return { status: res.status, html: await res.text() };
    };
    return { renders, send };
  }

  it('renders an anonymous 404 once per path and serves the kept page after', async () => {
    const { renders, send } = await counted();
    assert.deepEqual(await send('/gone'), { status: 404, html: '<p>404 /gone</p>' });
    assert.deepEqual(await send('/gone'), { status: 404, html: '<p>404 /gone</p>' });
    assert.equal(renders.count, 1);
    assert.deepEqual(await send('/other'), { status: 404, html: '<p>404 /other</p>' });
    assert.equal(renders.count, 2, 'another path is another page');
  });

  it('never keeps the page of a request that carries a credential', async () => {
    const { renders, send } = await counted();
    await send('/gone', { cookie: 'sid=s1' });
    await send('/gone', { cookie: 'sid=s1' });
    assert.equal(renders.count, 2);
  });

  it('never keeps a page that read the request', async () => {
    const { renders, send } = await counted('request');
    assert.deepEqual(await send('/gone'), { status: 404, html: '<p>404 /gone seen</p>' });
    await send('/gone');
    assert.equal(renders.count, 2);
  });

  it('never keeps a page that read the ambient request frame', async () => {
    const { renders, send } = await counted('ambient-nonce');
    assert.equal((await send('/gone')).html, '<p>404 /gone seen</p>');
    await send('/gone');
    assert.equal(renders.count, 2);
  });

  it("never keeps a 404 a route raised: each request shows that route's message", async () => {
    let state = 'draft';
    const renders = { count: 0 };
    const app = await createApp({
      manifest,
      renderer: preactPageRenderer,
      onError: quiet,
      // A mount, whose failure a browser is answered with the app's error page.
      contributions: appRoutes((routes) =>
        routes.mount(
          '/post',
          () => {
            throw new HttpError(
              'not_found',
              state === 'draft' ? 'This post is still a draft.' : 'This post was deleted.',
              404,
            );
          },
          { access: publicAccess('error page probe') },
        ),
      ),
      errorPage: (error) => {
        renders.count += 1;
        return `<p>${error.status}: ${error.message}</p>`;
      },
    });
    const send = async () => {
      const res = await app.fetch(
        new Request('http://localhost/post', { headers: { accept: BROWSER_ACCEPT } }),
      );
      return { status: res.status, html: await res.text() };
    };
    assert.deepEqual(await send(), {
      status: 404,
      html: '<p>404: This post is still a draft.</p>',
    });
    state = 'deleted';
    assert.deepEqual(await send(), { status: 404, html: '<p>404: This post was deleted.</p>' });
    assert.equal(renders.count, 2);
  });

  it('keeps the 405 page of an unmatched method like the 404 page', async () => {
    const { renders, send } = await counted();
    assert.deepEqual(await send('/broken', {}, 'POST'), {
      status: 405,
      html: '<p>405 /broken</p>',
    });
    assert.deepEqual(await send('/broken', {}, 'POST'), {
      status: 405,
      html: '<p>405 /broken</p>',
    });
    assert.equal(renders.count, 1);
  });

  it('never keeps the page of a failure other than 404 or 405', async () => {
    const { renders, send } = await counted();
    assert.equal((await send('/broken')).status, 500);
    assert.equal((await send('/broken')).status, 500);
    assert.equal(renders.count, 2);
  });
});
