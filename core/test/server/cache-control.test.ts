/**
 * Tests for the one cache policy (`decideCache`): default deny, the
 * route-level public opt-in and every condition that keeps it private.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { legacyAccess, publicAccess } from '../../src/api/access-ref.js';
import type { Admitted } from '../../src/security/access-record.js';
import { publicFilesSurface } from '../../src/security/surfaces.js';
import { createApp } from '../../src/server/app.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import {
  decideCache,
  extractCacheControlDeclaration,
  type CacheControlDeclaration,
} from '../../src/server/cache-control.js';
import type { ClaimedScope } from '../../src/server/request-frame.js';
import { appRequest, appRoutes, writeFixture } from '../fixtures/app.js';
import { documentOutcome } from '../../src/pages/page.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));

/** The head of a fixture API module open to anyone, so its answers may be shared. */
const PUBLIC_API = `import { publicAccess } from ${JSON.stringify(
  pathToFileURL(join(distDir, 'src/api/access-ref.js')).href,
)};\nexport const access = publicAccess('cached test route');\n`;

/** A page document above the encoding threshold. */
const LARGE_PAGE = `<!doctype html><h1>Large</h1>${'<p>paragraph</p>'.repeat(100)}`;
const fixturesRoot = mkdtempSync(join(distDir, 'cc-test-'));
const OPEN = publicAccess('cache-control probe');

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------

describe('extractCacheControlDeclaration', () => {
  it('returns undefined when cacheControl export is absent', () => {
    assert.equal(extractCacheControlDeclaration('/test', {}), undefined);
  });

  it('rejects a non-object cacheControl export', () => {
    assert.throws(
      () => extractCacheControlDeclaration('/test', { cacheControl: 'bad' }),
      /route "\/test" exports "cacheControl" as a non-object value/,
    );
  });

  it('rejects a non-integer maxAge', () => {
    assert.throws(
      () => extractCacheControlDeclaration('/test', { cacheControl: { maxAge: 3.5 } }),
      /cacheControl.maxAge must be a positive integer/,
    );
  });

  it('accepts a valid declaration with maxAge only', () => {
    const result = extractCacheControlDeclaration('/test', { cacheControl: { maxAge: 300 } });
    assert.ok(result !== undefined);
    assert.equal(result.maxAge, 300);
    assert.equal(result.staleWhileRevalidate, undefined);
  });

  it('accepts a valid declaration with both fields', () => {
    const result = extractCacheControlDeclaration('/test', {
      cacheControl: { maxAge: 300, staleWhileRevalidate: 60 },
    });
    assert.ok(result !== undefined);
    assert.equal(result.maxAge, 300);
    assert.equal(result.staleWhileRevalidate, 60);
  });
});

interface DecideInput {
  readonly status?: number;
  readonly method?: string;
  readonly requestHeaders?: Record<string, string>;
  readonly responseHeaders?: HeadersInit;
  readonly declaration?: CacheControlDeclaration;
  readonly claimed?: Partial<ClaimedScope>;
  readonly unclaimed?: boolean;
  readonly credentialed?: boolean;
  readonly live?: boolean;
  /** The surface's access is a check rather than public. */
  readonly checked?: boolean;
}

/** The admission the access chain records for `claimed` on a public (or checked) surface. */
function admissionOf(claimed: ClaimedScope | undefined, checked: boolean): Admitted | undefined {
  if (claimed === undefined) return undefined;
  const surface = publicFilesSurface();
  return {
    surface: checked ? { ...surface, access: legacyAccess(() => true) } : surface,
    anonymous: claimed.identity === null,
  };
}

/** The headers `decideCache` leaves on a response described by `input`. */
function decide(input: DecideInput = {}): Headers {
  const headers = new Headers(input.responseHeaders);
  const claimed: ClaimedScope | undefined = input.unclaimed
    ? undefined
    : {
        identity: null,
        locale: undefined,
        partitions: [],
        privateScope: false,
        ...input.claimed,
      };
  decideCache(
    'declaration' in input ? input.declaration : { maxAge: 300 },
    { status: input.status ?? 200, headers, live: input.live ?? false },
    claimed,
    admissionOf(claimed, input.checked ?? false),
    {
      request: new Request('http://localhost/x', {
        method: input.method ?? 'GET',
        headers: input.requestHeaders ?? {},
      }),
      credentialed: () => input.credentialed ?? false,
    },
  );
  return headers;
}

const PUBLIC = /^public, max-age=0, s-maxage=300, stale-while-revalidate=0$/;

describe('decideCache', () => {
  it('makes an undeclared answer private, no-store', () => {
    assert.equal(decide({ declaration: undefined }).get('cache-control'), 'private, no-store');
  });

  it('keeps a handler Cache-Control', () => {
    const headers = decide({ responseHeaders: { 'cache-control': 'public, max-age=3600' } });
    assert.equal(headers.get('cache-control'), 'public, max-age=3600');
  });

  it('applies a declaration to a qualifying answer, with its surrogate directive', () => {
    const headers = decide();
    assert.match(headers.get('cache-control') ?? '', PUBLIC);
    assert.equal(headers.get('surrogate-control'), 'max-age=300, stale-while-revalidate=0');
  });

  it('forces private, no-store and Vary: Cookie over everything for Set-Cookie', () => {
    const headers = decide({
      responseHeaders: {
        'set-cookie': 'session=abc',
        'cache-control': 'public, max-age=60',
        'surrogate-control': 'max-age=60',
        vary: 'Origin',
      },
    });
    assert.equal(headers.get('cache-control'), 'private, no-store');
    assert.equal(headers.get('surrogate-control'), null);
    assert.equal(headers.get('vary'), 'Origin, Cookie');
  });

  it('does not repeat a Vary entry already present in another case, and leaves * alone', () => {
    const cased = decide({ responseHeaders: { 'set-cookie': 'a=b', vary: 'origin, cookie' } });
    assert.equal(cased.get('vary'), 'origin, cookie');
    const star = decide({ responseHeaders: { 'set-cookie': 'a=b', vary: '*' } });
    assert.equal(star.get('vary'), '*');
  });

  for (const status of [201, 206, 302, 307, 401, 403, 404, 410, 500, 503]) {
    it(`keeps a ${status} answer private`, () => {
      const headers = decide({ status });
      assert.equal(headers.get('cache-control'), 'private, no-store');
      assert.equal(headers.get('surrogate-control'), null);
    });
  }

  for (const status of [200, 203, 204, 301, 308]) {
    it(`applies the declaration to a ${status} answer`, () => {
      assert.match(decide({ status }).get('cache-control') ?? '', PUBLIC);
    });
  }

  const privateCases: readonly (readonly [string, DecideInput])[] = [
    ['a mutation', { method: 'POST' }],
    ['an Authorization header', { requestHeaders: { authorization: 'Bearer t' } }],
    ['a request Cache-Control: no-store', { requestHeaders: { 'cache-control': 'no-store' } }],
    ['a resolved identity', { claimed: { identity: { id: 's' } as ClaimedScope['identity'] } }],
    ['an anonymous caller admitted by an access check', { checked: true }],
    ['a private scope', { claimed: { privateScope: true } }],
    [
      'a session partition',
      { claimed: { partitions: [{ name: 'tenant', value: 't1', from: 'session' }] } },
    ],
    [
      'a cookie-chosen locale',
      { claimed: { locale: { locale: 'fr', source: 'negotiated', vary: [], cookie: true } } },
    ],
    ['Vary: *', { responseHeaders: { vary: '*' } }],
    ['a live stream', { live: true }],
    ['an unclaimed request with a credential', { unclaimed: true, credentialed: true }],
  ];
  for (const [label, input] of privateCases) {
    it(`keeps a declared answer private for ${label}`, () => {
      assert.equal(decide(input).get('cache-control'), 'private, no-store');
    });
  }

  it('shares an answer partitioned by host or path', () => {
    const headers = decide({
      claimed: {
        partitions: [
          { name: 'tenant', value: 't1', from: 'host' },
          { name: 'section', value: 'docs', from: 'path' },
        ],
      },
    });
    assert.match(headers.get('cache-control') ?? '', PUBLIC);
  });

  it('varies a storable answer on the headers its locale was negotiated from', () => {
    const headers = decide({
      claimed: {
        locale: { locale: 'fr', source: 'negotiated', vary: ['Accept-Language'], cookie: false },
      },
      responseHeaders: { vary: 'Origin' },
    });
    assert.equal(headers.get('vary'), 'Origin, Accept-Language');
  });
});

describe('live HTTP cache-control -- default deny', () => {
  it('preserves the health endpoint explicit Cache-Control: no-store', async () => {
    writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({ manifest, healthPath: '/up' });
    const response = await appRequest(app, '/up');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('sets Cache-Control: private, no-store on an API 404 response', async () => {
    const apiDir = join(fixturesRoot, 'api');
    mkdirSync(apiDir, { recursive: true });
    writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({ manifest });
    const response = await appRequest(app, '/api/nonexistent');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });

  it('sets Cache-Control: private, no-store on a standard page', async () => {
    writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => documentOutcome('<!doctype html><h1>Hello</h1>') },
    });

    const response = await appRequest(app, '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });
});

describe('live HTTP cache-control -- explicit header wins', () => {
  it('preserves an explicit Cache-Control set by the handler', async () => {
    const app = await createApp({
      manifest: { entries: [], byRoute: new Map() },
      contributions: appRoutes((routes) =>
        routes.add({
          methods: ['GET'],
          path: '/custom',
          access: OPEN,
          handler: () =>
            new Response('custom', { headers: { 'cache-control': 'public, max-age=3600' } }),
        }),
      ),
    });

    const response = await appRequest(app, '/custom');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  });
});

describe('live HTTP cache-control -- route-level opt-in page', () => {
  it('applies public caching headers for a page that exports cacheControl', async () => {
    writeFixture(
      fixturesRoot,
      'pages/cacheable.mjs',
      'export const cacheControl = { maxAge: 300, staleWhileRevalidate: 60 };\nexport default () => null;\n',
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => documentOutcome(LARGE_PAGE) },
    });

    const response = await appRequest(app, '/cacheable');
    assert.equal(response.status, 200);
    const cc = response.headers.get('cache-control') ?? '';
    assert.match(cc, /public, max-age=0, s-maxage=300, stale-while-revalidate=60/);
    assert.equal(
      response.headers.get('surrogate-control'),
      'max-age=300, stale-while-revalidate=60',
    );
    // A body large enough to encode varies on the coding it was sent in.
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
  });

  it('does not vary a body too small to encode on Accept-Encoding', async () => {
    writeFixture(
      fixturesRoot,
      'pages/tiny.mjs',
      'export const cacheControl = { maxAge: 300 };\nexport default () => null;\n',
    );
    const app = await createApp({
      manifest: discoverRoutes(fixturesRoot),
      renderer: { render: () => documentOutcome('<!doctype html><h1>Tiny</h1>') },
    });

    const response = await appRequest(app, '/tiny', { headers: { 'accept-encoding': 'br' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('vary'), null);
  });

  it('does NOT have Vary: Cookie on a public page', async () => {
    writeFixture(
      fixturesRoot,
      'pages/public.mjs',
      'export const cacheControl = { maxAge: 300 };\nexport default () => null;\n',
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => documentOutcome('<!doctype html><h1>Cacheable</h1>') },
    });

    const response = await appRequest(app, '/public');
    assert.equal(response.status, 200);
    const vary = response.headers.get('vary') ?? '';
    assert.ok(!vary.includes('Cookie'));
  });
});

describe('live HTTP cache-control -- route-level opt-in API', () => {
  it('applies public caching to a GET API route that exports cacheControl', async () => {
    const apiDir = join(fixturesRoot, 'api');
    mkdirSync(apiDir, { recursive: true });
    writeFixture(
      fixturesRoot,
      'api/json.mjs',
      PUBLIC_API +
        "export const cacheControl = { maxAge: 600 };\nexport function GET() { return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }\n",
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
    });

    const response = await appRequest(app, '/api/json');
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('cache-control') ?? '',
      /public, max-age=0, s-maxage=600, stale-while-revalidate=0/,
    );
    assert.equal(
      response.headers.get('surrogate-control'),
      'max-age=600, stale-while-revalidate=0',
    );
    // Eleven bytes are never encoded, so the answer does not vary on the coding.
    assert.equal(response.headers.get('vary'), null);
  });
});

describe('live HTTP cache-control -- cookie forces private', () => {
  it('page with Set-Cookie gets private, no-store despite cacheControl export', async () => {
    writeFixture(
      fixturesRoot,
      'pages/cookie.mjs',
      'export const cacheControl = { maxAge: 300 };\nexport default () => null;\n',
    );

    const manifest: RouteManifest = discoverRoutes(fixturesRoot);
    const app = await createApp({
      manifest,
      renderer: { render: () => documentOutcome(LARGE_PAGE) },
      contributions: appRoutes((routes) =>
        routes.transform(['page'], (response) => {
          const headers = new Headers(response.headers);
          headers.set('set-cookie', 'session=abc; HttpOnly');
          return new Response(response.body, { status: response.status, headers });
        }),
      ),
    });

    const response = await appRequest(app, '/cookie');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    // Both `Cookie` (the cookie forces it) and `Accept-Encoding` (the body is
    // large enough to encode) must be advertised: the response varies on both.
    const vary = response.headers.get('vary') ?? '';
    assert.ok(vary.includes('Cookie'), `Vary must include Cookie, got "${vary}"`);
    assert.ok(vary.includes('Accept-Encoding'), `Vary must include Accept-Encoding, got "${vary}"`);
  });
});

describe('live HTTP cache-control -- declared public policy is bounded', () => {
  it('answers a failing public API route with private, no-store', async () => {
    writeFixture(
      fixturesRoot,
      'api/flaky.mjs',
      PUBLIC_API +
        "export const cacheControl = { maxAge: 600 };\nexport function GET() { return new Response('upstream down', { status: 503 }); }\n",
    );
    const app = await createApp({ manifest: discoverRoutes(fixturesRoot) });

    const response = await appRequest(app, '/api/flaky');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('surrogate-control'), null);
  });

  it('answers a header-authorized request to a public API route privately', async () => {
    writeFixture(
      fixturesRoot,
      'api/me.mjs',
      PUBLIC_API +
        "export const cacheControl = { maxAge: 600 };\nexport function GET(request) { return Response.json({ caller: request.headers.get('authorization') }); }\n",
    );
    const app = await createApp({ manifest: discoverRoutes(fixturesRoot) });

    const response = await appRequest(app, '/api/me', {
      headers: { authorization: 'Bearer alice' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('surrogate-control'), null);
  });

  it('answers a header-authorized request to a public page privately', async () => {
    writeFixture(
      fixturesRoot,
      'pages/dashboard.mjs',
      'export const cacheControl = { maxAge: 300 };\nexport default () => null;\n',
    );
    const app = await createApp({
      manifest: discoverRoutes(fixturesRoot),
      renderer: { render: () => documentOutcome('<!doctype html><h1>Dashboard</h1>') },
    });

    const response = await appRequest(app, '/dashboard', {
      headers: { authorization: 'Basic YWxpY2U6cHc=' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });

  it('keeps a CORS Vary: Origin when a cookie forces private', async () => {
    const app = await createApp({
      manifest: { entries: [], byRoute: new Map() },
      contributions: appRoutes((routes) =>
        routes.add({
          methods: ['GET'],
          path: '/cors',
          access: OPEN,
          handler: () =>
            new Response('ok', {
              headers: { vary: 'Origin', 'set-cookie': 'session=abc; HttpOnly' },
            }),
        }),
      ),
    });

    const response = await appRequest(app, '/cors');
    const vary = (response.headers.get('vary') ?? '').split(',').map((entry) => entry.trim());
    assert.ok(vary.includes('Origin'), `Vary must keep Origin, got "${vary.join(', ')}"`);
    assert.ok(vary.includes('Cookie'), `Vary must include Cookie, got "${vary.join(', ')}"`);
  });
});
