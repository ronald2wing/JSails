/**
 * The page outcome contract, row by row on its three consumers: a buffered
 * page, a streamed page (`export const stream = true`) and the static export.
 *
 * Every row is answered by the same fixture pages (a hand-written module and
 * a `.jsails` page compiled by the SFC fixture harness): plain props, a
 * `reply.props` with a status, headers and two cookies, a same-origin and an
 * external redirect, and not-found. Served, a document is a byte body when
 * buffered and a stream when streamed, a redirect is an empty body with its
 * `Location`, and not-found is the app's 404; exported, a document is
 * written, a redirect leaves a fallback document and an entry in
 * `redirects.json`, not-found writes nothing, and headers or cookies fail
 * the export naming the route. A streamed page's late failure and a
 * producer's mid-stream failure reach `onError` with the route pattern and
 * the request id. The type rows prove that a `load` returning a reply
 * type-checks, that a raw `Response` does not, and that a `.jsails`
 * template sees only the props.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createAssetIndex } from '../../src/assets/asset-index.js';
import { scopeMarker, sfcScopeId } from '../../src/compiler/sfc/style.js';
import type { RequestContext } from '../../src/contracts/http.js';
import type { PageModule, PageOutcome, PageRenderer } from '../../src/contracts/render.js';
import { documentOutcome, preactPageRenderer } from '../../src/pages/page.js';
import { reply, type PageProps } from '../../src/pages/reply.js';
import { generateStaticSite, StaticSiteError } from '../../src/pages/static-site/index.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import type { RequestErrorInfo } from '../../src/server/request-errors.js';
import { compileFixtureApp, type CompiledFixtureApp } from '../compiler/sfc/compiled-fixture.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const runtimeUrl = new URL('../../src/jsx/jsx-runtime.js', import.meta.url).href;
const replyUrl = new URL('../../src/pages/reply.js', import.meta.url).href;

/** A browser navigation, so a failure is answered with the app's HTML page. */
const NAVIGATION: RequestInit = { headers: { accept: 'text/html' } };

/** The `load` bodies every consumer answers, by page name. */
const LOADS = {
  plain: `return { name: 'plain' };`,
  status: `return reply.props({ name: 'status' }, { status: 203 });`,
  cookies: `return reply.props({ name: 'cookies' }, {
    headers: [['x-page', 'cookies']],
    cookies: [{ name: 'first', value: '1' }, { name: 'second', value: '2', maxAge: 60 }],
  });`,
  moved: `return reply.redirect('/plain?from=moved');`,
  away: `return reply.redirectExternal('https://pay.example/checkout', { status: 303 });`,
  gone: `return reply.notFound();`,
} as const;

type PageName = keyof typeof LOADS;

/** A page module answering `LOADS[name]`, streamed when `streamed`. */
function pageSource(name: PageName, streamed: boolean): string {
  return `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { reply } from ${JSON.stringify(replyUrl)};
${streamed ? 'export const stream = true;\n' : ''}export async function load() {
  ${LOADS[name]}
}
export default function Page({ name }) {
  return jsx('p', { children: name });
}
`;
}

/** A `.jsails` page that redirects a signed-out visitor and greets a signed-in one. */
function gatePage(streamed: boolean): string {
  return `<script lang="ts">
import type { RequestContext } from 'jsails';
import { reply } from 'jsails/pages';
${streamed ? '\nexport const stream = true;\n' : ''}
export async function load(context: RequestContext) {
  if (context.url.searchParams.get('signed') !== 'in') {
    return reply.redirect('/login?next=%2Fgate');
  }
  return reply.props({ greeting: 'welcome' }, { status: 203 });
}
</script>

<template>
  <p>{{ greeting }}</p>
</template>
`;
}

const suite = mkdtempSync(join(distDir, 'page-outcome-'));
let jsails: CompiledFixtureApp | undefined;

before(() => {
  jsails = compileFixtureApp([
    { path: 'pages/gate.jsails', source: gatePage(false) },
    { path: 'pages/streamed/gate.jsails', source: gatePage(true) },
  ]);
  for (const name of Object.keys(LOADS) as PageName[]) {
    writeFixture(jsails.root, `pages/${name}.mjs`, pageSource(name, false));
    writeFixture(jsails.root, `pages/streamed/${name}.mjs`, pageSource(name, true));
  }
});

after(() => {
  jsails?.dispose();
  rmSync(suite, { recursive: true, force: true });
});

/** One reported failure: the error and what the reporter knew about its request. */
interface Reported {
  readonly error: unknown;
  readonly info: RequestErrorInfo;
}

/** The fixture app served, with the failures `onError` received. */
async function servedApp(reported: Reported[] = [], options: Partial<AppOptions> = {}) {
  assert.ok(jsails !== undefined);
  return createApp({
    manifest: discoverRoutes(jsails.root),
    renderer: preactPageRenderer,
    onError: (error, info) => {
      reported.push({ error, info });
    },
    ...options,
  });
}

for (const streamed of [false, true]) {
  const prefix = streamed ? '/streamed' : '';
  describe(`a ${streamed ? 'streamed' : 'buffered'} page answers its outcome`, () => {
    let app: Awaited<ReturnType<typeof servedApp>>;
    before(async () => {
      app = await servedApp();
    });
    const request = async (path: string, init: RequestInit = NAVIGATION): Promise<Response> =>
      app.fetch(new Request(`https://app.test${prefix}${path}`, init));

    it(`renders a document as ${streamed ? 'a stream' : 'bytes'}`, async () => {
      const response = await request('/plain');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      if (streamed) {
        assert.equal(response.headers.get('x-accel-buffering'), 'no');
        assert.equal(response.headers.get('content-length'), null);
      } else {
        assert.equal(response.headers.get('x-accel-buffering'), null);
      }
      assert.match(await response.text(), /<p>plain<\/p>/);
    });

    it('answers with the status a props reply chose, never shared', async () => {
      const response = await request('/status');
      assert.equal(response.status, 203);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(await response.text(), /<p>status<\/p>/);
    });

    it('sends two cookies as two Set-Cookie headers, with the reply defaults', async () => {
      const response = await request('/cookies');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-page'), 'cookies');
      assert.deepEqual(response.headers.getSetCookie(), [
        'first=1; Path=/; HttpOnly; Secure; SameSite=Lax',
        'second=2; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
      ]);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(await response.text(), /<p>cookies<\/p>/);
    });

    it('omits Secure from a cookie set over plain http', async () => {
      const response = await app.fetch(new Request(`http://app.test${prefix}/cookies`, NAVIGATION));
      assert.deepEqual(response.headers.getSetCookie(), [
        'first=1; Path=/; HttpOnly; SameSite=Lax',
        'second=2; Max-Age=60; Path=/; HttpOnly; SameSite=Lax',
      ]);
      await response.body?.cancel();
    });

    // Node behind a TLS-terminating proxy sees plain http; the scheme the
    // visitor used is the resolved origin's.
    const SECURE_COOKIES = [
      'first=1; Path=/; HttpOnly; Secure; SameSite=Lax',
      'second=2; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
    ];

    it('marks a cookie Secure over plain http when the canonical origin is https', async () => {
      const proxied = await servedApp([], { server: { origin: 'https://app.test' } });
      const response = await proxied.fetch(
        new Request(`http://app.test${prefix}/cookies`, NAVIGATION),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.headers.getSetCookie(), SECURE_COOKIES);
      await response.body?.cancel();
    });

    it('marks a cookie Secure over plain http when a trusted proxy forwarded https', async () => {
      const proxied = await servedApp([], { server: { trustedProxies: { hops: 1 } } });
      const forwarded = (proto: string) =>
        proxied.fetch(
          new Request(`http://app.test${prefix}/cookies`, {
            headers: {
              accept: 'text/html',
              'x-forwarded-for': '198.51.100.7',
              'x-forwarded-proto': proto,
            },
          }),
        );
      const secure = await forwarded('https');
      assert.equal(secure.status, 200);
      assert.deepEqual(secure.headers.getSetCookie(), SECURE_COOKIES);
      await secure.body?.cancel();
      const plain = await forwarded('http');
      assert.deepEqual(plain.headers.getSetCookie(), [
        'first=1; Path=/; HttpOnly; SameSite=Lax',
        'second=2; Max-Age=60; Path=/; HttpOnly; SameSite=Lax',
      ]);
      await plain.body?.cancel();
    });

    it('redirects to a same-origin path with an empty body', async () => {
      const response = await request('/moved');
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/plain?from=moved');
      assert.equal(await response.text(), '');
    });

    it('redirects to an explicit external URL', async () => {
      const response = await request('/away');
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), 'https://pay.example/checkout');
    });

    it("answers not-found with the app's 404", async () => {
      const response = await request('/gone');
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      await response.body?.cancel();
    });

    it('answers a .jsails page: redirected signed out, rendered signed in', async () => {
      const out = await request('/gate');
      assert.equal(out.status, 302);
      assert.equal(out.headers.get('location'), '/login?next=%2Fgate');
      const inside = await request('/gate?signed=in');
      assert.equal(inside.status, 203);
      const file = streamed ? 'pages/streamed/gate.jsails' : 'pages/gate.jsails';
      assert.ok((await inside.text()).includes(`<p${scopeMarker(sfcScopeId(file))}>welcome</p>`));
    });
  });
}

describe("only a page's own 200 document takes its public cacheControl", () => {
  const dir = mkdtempSync(join(distDir, 'page-outcome-cache-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  /** The `load` bodies of pages that each declare `cacheControl`, by page name. */
  const cached = {
    shared: `return { name: 'shared' };`,
    plainReply: `return reply.props({ name: 'plain-reply' });`,
    status: `return reply.props({ name: 'status' }, { status: 203 });`,
    headers: `return reply.props({ name: 'headers' }, { headers: [['x-variant', 'b']] });`,
    gone: `return reply.props({ name: 'gone' }, { status: 410 });`,
    login: `return reply.redirect('/login', { status: 308 });`,
    away: `return reply.redirectExternal('https://pay.example/', { status: 308 });`,
  } as const;
  for (const [name, load] of Object.entries(cached)) {
    writeFixture(
      dir,
      `pages/${name}.mjs`,
      `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { reply } from ${JSON.stringify(replyUrl)};
export const cacheControl = { maxAge: 300 };
export async function load() {
  ${load}
}
export default function Page({ name }) {
  return jsx('p', { children: name });
}
`,
    );
  }
  writeFixture(
    dir,
    'pages/custom.mjs',
    `export const cacheControl = { maxAge: 300 };
export default function Page() {
  return null;
}
`,
  );

  const PUBLIC = 'public, max-age=0, s-maxage=300, stale-while-revalidate=0';
  let app: Awaited<ReturnType<typeof createApp>>;
  before(async () => {
    app = await createApp({ manifest: discoverRoutes(dir), renderer: preactPageRenderer });
  });
  /** An anonymous GET of `path`: nothing about it keeps a shared cache out. */
  const anonymous = (path: string) => app.fetch(new Request(`https://app.test${path}`, NAVIGATION));

  for (const path of ['/shared', '/plainReply']) {
    it(`shares ${path}, a 200 with nothing of its own`, async () => {
      const response = await anonymous(path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), PUBLIC);
      assert.equal(
        response.headers.get('surrogate-control'),
        'max-age=300, stale-while-revalidate=0',
      );
      await response.body?.cancel();
    });
  }

  for (const [path, status] of [
    ['/status', 203],
    ['/headers', 200],
    ['/gone', 410],
    ['/login', 308],
    ['/away', 308],
  ] as const) {
    it(`never shares ${path} (${status}), the request's own answer`, async () => {
      const response = await anonymous(path);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('surrogate-control'), null);
      await response.body?.cancel();
    });
  }

  it("keeps a custom renderer's redirect and non-200 document private", async () => {
    const outcomes: Record<string, PageOutcome> = {
      '/custom': { kind: 'redirect', status: 301, location: '/elsewhere' },
    };
    const renderer: PageRenderer = {
      render: (entry, context, options) =>
        outcomes[entry.route] ?? preactPageRenderer.render(entry, context, options),
    };
    const custom = await createApp({ manifest: discoverRoutes(dir), renderer });
    const redirected = await custom.fetch(new Request('https://app.test/custom', NAVIGATION));
    assert.equal(redirected.status, 301);
    assert.equal(redirected.headers.get('cache-control'), 'private, no-store');
    outcomes['/custom'] = documentOutcome('<p>made</p>', { status: 203 });
    const made = await custom.fetch(new Request('https://app.test/custom', NAVIGATION));
    assert.equal(made.status, 203);
    assert.equal(made.headers.get('cache-control'), 'private, no-store');
    await made.body?.cancel();
    outcomes['/custom'] = documentOutcome('<p>made</p>');
    const shared = await custom.fetch(new Request('https://app.test/custom', NAVIGATION));
    assert.equal(shared.headers.get('cache-control'), PUBLIC);
    await shared.body?.cancel();
  });
});

/** The routes of the app at `root` that `keep` keeps. */
function pagesOf(root: string, keep: (route: string) => boolean): RouteManifest {
  const entries = discoverRoutes(root).entries.filter((entry) => keep(entry.route));
  return { entries, byRoute: new Map(entries.map((entry) => [entry.route, entry])) };
}

describe('the static export answers the same outcomes', () => {
  it('writes documents, records redirects and skips not-found', async () => {
    assert.ok(jsails !== undefined);
    const root = jsails.root;
    const outDir = join(suite, 'out');
    const manifest = pagesOf(root, (route) => !route.endsWith('/cookies'));
    const result = await generateStaticSite({
      root,
      manifest,
      outDir,
      baseUrl: 'https://app.test',
      seo: { siteName: 'Outcomes' },
    });
    const read = (path: string): string => readFileSync(join(outDir, ...path.split('/')), 'utf8');

    assert.match(read('plain/index.html'), /<p>plain<\/p>/);
    // A static file carries no status: the document is written as rendered.
    assert.match(read('status/index.html'), /<p>status<\/p>/);
    assert.match(read('streamed/plain/index.html'), /<p>plain<\/p>/);
    assert.deepEqual(JSON.parse(read('redirects.json')), {
      redirects: [
        { from: '/away', to: 'https://pay.example/checkout', status: 303 },
        { from: '/gate', to: '/login?next=%2Fgate', status: 302 },
        { from: '/moved', to: '/plain?from=moved', status: 302 },
        { from: '/streamed/away', to: 'https://pay.example/checkout', status: 303 },
        { from: '/streamed/gate', to: '/login?next=%2Fgate', status: 302 },
        { from: '/streamed/moved', to: '/plain?from=moved', status: 302 },
      ],
    });
    assert.deepEqual(
      result.redirects.map((entry) => entry.from),
      ['/away', '/gate', '/moved', '/streamed/away', '/streamed/gate', '/streamed/moved'],
    );
    const fallback = read('gate/index.html');
    assert.match(fallback, /<meta http-equiv="refresh" content="0; url=\/login\?next=%2Fgate"/);
    assert.match(fallback, /<meta name="robots" content="noindex"/);
    assert.match(fallback, /<a href="\/login\?next=%2Fgate">/);
    assert.deepEqual(result.notFound, ['/gone', '/streamed/gone']);
    assert.equal(existsSync(join(outDir, 'gone')), false);
    assert.ok(result.raw.includes(join(outDir, 'redirects.json')));
    const sitemap = read('sitemap.xml');
    assert.match(sitemap, /https:\/\/app\.test\/plain/);
    assert.doesNotMatch(sitemap, /\/gate|\/moved|\/away|\/gone/);
  });

  it('refuses a public asset at redirects.json when a page redirected', async () => {
    assert.ok(jsails !== undefined);
    const root = jsails.root;
    const publicDir = join(suite, 'public');
    writeFixture(publicDir, 'redirects.json', '{}');
    const outDir = join(suite, 'collides');
    await assert.rejects(
      generateStaticSite({
        root,
        manifest: pagesOf(root, (route) => route === '/moved'),
        outDir,
        assets: await createAssetIndex({ roots: [{ dir: publicDir }] }),
      }),
      (error: unknown) =>
        error instanceof StaticSiteError &&
        error.code === 'duplicate_output' &&
        error.message.includes('"redirects.json"'),
    );
    assert.equal(existsSync(outDir), false);
  });

  for (const route of ['/cookies', '/streamed/cookies']) {
    it(`fails the export for ${route}, whose reply sets headers and cookies`, async () => {
      assert.ok(jsails !== undefined);
      const root = jsails.root;
      const outDir = join(suite, `refused-${route.replaceAll('/', '-')}`);
      const manifest = pagesOf(root, (page) => page === route);
      await assert.rejects(
        generateStaticSite({ root, manifest, outDir }),
        (error: unknown) =>
          error instanceof StaticSiteError &&
          error.code === 'reply_not_static' &&
          error.message.includes(`"${route}"`),
      );
      assert.equal(existsSync(outDir), false);
    });
  }
});

describe('the static export refuses an error page', () => {
  const dir = mkdtempSync(join(distDir, 'page-outcome-error-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFixture(
    dir,
    'pages/posts/retracted.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { reply } from ${JSON.stringify(replyUrl)};
export async function load() {
  return reply.props({ name: 'gone' }, { status: 410 });
}
export default function Page({ name }) {
  return jsx('p', { children: name });
}
`,
  );
  writeFixture(
    dir,
    'pages/broken.mjs',
    `export async function load() {
  throw new Error('content source unreachable');
}
export default function Page() {
  return null;
}
`,
  );
  writeFixture(
    dir,
    'pages/error.mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
export default function Boundary({ error }) {
  return jsx('p', { children: 'boundary ' + error.status });
}
`,
  );

  /** Export the one page at `route` with a sitemap, expecting it refused. */
  async function refused(route: string): Promise<StaticSiteError> {
    const outDir = join(dir, `out-${route.replaceAll('/', '-')}`);
    let caught: unknown;
    await generateStaticSite({
      root: dir,
      manifest: pagesOf(dir, (page) => page === route),
      outDir,
      baseUrl: 'https://site.test',
      seo: { siteName: 'Errors' },
    }).catch((error: unknown) => {
      caught = error;
    });
    assert.ok(caught instanceof StaticSiteError, 'the export must fail');
    assert.equal(caught.code, 'error_status');
    assert.ok(caught.message.includes(`"${route}"`));
    assert.equal(existsSync(outDir), false);
    return caught;
  }

  it('fails on a reply.props 4xx instead of publishing it as a page', async () => {
    const error = await refused('/posts/retracted');
    assert.match(error.message, /status 410/);
    assert.equal(error.cause, undefined);
  });

  it("fails on an error boundary's document, with the build-time failure as the cause", async () => {
    const error = await refused('/broken');
    assert.match(error.message, /status 500/);
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, 'content source unreachable');
  });
});

describe('a failure after the first byte is reported with its route and request', () => {
  const dir = mkdtempSync(join(distDir, 'page-outcome-late-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFixture(
    dir,
    'pages/feed.mjs',
    `export async function* stream() {
  yield '<p>start</p>';
  throw new Error('producer lost');
}
`,
  );
  writeFixture(
    dir,
    'pages/report/[id].mjs',
    `import { jsx } from ${JSON.stringify(runtimeUrl)};
import { Suspense } from 'preact/compat';
export const stream = true;
let pending;
function Late() {
  pending ??= new Promise((_, reject) => setImmediate(() => reject(new Error('render lost'))));
  throw pending;
}
export default function Page() {
  return jsx('main', { children: jsx(Suspense, { fallback: jsx('i', { children: 'wait' }), children: jsx(Late, {}) }) });
}
`,
  );

  /** Serve `path`, read the body to its end, and return the one failure reported. */
  async function lateFailure(path: string): Promise<{ reported: Reported; requestId: string }> {
    let observed!: (entry: Reported) => void;
    const reportedOnce = new Promise<Reported>((resolve) => {
      observed = resolve;
    });
    const app = await createApp({
      manifest: discoverRoutes(dir),
      renderer: preactPageRenderer,
      onError: (error, info) => observed({ error, info }),
    });
    const response = await app.fetch(new Request(`https://app.test${path}`, NAVIGATION));
    assert.equal(response.status, 200);
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId !== null && requestId !== '');
    await response.text().catch(() => '');
    return { reported: await reportedOnce, requestId };
  }

  it("reports a producer's mid-stream failure", async () => {
    const { reported, requestId } = await lateFailure('/feed');
    assert.match(String(reported.error), /producer lost/);
    assert.equal(reported.info.route, '/feed');
    assert.equal(reported.info.requestId, requestId);
    assert.equal(reported.info.phase, 'stream');
  });

  it("reports a streamed document's late failure", async () => {
    const { reported, requestId } = await lateFailure('/report/7');
    assert.match(String(reported.error), /render lost/);
    assert.equal(reported.info.route, '/report/:id');
    assert.equal(reported.info.requestId, requestId);
    assert.equal(reported.info.phase, 'stream');
  });
});

describe('the page outcome types', () => {
  /** Whether `A` and `B` are each assignable to the other. */
  type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const holds = <T extends true>(value: T): T => value;

  it('accepts a load that replies and refuses one that returns a Response', () => {
    const replying: PageModule<{ readonly name: string }> = {
      async load(context: RequestContext) {
        if (context.session === null) return reply.redirect('/login');
        if (context.params['id'] === undefined) return reply.notFound();
        return reply.props({ name: 'x' }, { status: 201 });
      },
    };
    const refused: PageModule<{ readonly name: string }> = {
      // @ts-expect-error -- a raw Response is not a page outcome.
      async load() {
        return new Response(null, { status: 302, headers: { location: '/x' } });
      },
    };
    assert.equal(typeof replying.load, 'function');
    assert.equal(typeof refused.load, 'function');
  });

  it('gives a component the props of load, unwrapping a props reply', () => {
    async function load(context: RequestContext) {
      if (context.session === null) return reply.redirect('/login');
      if (context.params['id'] === 'gone') return reply.notFound();
      if (context.params['id'] === 'new') return reply.props({ id: 'new' }, { status: 201 });
      return { id: context.params['id'] ?? '' };
    }
    assert.ok(holds<Equal<PageProps<typeof load>, { id: string }>>(true));
    // A redirect leaves nothing a template could read by mistake.
    assert.ok(holds<Equal<'location' extends keyof PageProps<typeof load> ? 1 : 0, 0>>(true));
    async function plainLoad() {
      return { count: 1 };
    }
    assert.ok(holds<Equal<PageProps<typeof plainLoad>, { count: number }>>(true));
    assert.deepEqual(
      [typeof load, typeof plainLoad],
      ['function', 'function'],
      'the loads exist only to be typed',
    );
  });

  it('lets a .jsails template read the props and nothing of the reply', () => {
    const typed = compileFixtureApp([
      { path: 'pages/gate.jsails', source: gatePage(false) },
      {
        path: 'pages/leak.jsails',
        source: gatePage(false).replace('{{ greeting }}', '{{ location }}'),
      },
    ]);
    try {
      const result = typed.typecheck();
      assert.deepEqual(result.unparsed, []);
      const files = [...new Set(result.diagnostics.map((entry) => entry.file))];
      assert.deepEqual(files, ['pages/leak.jsails']);
    } finally {
      typed.dispose();
    }
  });
});
