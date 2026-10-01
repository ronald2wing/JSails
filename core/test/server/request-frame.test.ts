/**
 * The request frame: one claim per request resolves the identity, the locale,
 * and the extension request scopes for every framework route kind (pages, API
 * routes ahead of `authorize`, the server-components transport, and plugin
 * registrar routes), and the guard tier stands in front of everything else. A
 * request no route claims resolves nothing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it, type TestContext } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { serializeContext } from '../../src/context/carrier.js';
import type { Session } from '../../src/contracts/http.js';
import { currentTenantId, runWithTenant } from '../../src/database/tenant-context.js';
import {
  runExtensions,
  type JsailsExtension,
  type RequestScopeSpec,
} from '../../src/extensions/index.js';
import { i18nPlugin } from '../../src/i18n/plugin.js';
import { currentLocale } from '../../src/i18n/request-locale.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import type { RequestErrorInfo } from '../../src/server/request-errors.js';
import { currentRequestFrame, identitySource, type Guard } from '../../src/server/request-frame.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../../src/server-components/protocol.js';
import type { ServerComponentsRuntime } from '../../src/server-components/runtime/index.js';
import { createTestSession } from '../../src/testing/index.js';
import { writeFixture } from '../fixtures/app.js';
import { documentOutcome } from '../../src/pages/page.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'request-frame-'));
after(() => rmSync(root, { recursive: true, force: true }));
const tenantContextUrl = pathToFileURL(join(distDir, 'src', 'database', 'tenant-context.js')).href;
writeFixture(
  root,
  'api/probe.mjs',
  `import { currentTenantId } from ${JSON.stringify(tenantContextUrl)};
export const authorize = () => {
  globalThis.__requestFrameAuthorizeSaw?.push(currentTenantId() ?? null);
  return true;
};
export const GET = () => Response.json({ tenant: currentTenantId() ?? null });
`,
);
writeFixture(
  root,
  'api/whoami.mjs',
  `export const GET = (_request, context) => Response.json({ session: context.session?.id ?? null });
export const authorize = () => true;
`,
);
const manifest = discoverRoutes(root);

/** A component runtime stand-in that reports the ambient tenant from each transport route. */
const tenantAnswer = async (): Promise<Response> =>
  Response.json({ tenant: currentTenantId() ?? null });
const probeRuntime = {
  routes: {
    update: tenantAnswer,
    upload: tenantAnswer,
    download: tenantAnswer,
    uploadBodyBytes: 1024 * 1024,
    laneTotalMs: { update: 30_000, upload: 300_000, download: 600_000 },
  },
} as unknown as ServerComponentsRuntime;

/** Binds the tenant an `x-tenant` header names, for a request with a session. */
const tenantFromHeader: RequestScopeSpec = {
  name: 'tenant',
  cache: 'partition',
  resolve: ({ request, identity }) => {
    const named = request.headers.get('x-tenant');
    if (named === null || identity === null) return undefined;
    return {
      run: (fn) => runWithTenant(named, fn),
      partition: { name: 'tenant', value: named, from: 'header' },
    };
  },
};

interface Harness {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly authorizeSaw: (string | number | null)[];
  readonly sessions: () => number;
  readonly reports: { readonly error: unknown; readonly info: RequestErrorInfo }[];
}

const CREDENTIAL = { cookie: 'sid=1' };

async function harness(
  extensions: readonly JsailsExtension[],
  overrides: Partial<AppOptions> = {},
): Promise<Harness> {
  const runtime = await runExtensions(
    [
      {
        name: 'components',
        setup: ({ services }) => services.provide(serverComponentsToken, probeRuntime),
      },
      ...extensions,
      {
        name: 'plugin',
        setup: ({ routes }) => {
          const access = publicAccess('request frame probe');
          routes.add({
            methods: ['GET'],
            path: '/plugin/probe',
            access,
            middleware: [
              async (_context, next) => {
                const tenant = String(currentTenantId() ?? 'none');
                const response = await next();
                const headers = new Headers(response.headers);
                headers.set('x-middleware-tenant', tenant);
                return new Response(response.body, { status: response.status, headers });
              },
            ],
            handler: () => Response.json({ tenant: currentTenantId() ?? null }),
          });
          routes.add({
            methods: ['GET'],
            path: '/plugin/frame',
            access,
            handler: ({ session }) => {
              const frame = currentRequestFrame();
              return Response.json({
                session: session?.id ?? null,
                frameSession: frame?.requestContext().session?.id ?? null,
                route: frame?.route?.meta ?? null,
              });
            },
          });
        },
      },
    ],
    { rootDir: import.meta.dirname },
  );
  // The probe route's access check records the tenant it saw here.
  const authorizeSaw: (string | number | null)[] = [];
  (globalThis as { __requestFrameAuthorizeSaw?: unknown }).__requestFrameAuthorizeSaw =
    authorizeSaw;
  const reports: { error: unknown; info: RequestErrorInfo }[] = [];
  let sessions = 0;
  const session: Session = createTestSession({ id: 's1', data: { userId: 'u1' } });
  const app = await createApp({
    manifest,
    services: runtime.services,
    contributions: { routes: runtime.routes, transforms: runtime.transforms },
    requestScopes: runtime.requestScopes,
    guards: runtime.guards,
    resolveSession: (request) => {
      sessions += 1;
      return request.headers.has('x-anonymous') ? null : session;
    },
    renderer: { render: () => documentOutcome(String(currentTenantId() ?? 'none')) },
    onError: (error, info) => {
      reports.push({ error, info });
    },
    ...overrides,
  });
  return {
    authorizeSaw,
    reports,
    sessions: () => sessions,
    fetch: (path, init) => Promise.resolve(app.fetch(new Request(`http://localhost${path}`, init))),
  };
}

const scopeExtension = (scope: RequestScopeSpec, name = 'scope'): JsailsExtension => ({
  name,
  setup: ({ configureRequestScope }) => configureRequestScope(scope),
});

async function tenantOf(response: Response): Promise<unknown> {
  assert.equal(response.status, 200);
  return ((await response.json()) as { tenant: unknown }).tenant;
}

describe('request scopes', () => {
  it('bind the API route, its authorize gate, the component transport, and plugin routes', async () => {
    const { fetch, authorizeSaw } = await harness([scopeExtension(tenantFromHeader)]);
    const headers = { ...CREDENTIAL, 'x-tenant': 'acme' };

    assert.equal(await tenantOf(await fetch('/api/probe', { headers })), 'acme');
    assert.deepEqual(authorizeSaw, ['acme']);
    assert.equal(await tenantOf(await fetch('/plugin/probe', { headers })), 'acme');
    const json = { ...headers, origin: 'http://localhost', 'content-type': 'application/json' };
    for (const path of [COMPONENT_UPDATE_ENDPOINT, COMPONENT_UPLOAD_ENDPOINT]) {
      assert.equal(
        await tenantOf(await fetch(path, { method: 'POST', headers: json, body: '{}' })),
        'acme',
        path,
      );
    }
    assert.equal(await tenantOf(await fetch(COMPONENT_DOWNLOAD_ENDPOINT, { headers })), 'acme');
  });

  it('bind page routes', async (t: TestContext) => {
    const pageRoot = mkdtempSync(join(distDir, 'request-frame-page-'));
    t.after(() => rmSync(pageRoot, { recursive: true, force: true }));
    writeFixture(pageRoot, 'pages/index.mjs', 'export default () => null;\n');
    const { fetch } = await harness([scopeExtension(tenantFromHeader)], {
      manifest: discoverRoutes(pageRoot),
    });
    const response = await fetch('/', { headers: { ...CREDENTIAL, 'x-tenant': 'acme' } });
    assert.equal(await response.text(), 'acme');
  });

  it('bind nothing when a scope resolves to undefined', async () => {
    const { fetch } = await harness([scopeExtension(tenantFromHeader)]);
    const headers = { ...CREDENTIAL, 'x-tenant': 'acme', 'x-anonymous': '1' };
    assert.equal(await tenantOf(await fetch('/api/probe', { headers })), null);
    assert.equal(await tenantOf(await fetch('/plugin/probe', { headers })), null);
    assert.equal(await tenantOf(await fetch(COMPONENT_DOWNLOAD_ENDPOINT, { headers })), null);
  });

  it("bind a plugin route's own middleware, and leave unclaimed requests unresolved", async () => {
    let resolves = 0;
    const counting: RequestScopeSpec = {
      ...tenantFromHeader,
      resolve: (request) => {
        resolves += 1;
        return tenantFromHeader.resolve(request);
      },
    };
    const { fetch } = await harness([scopeExtension(counting)]);
    const response = await fetch('/plugin/probe', {
      headers: { ...CREDENTIAL, 'x-tenant': 'acme' },
    });
    assert.equal(response.headers.get('x-middleware-tenant'), 'acme');
    assert.equal(resolves, 1);
    assert.equal((await fetch('/nowhere', { headers: CREDENTIAL })).status, 404);
    assert.equal(resolves, 1);
  });

  it('resolve once per request in registration order, each inside the earlier bindings', async () => {
    const order: string[] = [];
    const named = (name: string, cache: 'private' | 'transparent'): RequestScopeSpec => ({
      name,
      cache,
      resolve: () => {
        order.push(`${name}:resolve:${String(currentTenantId() ?? 'none')}`);
        return {
          run: (fn) => {
            order.push(`${name}:bind`);
            return name === 'first' ? runWithTenant('outer', fn) : fn();
          },
        };
      },
    });
    const { fetch } = await harness([
      scopeExtension(named('first', 'private'), 'first'),
      scopeExtension(named('second', 'transparent'), 'second'),
    ]);
    assert.equal(await tenantOf(await fetch('/api/probe')), 'outer');
    assert.deepEqual(order, [
      'first:resolve:none',
      'first:bind',
      'second:resolve:outer',
      'first:bind',
      'second:bind',
    ]);
  });

  it('answer the request with the Response a scope resolves to', async () => {
    const redirecting: RequestScopeSpec = {
      name: 'canonical-host',
      cache: 'transparent',
      resolve: () => new Response(null, { status: 308, headers: { location: 'https://a.test/' } }),
    };
    const { fetch, authorizeSaw } = await harness([scopeExtension(redirecting)]);
    for (const path of ['/api/probe', '/plugin/probe', COMPONENT_DOWNLOAD_ENDPOINT]) {
      const response = await fetch(path);
      assert.equal(response.status, 308, path);
      assert.equal(response.headers.get('location'), 'https://a.test/');
    }
    assert.deepEqual(authorizeSaw, []);
  });

  it('fail the request value-free when a scope throws or breaks its cache class', async () => {
    const throwing: RequestScopeSpec = {
      name: 'throwing',
      cache: 'transparent',
      resolve: () => {
        throw new Error('scope store down');
      },
    };
    const failing = await harness([scopeExtension(throwing)]);
    const response = await failing.fetch('/api/probe');
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /scope store down/);
    assert.equal(failing.reports.length, 1);
    assert.equal(failing.reports[0]?.info.route, '/api/probe');

    const unpartitioned: RequestScopeSpec = {
      name: 'unpartitioned',
      cache: 'partition',
      resolve: () => ({ run: (fn) => fn() }),
    };
    const broken = await harness([scopeExtension(unpartitioned)]);
    assert.equal((await broken.fetch('/plugin/probe')).status, 500);
    assert.deepEqual(
      broken.reports.map(({ error }) => (error as { code?: unknown }).code),
      ['request_scope.invalid_binding'],
    );
  });

  it('are validated by createApp and only registrable during setup', async () => {
    await assert.rejects(createApp({ manifest, requestScopes: 'nope' as never }), {
      code: 'request_scope.invalid_scope',
    });
    await assert.rejects(
      createApp({
        manifest,
        requestScopes: [{ name: 'Bad Name', cache: 'transparent', resolve: () => undefined }],
      }),
      { code: 'request_scope.invalid_scope' },
    );
    await assert.rejects(
      createApp({ manifest, requestScopes: [{ ...tenantFromHeader, cache: 'shared' as never }] }),
      { code: 'request_scope.invalid_scope' },
    );
    await assert.rejects(
      createApp({ manifest, requestScopes: [tenantFromHeader, tenantFromHeader] }),
      { code: 'request_scope.duplicate_scope' },
    );
    await assert.rejects(
      runExtensions(
        [
          {
            name: 'bad',
            setup: ({ configureRequestScope }) => configureRequestScope((async () => {}) as never),
          },
        ],
        { rootDir: import.meta.dirname },
      ),
      { code: 'extension.invalid_hook' },
    );
    let leaked: ((scope: RequestScopeSpec) => void) | undefined;
    const runtime = await runExtensions(
      [
        {
          name: 'leaky',
          setup: ({ configureRequestScope }) => {
            leaked = configureRequestScope;
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );
    assert.deepEqual(runtime.requestScopes, []);
    assert.throws(() => leaked?.(tenantFromHeader), { code: 'extension.sealed' });
  });
});

describe('the identity', () => {
  it('is resolved through a bare resolveSession wherever it reads the credential', async () => {
    let resolved = 0;
    const { fetch } = await harness([], {
      resolveSession: (request) => {
        resolved += 1;
        return request.headers.get('x-api-token') === 'Bearer t1'
          ? createTestSession({ id: 'tok' })
          : null;
      },
    });
    // A resolver may read any header (an auth plugin's `apiTokens.headerName`),
    // so no request a route claims is skipped as anonymous.
    const token = await fetch('/api/whoami', { headers: { 'x-api-token': 'Bearer t1' } });
    assert.deepEqual(await token.json(), { session: 'tok' });
    assert.deepEqual(await (await fetch('/api/whoami')).json(), { session: null });
    assert.equal(resolved, 2);
    assert.equal((await fetch('/nowhere')).status, 404);
    assert.equal(resolved, 2, 'a request no route claims resolves nothing');
  });

  it('is never resolved for a request without a declared credential', async () => {
    let resolved = 0;
    const { fetch } = await harness([], {
      resolveSession: undefined,
      identity: identitySource({
        cookies: ['sid'],
        headers: ['X-Api-Token'],
        resolve: (request) => {
          resolved += 1;
          return createTestSession({ id: request.headers.has('x-api-token') ? 'tok' : 'sid' });
        },
      }),
    });
    const anonymous: readonly Record<string, string>[] = [
      {},
      { cookie: 'theme=dark' },
      { cookie: 'sid=' },
      { cookie: 'xsid=1; sidx=1' },
      { 'x-api-token': '  ' },
      { authorization: 'Bearer undeclared' },
    ];
    for (const headers of anonymous) {
      const response = await fetch('/api/whoami', { headers });
      assert.deepEqual(await response.json(), { session: null }, JSON.stringify(headers));
    }
    assert.equal(resolved, 0);
    const cookie = await fetch('/api/whoami', { headers: { cookie: 'theme=dark; sid=1' } });
    assert.deepEqual(await cookie.json(), { session: 'sid' });
    const header = await fetch('/api/whoami', { headers: { 'X-API-TOKEN': 'Bearer t1' } });
    assert.deepEqual(await header.json(), { session: 'tok' });
    assert.equal(resolved, 2);
  });

  it('is declared with a resolver and at least one valid credential name', () => {
    const resolve = (): null => null;
    for (const options of [
      { resolve },
      { resolve, cookies: [], headers: [] },
      { resolve, cookies: ['secret name'] },
      { resolve, headers: ['secret:header'] },
      { resolve, cookies: 'sid' },
      { resolve, headers: [''] },
      { cookies: ['sid'] },
    ]) {
      assert.throws(
        () => identitySource(options as never),
        (error: unknown) => {
          assert.equal((error as { code?: unknown }).code, 'request_frame.invalid_identity_source');
          assert.doesNotMatch(String((error as Error).message), /secret/);
          return true;
        },
      );
    }
    assert.equal(Object.isFrozen(identitySource({ resolve, headers: ['x-key'] })), true);
  });

  it('fails closed and is reported when the credential test throws', async () => {
    let asked = 0;
    const { fetch, reports } = await harness([], {
      resolveSession: undefined,
      identity: {
        hasCredential: () => {
          asked += 1;
          throw new Error('credential secret');
        },
        resolve: () => createTestSession({ id: 'never' }),
      },
    });
    // A request no route claims never asks the source.
    assert.equal((await fetch('/nowhere', { headers: CREDENTIAL })).status, 404);
    assert.equal(asked, 0);
    const response = await fetch('/api/whoami', { headers: CREDENTIAL });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { session: null });
    assert.equal(asked, 1);
    assert.deepEqual(
      reports.map(({ info }) => info.phase),
      ['session'],
    );
  });

  it('is resolved once per credentialed request, for every route kind', async () => {
    const { fetch, sessions } = await harness([]);
    assert.deepEqual(await (await fetch('/api/whoami', { headers: CREDENTIAL })).json(), {
      session: 's1',
    });
    assert.equal(sessions(), 1);
    const plugin = (await (await fetch('/plugin/frame', { headers: CREDENTIAL })).json()) as {
      session: string | null;
      frameSession: string | null;
      route: unknown;
    };
    assert.equal(plugin.session, 's1');
    assert.equal(plugin.frameSession, 's1');
    assert.deepEqual(plugin.route, {
      kind: 'api',
      pattern: '/plugin/frame',
      methods: ['GET'],
      access: { kind: 'public', reason: 'request frame probe' },
      credentials: ['cookie'],
      surface: 'route',
      owner: 'plugin',
      origin: 'code-plugin',
    });
    assert.equal(sessions(), 2);
  });

  it('fails closed and is reported when the source throws', async () => {
    const { fetch, reports } = await harness([], {
      resolveSession: () => {
        throw new Error('session store down');
      },
    });
    const response = await fetch('/api/whoami', { headers: CREDENTIAL });
    assert.deepEqual(await response.json(), { session: null });
    assert.deepEqual(
      reports.map(({ info }) => info.phase),
      ['session'],
    );
  });

  it('takes an identity source that decides which requests carry a credential', async () => {
    let resolved = 0;
    const { fetch } = await harness([], {
      resolveSession: undefined,
      identity: {
        hasCredential: (request) => request.headers.has('x-api-key'),
        resolve: () => {
          resolved += 1;
          return createTestSession({ id: 'key' });
        },
      },
    });
    assert.deepEqual(await (await fetch('/api/whoami', { headers: CREDENTIAL })).json(), {
      session: null,
    });
    assert.equal(resolved, 0);
    const keyed = await fetch('/api/whoami', { headers: { 'x-api-key': 'k' } });
    assert.deepEqual(await keyed.json(), { session: 'key' });
    assert.equal(resolved, 1);
  });

  it('is configured by exactly one of resolveSession and identity', async () => {
    await assert.rejects(
      createApp({
        manifest,
        resolveSession: () => null,
        identity: { hasCredential: () => false, resolve: () => null },
      }),
      /mutually exclusive/,
    );
    await assert.rejects(
      createApp({ manifest, identity: { resolve: () => null } as never }),
      /identity must implement/,
    );
  });
});

describe('the locale', () => {
  it('is settled on the request context and carried to jobs', async () => {
    const runtime = await runExtensions(
      [
        i18nPlugin({ locale: 'en', catalogs: { en: {}, fr: {} }, resolveLocale: () => 'fr' }),
        {
          name: 'probe',
          setup: ({ routes }) =>
            routes.add({
              methods: ['GET'],
              path: '/locale',
              access: publicAccess('locale probe'),
              handler: ({ locale }) =>
                Response.json({
                  context: locale ?? null,
                  ambient: currentLocale() ?? null,
                  carried: serializeContext()?.values?.['jsails.locale'] ?? null,
                }),
            }),
        },
      ],
      { rootDir: import.meta.dirname },
    );
    const app = await createApp({
      manifest,
      services: runtime.services,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
    });
    const response = await app.fetch(new Request('http://localhost/locale'));
    assert.deepEqual(await response.json(), { context: 'fr', ambient: 'fr', carried: 'fr' });
  });
});

describe('the frame stage', () => {
  it('answers and reports a failure before the frame exists', async () => {
    const reports: { error: unknown; info: RequestErrorInfo }[] = [];
    const app = await createApp({
      manifest,
      onError: (error, info) => {
        reports.push({ error, info });
      },
      errorPage: () => '<p>app error page</p>',
    });
    const request = new Request('http://localhost/api/probe', {
      headers: { forwarded: 'for=203.0.113.9', accept: 'text/html' },
    });
    // Canonicalizing the forwarding headers is the frame stage's own work;
    // a throw there leaves no frame for `onError` to report through.
    request.headers.delete = () => {
      throw new Error('frame secret');
    };
    const response = await app.fetch(request);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.doesNotMatch(body, /frame secret/);
    assert.deepEqual(Object.keys(JSON.parse(body) as object), ['type', 'title', 'status']);
    assert.equal(response.headers.get('content-type'), 'application/problem+json');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    const id = response.headers.get('x-request-id');
    assert.ok(id);
    assert.deepEqual(
      reports.map(({ error, info }) => [(error as Error).message, info]),
      [['frame secret', { phase: 'frame', method: 'GET', route: '*', requestId: id }]],
    );
  });
});

describe('the request context', () => {
  it('cannot be read before the request is claimed', async () => {
    const seen: unknown[] = [];
    // A guard runs before any route claims the request.
    const app = await createApp({
      manifest,
      guards: [
        () => {
          try {
            currentRequestFrame()?.requestContext();
          } catch (error) {
            seen.push((error as { code?: unknown }).code);
          }
          return undefined;
        },
      ],
    });
    await app.fetch(new Request('http://localhost/api/probe'));
    assert.deepEqual(seen, ['request_frame.unclaimed']);
  });
});

describe('guards', () => {
  const wall: Guard = (request) =>
    request.headers.get('x-wall') === 'deny'
      ? new Response('refused', { status: 401, headers: { 'www-authenticate': 'Basic' } })
      : undefined;

  it('refuse a request before the body limit, a route, or a 404', async () => {
    const { fetch, sessions } = await harness([], {
      guards: [wall],
      maxBodyBytes: 4,
      healthPath: '/up',
    });
    const deny = { 'x-wall': 'deny', ...CREDENTIAL };
    for (const path of ['/api/probe', '/plugin/probe', '/nowhere']) {
      const response = await fetch(path, { headers: deny });
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('x-request-id'));
    }
    const oversized = await fetch('/api/probe', {
      method: 'POST',
      headers: { ...deny, 'content-length': '100' },
      body: 'x'.repeat(100),
    });
    assert.equal(oversized.status, 401);
    assert.equal(sessions(), 0);
    assert.equal((await fetch('/api/probe')).status, 200);
  });

  it('let the health and readiness probes through unasked', async () => {
    let asked = 0;
    // The documented staging wall: no Basic credential, no entry. A deploy
    // tool's probe carries none.
    const stagingWall: Guard = (request) => {
      asked += 1;
      return request.headers.get('authorization') === 'Basic c3RhZ2luZw=='
        ? undefined
        : new Response('Authentication required', { status: 401 });
    };
    const { fetch } = await harness([], {
      guards: [stagingWall],
      healthPath: '/up',
      readiness: { path: '/ready', probes: { ok: () => true } },
    });
    for (const [path, method] of [
      ['/up', 'GET'],
      ['/up', 'HEAD'],
      ['/up?deep=1', 'GET'],
      ['/ready', 'GET'],
    ] as const) {
      assert.equal((await fetch(path, { method })).status, 200, `${method} ${path}`);
    }
    assert.equal(asked, 0);
    // Only a probe passes: another method on the probe path, and a path that
    // merely starts like it, are guarded.
    assert.equal((await fetch('/up', { method: 'POST' })).status, 401);
    assert.equal((await fetch('/up/')).status, 401);
    assert.equal((await fetch('/upx')).status, 401);
    assert.equal(asked, 3);
  });

  it('answer with a fetched response whose headers are immutable', async (t: TestContext) => {
    const upstream: Server = createServer((_request, response) => {
      response.writeHead(401, { 'cache-control': 'no-cache', 'www-authenticate': 'Bearer' });
      response.end('upstream says no');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => upstream.close());
    const { port } = upstream.address() as AddressInfo;
    const { fetch, reports } = await harness([], {
      // An external auth check whose answer the guard hands back as it came.
      guards: [() => globalThis.fetch(`http://127.0.0.1:${port}/check`)],
    });
    const response = await fetch('/api/probe');
    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'upstream says no');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('x-request-id'));
    assert.deepEqual(reports, []);
  });

  it('receive the request id and the resolved client', async () => {
    const seen: { id: string; via: string }[] = [];
    const { fetch } = await harness([], {
      guards: [
        (_request, info) => {
          seen.push({ id: info.id, via: info.client.via });
          return undefined;
        },
      ],
    });
    const response = await fetch('/api/probe');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.id, response.headers.get('x-request-id'));
  });

  it('run in order, the first answer winning, after the extension guards are added', async () => {
    const order: string[] = [];
    const named =
      (name: string, answer?: number): Guard =>
      () => {
        order.push(name);
        return answer === undefined ? undefined : new Response(null, { status: answer });
      };
    const { fetch } = await harness(
      [{ name: 'walls', setup: ({ configureGuard }) => configureGuard(named('extension', 403)) }],
      {},
    );
    assert.equal((await fetch('/api/probe')).status, 403);
    assert.deepEqual(order, ['extension']);
    order.length = 0;
    const both = await harness([], { guards: [named('config'), named('second', 451)] });
    assert.equal((await both.fetch('/api/probe')).status, 451);
    assert.deepEqual(order, ['config', 'second']);
  });

  it('fail the request value-free when a guard throws or answers something else', async () => {
    const throwing = await harness([], {
      guards: [
        () => {
          throw new Error('guard secret');
        },
      ],
    });
    const response = await throwing.fetch('/api/probe');
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /guard secret/);
    assert.deepEqual(
      throwing.reports.map(({ info }) => info.phase),
      ['guard'],
    );
    const odd = await harness([], { guards: [(() => 'yes') as unknown as Guard] });
    assert.equal((await odd.fetch('/api/probe')).status, 500);
    assert.deepEqual(
      odd.reports.map(({ error }) => (error as { code?: unknown }).code),
      ['request_frame.invalid_guard_result'],
    );
  });

  it('are validated by createApp and by configureGuard', async () => {
    await assert.rejects(createApp({ manifest, guards: [1] as never }), /guards must be/);
    await assert.rejects(
      runExtensions([{ name: 'bad', setup: ({ configureGuard }) => configureGuard({} as never) }], {
        rootDir: import.meta.dirname,
      }),
      { code: 'extension.invalid_hook' },
    );
  });
});
