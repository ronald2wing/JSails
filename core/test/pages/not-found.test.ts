/**
 * Tests for the `not-found` page convention: nearest-scope matching, the
 * `ErrorPageRenderer` it builds for `createApp`, the 404 status it keeps, and
 * the `404.html` the static export writes.
 *
 * Fixtures are compiled ESM modules on disk that import the built JSX runtime
 * by absolute file URL; nothing opens a service.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { RequestContext } from '../../src/contracts/http.js';
import {
  createNotFoundErrorPage,
  matchNotFoundPage,
  renderNotFoundPage,
} from '../../src/pages/not-found.js';
import { preactPageRenderer } from '../../src/pages/page.js';
import { generateStaticSite } from '../../src/pages/static-site/index.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import type { ErrorPageRenderer } from '../../src/server/error-pages.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const suiteRoot = mkdtempSync(join(distDir, 'not-found-'));
after(() => rmSync(suiteRoot, { recursive: true, force: true }));

const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const quiet = (): void => undefined;

/** A page module rendering `<main>{text}</main>`. */
function textPage(text: string): string {
  return `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function Page() { return jsx('main', { children: ${JSON.stringify(text)} }); }
`;
}

const appRoot = join(suiteRoot, 'app');
writeFixture(appRoot, 'pages/index.mjs', textPage('home'));
writeFixture(
  appRoot,
  'pages/layout.mjs',
  `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function Layout({ children }) { return jsx('div', { id: 'site', children }); }
`,
);
writeFixture(appRoot, 'pages/not-found.mjs', textPage('site lost'));
writeFixture(appRoot, 'pages/docs/not-found.mjs', textPage('docs lost'));
writeFixture(appRoot, 'pages/teams/[team]/not-found.mjs', textPage('team lost'));
writeFixture(
  appRoot,
  'pages/posts/[slug].mjs',
  `import { HttpError } from ${JSON.stringify(new URL('../../src/contracts/http.js', import.meta.url).href)};
export function load() { throw new HttpError('not_found', 'No such post', 404); }
export default function Post() { return null; }
`,
);
writeFixture(appRoot, 'api/ok.mjs', `export const GET = () => Response.json({ ok: true });\n`);
const manifest = discoverRoutes(appRoot);

function contextFor(path: string): RequestContext {
  const url = new URL(path, 'http://localhost');
  return { request: new Request(url), url, params: {}, session: null };
}

describe('matchNotFoundPage', () => {
  const scopeFor = (path: string, locales?: readonly string[]) =>
    matchNotFoundPage(manifest, path, locales)?.scope;

  it('picks the nearest scope that prefixes the path', () => {
    assert.equal(scopeFor('/docs/missing/deep'), '/docs');
    assert.equal(scopeFor('/docs'), '/docs');
    assert.equal(scopeFor('/teams/acme/settings'), '/teams/:team');
    assert.equal(scopeFor('/teams'), '/');
    assert.equal(scopeFor('/elsewhere'), '/');
  });

  it('decodes path segments and ignores a leading locale segment', () => {
    assert.equal(scopeFor('/%64ocs/x'), '/docs');
    assert.equal(scopeFor('/fr/docs/x', ['fr']), '/docs');
    assert.equal(scopeFor('/fr/docs/x'), '/');
  });

  it('treats a malformed escape as matching no segment', () => {
    assert.equal(scopeFor('/%E0%A4%A/x'), '/');
    assert.equal(scopeFor('/teams/%E0%A4%A/x'), '/');
  });

  it('matches nothing when the manifest has no not-found page', () => {
    const empty: RouteManifest = { entries: [], byRoute: new Map() };
    assert.equal(matchNotFoundPage(empty, '/x'), undefined);
  });
});

describe('createNotFoundErrorPage', () => {
  it('returns the fallback unchanged when the app has no not-found page', () => {
    const fallback: ErrorPageRenderer = () => 'fallback';
    const empty: RouteManifest = { entries: [], byRoute: new Map(), notFound: [] };
    assert.equal(
      createNotFoundErrorPage({ manifest: empty, renderer: preactPageRenderer, fallback }),
      fallback,
    );
    assert.equal(
      createNotFoundErrorPage({ manifest: empty, renderer: preactPageRenderer }),
      undefined,
    );
  });

  it('renders the nearest not-found page with its layouts for a 404', async () => {
    const errorPage = createNotFoundErrorPage({ manifest, renderer: preactPageRenderer })!;
    const html = await errorPage({ status: 404, message: 'Not Found' }, contextFor('/docs/x'));
    assert.match(html, /<div id="site"><main>docs lost<\/main><\/div>/);
  });

  it('sends other statuses to the fallback, or the built-in page without one', async () => {
    const seen: number[] = [];
    const fallback: ErrorPageRenderer = (error) => {
      seen.push(error.status);
      return 'fallback page';
    };
    const withFallback = createNotFoundErrorPage({
      manifest,
      renderer: preactPageRenderer,
      fallback,
    })!;
    assert.equal(
      await withFallback({ status: 500, message: 'Internal Server Error' }, contextFor('/x')),
      'fallback page',
    );
    assert.deepEqual(seen, [500]);

    const builtIn = createNotFoundErrorPage({ manifest, renderer: preactPageRenderer })!;
    assert.match(
      await builtIn({ status: 500, message: 'Internal Server Error' }, contextFor('/x')),
      /500 Internal Server Error/,
    );
  });

  it('refuses a not-found page that declares the shared props cache', async () => {
    const root = join(suiteRoot, 'cached');
    writeFixture(
      root,
      'pages/not-found.mjs',
      `export const cache = 'public';\nexport const revalidate = 60;\n${textPage('cached')}`,
    );
    const cached = discoverRoutes(root);
    await assert.rejects(
      renderNotFoundPage(cached.notFound![0]!, preactPageRenderer, contextFor('/x'), false),
      (error: unknown) => (error as { code?: unknown }).code === 'invalid_module',
    );
  });

  it('refuses a not-found page that declares middleware it would never run', async () => {
    const root = join(suiteRoot, 'guarded');
    writeFixture(
      root,
      'pages/admin/not-found.mjs',
      `export const middleware = [() => undefined];\n${textPage('admin secrets')}`,
    );
    const guarded = discoverRoutes(root);
    await assert.rejects(
      renderNotFoundPage(guarded.notFound![0]!, preactPageRenderer, contextFor('/admin/x'), false),
      (error: unknown) => (error as { code?: unknown }).code === 'invalid_module',
    );
    const errorPage = createNotFoundErrorPage({ manifest: guarded, renderer: preactPageRenderer })!;
    await assert.rejects(
      Promise.resolve(errorPage({ status: 404, message: 'Not Found' }, contextFor('/admin/x'))),
      (error: unknown) => (error as { code?: unknown }).code === 'invalid_module',
    );
  });

  it("gives the page its own scope's params, not the failing route's", async () => {
    const root = join(suiteRoot, 'scoped');
    writeFixture(
      root,
      'pages/teams/[team]/not-found.mjs',
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
export function load(context) { return { team: context.params.team, keys: Object.keys(context.params) }; }
export default function Lost({ team, keys }) { return jsx('main', { children: team + ':' + keys.join(',') }); }
`,
    );
    const scoped = discoverRoutes(root);
    const errorPage = createNotFoundErrorPage({ manifest: scoped, renderer: preactPageRenderer })!;
    const context = { ...contextFor('/teams/acme%20co/x'), params: { slug: 'other-route' } };
    const html = await errorPage({ status: 404, message: 'Not Found' }, context);
    assert.match(html, /<main>acme co:team<\/main>/);
  });
});

describe('not-found pages through createApp', () => {
  // No `errorPage`: createApp wires the manifest's not-found pages itself.
  async function app() {
    return createApp({ manifest, renderer: preactPageRenderer, onError: quiet });
  }

  it('answers an unmatched browser navigation with the not-found page and a 404', async () => {
    const res = await (
      await app()
    ).fetch(
      new Request('http://localhost/teams/acme/nope', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /team lost/);
  });

  it('renders it for an HttpError(404) thrown by a page load', async () => {
    const res = await (
      await app()
    ).fetch(new Request('http://localhost/posts/gone', { headers: { accept: BROWSER_ACCEPT } }));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /site lost/);
  });

  it('keeps the app errorPage for every other status', async () => {
    const appWithFallback = await createApp({
      manifest,
      renderer: preactPageRenderer,
      errorPage: (error) => `<p>custom ${error.status}</p>`,
      onError: quiet,
    });
    const lost = await appWithFallback.fetch(
      new Request('http://localhost/docs/nope', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(lost.status, 404);
    assert.match(await lost.text(), /docs lost/);
    const notAllowed = await appWithFallback.fetch(
      new Request('http://localhost/', { method: 'POST', headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(notAllowed.status, 405);
    assert.match(await notAllowed.text(), /custom 405/);
  });

  it('serves no not-found page without a structured renderer', async () => {
    const plain = await createApp({
      manifest,
      renderPage: () => new Response('page'),
      onError: quiet,
    });
    const res = await plain.fetch(
      new Request('http://localhost/teams/acme/nope', { headers: { accept: BROWSER_ACCEPT } }),
    );
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /team lost/);
  });

  it('keeps the JSON envelope for API paths', async () => {
    const res = await (
      await app()
    ).fetch(new Request('http://localhost/api/missing', { headers: { accept: BROWSER_ACCEPT } }));
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  });
});

describe('static export 404.html', () => {
  it('writes the root not-found page to 404.html, outside the sitemap', async () => {
    const root = join(suiteRoot, 'static');
    writeFixture(root, 'pages/index.mjs', textPage('home'));
    writeFixture(
      root,
      'pages/layout.mjs',
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function Layout({ children }) { return jsx('div', { id: 'site', children }); }
`,
    );
    writeFixture(root, 'pages/not-found.mjs', textPage('site lost'));
    writeFixture(root, 'pages/docs/not-found.mjs', textPage('docs lost'));
    const outDir = join(suiteRoot, 'site-out');
    const result = await generateStaticSite({
      manifest: discoverRoutes(root),
      outDir,
      seo: {},
    });
    const notFoundFile = join(outDir, '404.html');
    assert.ok(existsSync(notFoundFile));
    assert.equal(result.written.at(-1), notFoundFile);
    assert.match(
      readFileSync(notFoundFile, 'utf8'),
      /<div id="site"><main>site lost<\/main><\/div>/,
    );
    assert.doesNotMatch(readFileSync(join(outDir, 'sitemap.xml'), 'utf8'), /404/);
  });

  it('writes no 404.html when the app has no root not-found page', async () => {
    const root = join(suiteRoot, 'nested-only');
    writeFixture(root, 'pages/index.mjs', textPage('home'));
    writeFixture(root, 'pages/docs/not-found.mjs', textPage('docs lost'));
    const outDir = join(suiteRoot, 'nested-out');
    await generateStaticSite({ manifest: discoverRoutes(root), outDir });
    assert.ok(!existsSync(join(outDir, '404.html')));
  });
});
