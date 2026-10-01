/**
 * The HTTP registrar: what `add`, `mount`, `guard` and `transform` accept,
 * the grants and confinement the host sets, and how assembly serves what it
 * collected (the route boundary, the gate, mounts, transforms).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import type { ServerComponentsRuntime } from '../../src/server-components/runtime/index.js';
import { createApp } from '../../src/server/app.js';
import type { BodySpec } from '../../src/server/route-limits.js';
import { createHttpRoutes, type HttpRoutesOptions } from '../../src/server/http-routes.js';
import { RouteErrors } from '../../src/server/route-meta.js';
import { surfacesOf } from '../../src/security/surfaces.js';
import { TEST_ORIGIN } from '../fixtures/app.js';

const OPEN = publicAccess('test route');
const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] } as const;

function registrar(overrides: Partial<HttpRoutesOptions> = {}) {
  return createHttpRoutes({
    owner: 'acme',
    origin: 'code-plugin',
    allow: { mount: true, guard: true, transform: true },
    ...overrides,
  });
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    assert.ok(RouteErrors.is(error), 'a registrar failure is a route error');
    return error.code;
  }
  return undefined;
}

const ok = () => new Response('ok');

describe('createHttpRoutes', () => {
  it('stamps each route with its owner, origin and defaults', () => {
    const { routes, contributions } = registrar();
    routes.add({ methods: ['GET'], path: '/acme/items', access: OPEN, handler: ok });
    const [route] = contributions().routes;
    assert.equal(route?.type, 'route');
    assert.equal(route?.owner, 'acme');
    assert.equal(route?.origin, 'code-plugin');
    assert.deepEqual(route?.type === 'route' ? route.credentials : undefined, ['cookie']);
  });

  it('stamps the surface kind, route unless stated, and refuses any other', () => {
    const { routes, contributions } = registrar();
    routes.add({ methods: ['GET'], path: '/acme/a', access: OPEN, handler: ok });
    routes.add({ methods: ['GET'], path: '/acme/b', access: OPEN, surface: 'admin', handler: ok });
    routes.add({
      methods: ['POST'],
      path: '/acme/c',
      access: OPEN,
      surface: 'webhook',
      credentials: [],
      handler: ok,
    });
    assert.deepEqual(
      contributions().routes.map((route) => (route.type === 'route' ? route.surface : undefined)),
      ['route', 'admin', 'webhook'],
    );
    for (const surface of ['page', 'component', 'asset', '']) {
      assert.equal(
        codeOf(() =>
          routes.add({
            methods: ['GET'],
            path: '/acme/d',
            access: OPEN,
            surface: surface as never,
            handler: ok,
          }),
        ),
        'route.invalid_route',
        surface,
      );
    }
  });

  it('requires an access reference', () => {
    const { routes } = registrar();
    assert.equal(
      codeOf(() =>
        // @ts-expect-error a route states who may reach it: `access` is required
        routes.add({ methods: ['GET'], path: '/x', handler: ok }),
      ),
      'route.invalid_route',
    );
    assert.equal(
      codeOf(() =>
        routes.add({
          methods: ['GET'],
          path: '/x',
          access: { kind: 'public' } as never,
          handler: ok,
        }),
      ),
      'route.invalid_route',
    );
  });

  it('refuses invalid paths and methods', () => {
    const { routes } = registrar();
    const add = (path: string, methods: readonly string[] = ['GET']) =>
      codeOf(() => routes.add({ methods: methods as never, path, access: OPEN, handler: ok }));
    assert.equal(add('relative'), 'route.invalid_path');
    assert.equal(add('/trailing/'), 'route.invalid_path');
    assert.equal(add('/a//b'), 'route.invalid_path');
    assert.equal(add('/q?x=1'), 'route.invalid_path');
    assert.equal(add('/x', []), 'route.invalid_route');
    assert.equal(add('/x', ['HEAD']), 'route.invalid_route');
    assert.equal(add('/x', ['GET', 'GET']), 'route.invalid_route');
  });

  it('accepts a cache declaration only on a GET route', () => {
    const { routes } = registrar();
    const cache = { maxAge: 60 } as never;
    assert.equal(
      codeOf(() => routes.add({ methods: ['POST'], path: '/x', access: OPEN, cache, handler: ok })),
      'route.invalid_route',
    );
  });

  it('enforces the grants and the confinement', () => {
    const { routes } = registrar({
      allow: { mount: false, guard: false, transform: false },
      confine: ['/acme'],
    });
    assert.equal(
      codeOf(() => routes.mount('/acme/app', ok, { access: OPEN })),
      'route.not_granted',
    );
    assert.equal(
      codeOf(() => routes.guard(() => undefined)),
      'route.not_granted',
    );
    assert.equal(
      codeOf(() => routes.transform(['api'], (r) => r)),
      'route.not_granted',
    );
    assert.equal(
      codeOf(() => routes.add({ methods: ['GET'], path: '/other', access: OPEN, handler: ok })),
      'route.outside_confinement',
    );
    routes.add({ methods: ['GET'], path: '/acme/items', access: OPEN, handler: ok });
  });

  it('never mounts at the root or under a parameter', () => {
    const { routes } = registrar();
    for (const prefix of ['/', '/:tenant', '/files/*']) {
      assert.equal(
        codeOf(() => routes.mount(prefix, ok, { access: OPEN })),
        'route.invalid_path',
      );
    }
  });

  it('transforms only the kinds a boundary answers for app or plugin code', () => {
    const { routes } = registrar();
    for (const kinds of [['hook'], ['framework'], ['api', 'hook'], [], ['api', 'api']]) {
      assert.equal(
        codeOf(() => routes.transform(kinds as never, (r) => r)),
        'route.invalid_route',
      );
    }
    routes.transform(['api', 'page', 'component', 'mount'], (r) => r);
  });
});

describe('registrar routes in an app', () => {
  it('serves a route behind the boundary with its access and middleware', async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    const seen: string[] = [];
    routes.add({
      methods: ['GET', 'POST'],
      path: '/items/:id',
      access: ({ request }) => request.headers.get('x-allow') === '1',
      middleware: [
        async (_context, next) => {
          seen.push('middleware');
          return next();
        },
      ],
      handler: ({ params }) => {
        seen.push('handler');
        return Response.json({ id: params.id });
      },
    });
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });

    const denied = await app.fetch(new Request(`${TEST_ORIGIN}/items/7`));
    assert.equal(denied.status, 401);
    assert.deepEqual(seen, [], 'nothing of the route runs before the gate allows');

    const allowed = await app.fetch(
      new Request(`${TEST_ORIGIN}/items/7`, { headers: { 'x-allow': '1' } }),
    );
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { id: '7' });
    assert.deepEqual(seen, ['middleware', 'handler']);

    const head = await app.fetch(
      new Request(`${TEST_ORIGIN}/items/7`, { method: 'HEAD', headers: { 'x-allow': '1' } }),
    );
    assert.equal(head.status, 200);

    const other = await app.fetch(new Request(`${TEST_ORIGIN}/items/7`, { method: 'DELETE' }));
    assert.equal(other.status, 405);
    assert.equal(other.headers.get('allow'), 'GET, HEAD, POST');
  });

  it('mounts a fetch handler under its prefix, behind the gate', async () => {
    const { routes, contributions } = registrar();
    routes.mount(
      '/acme',
      (request) => new Response(`${request.method} ${new URL(request.url).pathname}`),
      { access: ({ request }) => request.headers.get('x-allow') === '1' },
    );
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
    const headers = { 'x-allow': '1', origin: TEST_ORIGIN };
    const base = await app.fetch(new Request(`${TEST_ORIGIN}/acme`, { headers }));
    assert.equal(await base.text(), 'GET /acme');
    const deep = await app.fetch(
      new Request(`${TEST_ORIGIN}/acme/a/b`, { method: 'PUT', headers }),
    );
    assert.equal(await deep.text(), 'PUT /acme/a/b');
    const denied = await app.fetch(new Request(`${TEST_ORIGIN}/acme/a`));
    assert.equal(denied.status, 401);
  });

  it('applies a transform to the answers of its kinds only', async () => {
    const { routes, contributions } = registrar();
    routes.add({ methods: ['GET'], path: '/acme/items', access: OPEN, handler: ok });
    routes.mount('/acme/raw', ok, { access: OPEN });
    routes.transform(['api'], (response) => {
      const headers = new Headers(response.headers);
      headers.set('x-transformed', '1');
      return new Response(response.body, { status: response.status, headers });
    });
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
    const route = await app.fetch(new Request(`${TEST_ORIGIN}/acme/items`));
    assert.equal(route.headers.get('x-transformed'), '1');
    const mount = await app.fetch(new Request(`${TEST_ORIGIN}/acme/raw`));
    assert.equal(mount.headers.get('x-transformed'), null);
  });

  it('refuses a cross-site unsafe request on a cookie route, and not on a credential-free one', async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    routes.add({ methods: ['POST'], path: '/items', access: OPEN, handler: ok });
    routes.add({ methods: ['POST'], path: '/hooks', access: OPEN, credentials: [], handler: ok });
    const app = await createApp({
      manifest: EMPTY_MANIFEST,
      contributions: contributions(),
      resolveSession: () => ({ id: 's1', data: {} }) as never,
    });
    const crossSite = {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie: 'sid=1' },
    };
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/items`, crossSite))).status, 403);
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/hooks`, crossSite))).status, 200);
    // Anonymous: the check does not depend on a session.
    const anonymous = { method: 'POST', headers: { origin: 'https://evil.example' } };
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/items`, anonymous))).status, 403);
  });

  it('lists each route under its stated surface kind in the surface registry', async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    routes.add({ methods: ['GET'], path: '/panel', access: OPEN, surface: 'admin', handler: ok });
    routes.add({ methods: ['GET'], path: '/plain', access: OPEN, handler: ok });
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
    const surfaces = surfacesOf(app);
    assert.equal(surfaces?.get('GET /panel')?.kind, 'admin');
    assert.equal(surfaces?.get('GET /plain')?.kind, 'route');
  });

  it('settles the session for a registrar route in an app with no request scopes', async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    routes.add({
      methods: ['GET'],
      path: '/whoami',
      access: OPEN,
      handler: ({ session }) => Response.json({ session: session?.id ?? null }),
    });
    const app = await createApp({
      manifest: EMPTY_MANIFEST,
      contributions: contributions(),
      resolveSession: (request) =>
        request.headers.get('cookie') === 'sid=1' ? ({ id: 's1', data: {} } as never) : null,
    });
    const signedIn = await app.fetch(
      new Request(`${TEST_ORIGIN}/whoami`, { headers: { cookie: 'sid=1' } }),
    );
    assert.deepEqual(await signedIn.json(), { session: 's1' });
    const anonymous = await app.fetch(new Request(`${TEST_ORIGIN}/whoami`));
    assert.deepEqual(await anonymous.json(), { session: null });
  });

  it('refuses credentials that are not distinct cookie and token entries', () => {
    const { routes } = registrar();
    for (const credentials of [['cookie', 'cookie'], ['session'], 'cookie']) {
      assert.equal(
        codeOf(() =>
          routes.add({
            methods: ['POST'],
            path: '/acme/x',
            access: OPEN,
            credentials: credentials as never,
            handler: ok,
          }),
        ),
        'route.invalid_route',
      );
    }
  });

  it('accepts a check function as access and denies unless it returns exactly true', async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    routes.add({
      methods: ['GET'],
      path: '/checked',
      access: ({ url }) => url.searchParams.get('ok') === '1',
      handler: ok,
    });
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/checked?ok=1`))).status, 200);
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/checked`))).status, 401);
  });

  it("fails assembly on a managed plugin's route unless the app allows managed origins", async () => {
    const { routes, contributions } = registrar({
      owner: 'shop',
      origin: 'managed-plugin',
      allow: { mount: false, guard: true, transform: true },
    });
    routes.add({ methods: ['GET'], path: '/shop', access: OPEN, handler: ok });
    await assert.rejects(
      createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() }),
      (error: unknown) => RouteErrors.is(error, 'managed_origin_refused'),
    );
    const app = await createApp({
      manifest: EMPTY_MANIFEST,
      contributions: contributions(),
      pluginOrigins: 'allow-managed',
    });
    assert.equal((await app.fetch(new Request(`${TEST_ORIGIN}/shop`))).status, 200);
  });

  it('fails assembly on a transform for a kind no boundary transforms', async () => {
    const transform = { owner: 'acme', origin: 'code-plugin', transform: ok } as const;
    for (const kinds of [['hook'], ['framework']]) {
      await assert.rejects(
        createApp({
          manifest: EMPTY_MANIFEST,
          contributions: { routes: [], transforms: [{ ...transform, kinds: kinds as never }] },
        }),
        (error: unknown) => RouteErrors.is(error, 'invalid_route'),
      );
    }
  });

  it("fails assembly on a managed plugin's transform unless the app allows managed origins", async () => {
    const { routes, contributions } = registrar({
      owner: 'shop',
      origin: 'managed-plugin',
      allow: { mount: false, guard: true, transform: true },
    });
    routes.transform(['api'], (response) => response);
    await assert.rejects(
      createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() }),
      (error: unknown) => RouteErrors.is(error, 'managed_transform_refused'),
    );
    await createApp({
      manifest: EMPTY_MANIFEST,
      contributions: contributions(),
      pluginOrigins: 'allow-managed',
    });
  });

  it("caps a route's request body at its declared limit", async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    routes.add({
      methods: ['POST'],
      path: '/small',
      access: OPEN,
      credentials: [],
      body: { kind: 'raw', maxBytes: 8 },
      handler: async ({ body }) => new Response(`${(await body.bytes()).byteLength}`),
    });
    for (const body of [
      { kind: 'raw', maxBytes: 0 },
      { kind: 'raw' },
      { kind: 'csv', maxBytes: 8 },
    ]) {
      assert.equal(
        codeOf(() =>
          routes.add({
            methods: ['POST'],
            path: '/bad',
            access: OPEN,
            body: body as BodySpec,
            handler: ok,
          }),
        ),
        'route.invalid_route',
      );
    }
    assert.equal(
      codeOf(() =>
        routes.add({ methods: ['POST'], path: '/bad', access: OPEN, timeoutMs: -1, handler: ok }),
      ),
      'route.invalid_route',
    );
    const app = await createApp({ manifest: EMPTY_MANIFEST, contributions: contributions() });
    const post = (body: string) =>
      app.fetch(new Request(`${TEST_ORIGIN}/small`, { method: 'POST', body }));
    const small = await post('tiny');
    assert.equal(small.status, 200);
    assert.equal(await small.text(), '4');
    assert.equal((await post('far more than eight bytes')).status, 413);
  });

  it('fails assembly on a route at a reserved path', async () => {
    const { routes, contributions } = registrar({ origin: 'app', owner: 'app' });
    routes.add({ methods: ['GET'], path: '/up', access: OPEN, handler: ok });
    await assert.rejects(
      createApp({ manifest: EMPTY_MANIFEST, contributions: contributions(), healthPath: '/up' }),
      (error: unknown) => RouteErrors.is(error, 'reserved_path'),
    );
  });
});

describe('route precedence', () => {
  const lane = (name: string) => () => new Response(name);
  const componentServices = () => {
    const controller = createServiceRegistry();
    controller.registrar.provide(serverComponentsToken, {
      routes: {
        update: lane('update'),
        upload: lane('upload'),
        download: lane('download'),
        uploadBodyBytes: 1024 * 1024,
        laneTotalMs: { update: 30_000, upload: 300_000, download: 600_000 },
      },
    } as unknown as ServerComponentsRuntime);
    return controller.services;
  };
  const text = async (response: Response) => `${response.status} ${await response.text()}`;

  it("keeps the component endpoints the framework's under an app catch-all", async () => {
    const app = registrar({ owner: 'app', origin: 'app' });
    app.routes.add({
      methods: ['GET', 'POST'],
      path: '/:a{.+}',
      access: OPEN,
      handler: lane('app'),
    });
    const served = await createApp({
      manifest: EMPTY_MANIFEST,
      services: componentServices(),
      contributions: app.contributions(),
    });
    const fetch = (path: string, method = 'GET') =>
      served.fetch(new Request(`${TEST_ORIGIN}${path}`, { method }));
    assert.equal(await text(await fetch('/_jsails/components/download')), '200 download');
    assert.equal(await text(await fetch('/elsewhere')), '200 app');
    // A method the framework does not serve on its path is a 405, not the fallback.
    const post = await fetch('/_jsails/components/download', 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });

  it("keeps the component endpoints from a code plugin's namespace pattern", async () => {
    const plugin = registrar();
    plugin.routes.add({
      methods: ['GET', 'POST'],
      path: '/_jsails/:x/:y',
      access: OPEN,
      credentials: [],
      handler: lane('plugin'),
    });
    const served = await createApp({
      manifest: EMPTY_MANIFEST,
      services: componentServices(),
      contributions: plugin.contributions(),
    });
    const post = (path: string) =>
      served.fetch(
        new Request(`${TEST_ORIGIN}${path}`, { method: 'POST', headers: { origin: TEST_ORIGIN } }),
      );
    assert.equal(await text(await post('/_jsails/components/update')), '200 update');
    assert.equal(await text(await post('/_jsails/components/upload')), '200 upload');
    assert.equal(await text(await post('/_jsails/acme/hook')), '200 plugin');
  });

  it("keeps a code plugin's namespace route from an earlier catch-all", async () => {
    const app = registrar({ owner: 'app', origin: 'app' });
    app.routes.add({ methods: ['GET'], path: '/:a{.+}', access: OPEN, handler: lane('app') });
    const mail = registrar({ owner: 'mail' });
    mail.routes.add({
      methods: ['GET'],
      path: '/_jsails/mail',
      access: OPEN,
      handler: lane('mail'),
    });
    const served = await createApp({
      manifest: EMPTY_MANIFEST,
      contributions: {
        routes: [...app.contributions().routes, ...mail.contributions().routes],
        transforms: [],
      },
    });
    const response = await served.fetch(new Request(`${TEST_ORIGIN}/_jsails/mail`));
    assert.equal(await text(response), '200 mail');
  });

  it('fails assembly on a route under a mount, in either registration order', async () => {
    const auth = registrar({ owner: 'auth' });
    auth.routes.mount('/api', lane('mounted'), { access: OPEN });
    const shop = registrar({ owner: 'shop' });
    shop.routes.add({
      methods: ['GET'],
      path: '/api/orders',
      access: OPEN,
      handler: lane('orders'),
    });
    const [mount] = auth.contributions().routes;
    const [orders] = shop.contributions().routes;
    assert.ok(mount !== undefined && orders !== undefined);
    for (const routes of [
      [mount, orders],
      [orders, mount],
    ]) {
      await assert.rejects(
        createApp({ manifest: EMPTY_MANIFEST, contributions: { routes, transforms: [] } }),
        (error: unknown) => RouteErrors.is(error, 'mount_overlap'),
      );
    }
  });

  it('serves a mounted path from the mount, never from an earlier fallback', async () => {
    const shop = registrar({ owner: 'shop' });
    shop.routes.add({
      methods: ['GET'],
      path: '/:section/orders',
      access: OPEN,
      handler: lane('fallback'),
    });
    const auth = registrar({ owner: 'auth' });
    auth.routes.mount('/api', lane('mounted'), { access: OPEN });
    const served = await createApp({
      manifest: EMPTY_MANIFEST,
      contributions: {
        routes: [...shop.contributions().routes, ...auth.contributions().routes],
        transforms: [],
      },
    });
    const fetch = (path: string) => served.fetch(new Request(`${TEST_ORIGIN}${path}`));
    assert.equal(await text(await fetch('/api/orders')), '200 mounted');
    assert.equal(await text(await fetch('/shop/orders')), '200 fallback');
  });
});
