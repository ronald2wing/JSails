/**
 * `defineApi` and `definePage`: what a definition accepts, the params typed
 * from its path, and how assembly serves it (access, cross-site rule, the
 * path check, the only-export rule, a page's 403).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { legacyAccess, publicAccess } from '../../src/api/access-ref.js';
import {
  defineApi,
  definePage,
  type ApiContext,
  type RouteParams,
} from '../../src/api/route-definition.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import { RouteErrors } from '../../src/server/route-meta.js';
import { TEST_ORIGIN, writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const API_URL = JSON.stringify(pathToFileURL(join(distDir, 'src/api/index.js')).href);
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function appRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(distDir, 'route-definition-'));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) writeFixture(root, path, source);
  return root;
}

const OPEN = publicAccess('test route');
const ok = () => new Response('ok');

describe('defineApi', () => {
  it('requires an access reference and a handler', () => {
    assert.throws(() => defineApi('/x', { GET: ok } as never), TypeError);
    assert.throws(() => defineApi('/x', { access: OPEN }), TypeError);
    assert.throws(() => defineApi('/x', { access: OPEN, GET: 'nope' } as never), TypeError);
    assert.throws(() => defineApi('/x', { access: OPEN, GET: ok, extra: 1 } as never), TypeError);
    assert.throws(
      () => defineApi('/x', { access: OPEN, GET: ok, csrf: 'off' } as never),
      TypeError,
    );
    assert.throws(() => defineApi('x', { access: OPEN, GET: ok }), TypeError);
  });

  it('types the handler params from the path', () => {
    const definition = defineApi('/posts/:id/files/*rest', {
      access: OPEN,
      GET: ({ params }) => Response.json({ id: params.id, rest: params.rest }),
    });
    assert.equal(definition.path, '/posts/:id/files/*rest');
    const params: RouteParams<'/posts/:id/files/*rest'> = { id: '1', rest: 'a/b' };
    assert.equal(params.id, '1');
    // @ts-expect-error -- `/posts/:id` declares no `slug` param.
    const handler = (context: ApiContext<'/posts/:id'>) => context.params.slug;
    assert.equal(typeof handler, 'function');
  });

  it('does not compile without access', () => {
    // @ts-expect-error -- `access` is required: a route states who may reach it.
    assert.throws(() => defineApi('/x', { GET: ok }), TypeError);
  });

  it('serves a definition with its access and cross-site rule', async () => {
    const root = appRoot({
      'api/posts/[id].mjs': `import { defineApi } from ${API_URL};
export default defineApi('/api/posts/:id', {
  access: ({ request }) => request.headers.get('x-allow') === '1',
  GET: ({ params }) => Response.json({ id: params.id }),
  POST: () => Response.json({ posted: true }),
});\n`,
    });
    const app = await createApp({
      manifest: discoverRoutes(root),
      resolveSession: () => ({
        id: 's1',
        data: {},
        expiresAt: Date.now() + 60_000,
      }),
    });
    const allowed = { 'x-allow': '1', cookie: 'sid=1' };
    const res = await app.fetch(new Request(`${TEST_ORIGIN}/api/posts/7`, { headers: allowed }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: '7' });
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/api/posts/7`))).status, 403);
    const crossSite = await app.fetch(
      new Request(`${TEST_ORIGIN}/api/posts/7`, {
        method: 'POST',
        headers: { ...allowed, origin: 'https://evil.example' },
      }),
    );
    assert.equal(crossSite.status, 403, 'the default cross-site rule is origin');
  });

  it('refuses a definition whose path is not its file route', async () => {
    const root = appRoot({
      'api/posts.mjs': `import { defineApi, publicAccess } from ${API_URL};
export default defineApi('/api/other', { access: publicAccess('test'), GET: () => new Response('x') });\n`,
    });
    await assert.rejects(createApp({ manifest: discoverRoutes(root) }), (error: unknown) =>
      RouteErrors.is(error, 'pattern_mismatch'),
    );
  });

  it('refuses a module exporting anything beside its definition', async () => {
    const root = appRoot({
      'api/posts.mjs': `import { defineApi, publicAccess } from ${API_URL};
export const POST = () => new Response('x');
export default defineApi('/api/posts', { access: publicAccess('test'), GET: () => new Response('x') });\n`,
    });
    await assert.rejects(createApp({ manifest: discoverRoutes(root) }), (error: unknown) =>
      RouteErrors.is(error, 'invalid_definition'),
    );
  });
});

describe('definePage', () => {
  it('requires an access reference', () => {
    // @ts-expect-error -- `access` is required.
    assert.throws(() => definePage('/x', {}), TypeError);
    assert.equal(definePage('/x', { access: OPEN }).access, OPEN);
  });

  it('gates a page by its route export, rendering the 401 page to an anonymous caller', async () => {
    const root = appRoot({
      'pages/dashboard.mjs': `import { definePage } from ${API_URL};
export const route = definePage('/dashboard', {
  access: ({ request }) => request.headers.get('x-allow') === '1',
});
export default () => 'dashboard';\n`,
      'pages/about.mjs': `export default () => 'about';\n`,
    });
    const app = await createApp({ manifest: discoverRoutes(root), renderer: preactPageRenderer });
    const browser = { accept: 'text/html' };
    const denied = await app.fetch(new Request(`${TEST_ORIGIN}/dashboard`, { headers: browser }));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('cache-control'), 'private, no-store');
    assert.match(denied.headers.get('content-type') ?? '', /text\/html/);
    assert.doesNotMatch(await denied.text(), /dashboard/);
    const allowed = await app.fetch(
      new Request(`${TEST_ORIGIN}/dashboard`, { headers: { ...browser, 'x-allow': '1' } }),
    );
    assert.equal(allowed.status, 200);
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/about`))).status, 200);
  });

  it('refuses a route export that is not a definition or names another path', async () => {
    const wrongPath = appRoot({
      'pages/a.mjs': `import { definePage, publicAccess } from ${API_URL};
export const route = definePage('/b', { access: publicAccess('test') });
export default () => 'a';\n`,
    });
    await assert.rejects(
      createApp({ manifest: discoverRoutes(wrongPath), renderer: preactPageRenderer }),
      (error: unknown) => RouteErrors.is(error, 'pattern_mismatch'),
    );
    const notDefinition = appRoot({
      'pages/a.mjs': `export const route = { path: '/a' };\nexport default () => 'a';\n`,
    });
    await assert.rejects(
      createApp({ manifest: discoverRoutes(notDefinition), renderer: preactPageRenderer }),
      (error: unknown) => RouteErrors.is(error, 'invalid_definition'),
    );
  });
});

describe('access references', () => {
  it('reject a reasonless public reference and a non-function check', () => {
    assert.throws(() => publicAccess(''), TypeError);
    assert.throws(() => publicAccess('two\nlines'), TypeError);
    assert.throws(() => legacyAccess('yes' as never), TypeError);
  });
});
