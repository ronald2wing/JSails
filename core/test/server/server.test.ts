/**
 * End-to-end tests for the Hono HTTP integration (`createApp`,
 * `createHttpServer`) against real on-disk compiled ESM fixtures. Method
 * dispatch, routing specificity, access, the cross-site check, body limits, and error
 * sanitization are exercised in-process through `app.fetch`; the final cases
 * bind an ephemeral loopback port and prove one `node:http.Server` serves both
 * HTTP and Socket.IO broadcast. No live Valkey, database, or external service
 * is used.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { io as createClient } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import type { Hono } from 'hono';

import { publicAccess } from '../../src/api/access-ref.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { readJsonBody } from '../../src/api/json-body.js';
import { RequestErrors } from '../../src/errors/kernel.js';
import { Async } from '../../src/support/async.js';
import { createHttpServer } from '../../src/server/http-server.js';
import { BodyLimitError, MAX_ROUTE_BODY_BYTES } from '../../src/server/route-limits.js';
import { discoverRoutes, type RouteManifest } from '../../src/routing/routes.js';
import { attachBroadcast, BROADCAST_PATH } from '../../src/broadcast/server.js';
import type { Session } from '../../src/contracts/http.js';
import type { PageRenderer } from '../../src/contracts/render.js';
import { documentOutcome, preactPageRenderer } from '../../src/pages/page.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import type { AppEnv } from '../../src/server/env.js';
import {
  createServiceRegistry,
  createServiceToken,
  runExtensions,
  type ServiceRegistry,
} from '../../src/extensions/index.js';
import { appRoutes, TEST_ORIGIN, writeFixture } from '../fixtures/app.js';

// ---------------------------------------------------------------------------
// Fixtures: compiled ESM route modules written to a real temp tree.
// ---------------------------------------------------------------------------

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const fixturesRoot = mkdtempSync(join(distDir, 'server-'));
const badRoot = mkdtempSync(join(distDir, 'server-bad-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
  rmSync(badRoot, { recursive: true, force: true });
});

/** Absolute `file://` URL to a built framework module, importable from a fixture. */
function frameworkUrl(rel: string): string {
  return pathToFileURL(join(distDir, rel)).href;
}

const VALIDATION_URL = frameworkUrl('src/api/validation.js');
const JSON_BODY_URL = frameworkUrl('src/api/json-body.js');

writeFixture(
  fixturesRoot,
  'api/users.mjs',
  `export const GET = (request, context) => Response.json({
  route: 'users',
  method: 'GET',
  session: context.session ? context.session.id : null,
  q: context.url.searchParams.get('q') ?? null,
});

export const POST = (request, context) => Response.json({
  route: 'users',
  method: 'POST',
  session: context.session ? context.session.id : null,
});
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/users/[id].mjs',
  `export const GET = (request, context) => Response.json({
  route: 'user',
  id: context.params.id,
  q: context.url.searchParams.get('q') ?? null,
});
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/methods.mjs',
  `const respond = (method) => new Response(JSON.stringify({ method }), {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-method': method },
});

export const GET = () => respond('GET');
export const POST = () => respond('POST');
export const PUT = () => respond('PUT');
export const PATCH = () => respond('PATCH');
export const DELETE = () => respond('DELETE');
export const OPTIONS = () => respond('OPTIONS');
export const HEAD = () => new Response(null, { status: 204, headers: { 'x-method': 'HEAD' } });
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/guarded.mjs',
  `export const GET = () => Response.json({ route: 'guarded' });

export const authorize = (context) => context.session !== null;
`,
);

writeFixture(
  fixturesRoot,
  'api/head-only.mjs',
  `export const HEAD = () => new Response(null, {
  status: 204,
  headers: { 'x-method': 'HEAD-ONLY' },
});
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/throw.mjs',
  `export const GET = () => {
  throw new Error('secret credential /home/alice/.ssh/id_rsa leaked');
};
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/validate.mjs',
  `import { ValidationError } from ${JSON.stringify(VALIDATION_URL)};

export const POST = () => {
  throw new ValidationError([
    { path: ['name'], code: 'min_length', message: 'Must be at least 3 characters' },
  ]);
};
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/echo.mjs',
  `import { readJsonBody } from ${JSON.stringify(JSON_BODY_URL)};

export const POST = async (request) => {
  const body = await readJsonBody(request);
  return Response.json({ echoed: body });
};
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/default-only.mjs',
  `export default () => new Response('should never be dispatched');
export const authorize = () => true;
`,
);

// Reports whether the request context carries a services registry and resolves
// one probe value from it; the registry is duck-typed by the test.
writeFixture(
  fixturesRoot,
  'api/services.mjs',
  `export const GET = (request, context) => Response.json({
  hasServices: context.services !== undefined,
  value: context.services ? context.services.get('probe') : null,
});
export const authorize = () => true;
`,
);

// Middleware fixtures: `x-order` headers are prepended after `next()` resolves,
// so the final header reads the declared execution order left to right
// (outermost-first, terminal handler last). `x-mw` marks a middleware that ran.
writeFixture(
  fixturesRoot,
  'api/mw-order.mjs',
  `export const middleware = ['first', 'second', 'third'].map((name) => async (c, next) => {
  const response = await next();
  const headers = response.headers;
  headers.set('x-order', name + ',' + (headers.get('x-order') ?? ''));
  return response;
});

export const GET = () => new Response('ok', { status: 200, headers: { 'x-order': 'handler' } });
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/mw-short.mjs',
  `export const middleware = [
  async () => new Response('blocked by middleware', { status: 401, headers: { 'x-mw': 'guard' } }),
];

export const GET = () => new Response('should not run', { status: 200, headers: { 'x-ran': 'yes' } });
export const authorize = () => true;
`,
);

writeFixture(
  fixturesRoot,
  'api/mw-guarded.mjs',
  `export const middleware = [
  async (c, next) => {
    const response = await next();
    response.headers.set('x-mw', 'ran');
    return response;
  },
];

export const authorize = () => false;

export const GET = () => Response.json({ route: 'mw-guarded' });
`,
);

writeFixture(
  fixturesRoot,
  'api/mw-throw.mjs',
  `export const middleware = [
  () => {
    throw new Error('secret middleware token abc123 leaked');
  },
];

export const GET = () => Response.json({ route: 'mw-throw' });
export const authorize = () => true;
`,
);

// A route whose module authorize denies everyone; its handler never runs.
writeFixture(
  fixturesRoot,
  'api/deny-all.mjs',
  `export const GET = () => new Response('ok', { status: 200, headers: { 'x-handler': 'ran' } });
export const authorize = () => false;
`,
);

// Admits exactly when the `value` query parses to the JSON `true`.
writeFixture(
  fixturesRoot,
  'api/check-value.mjs',
  `export const GET = () => Response.json({ route: 'check-value' });

export const authorize = (context) => JSON.parse(context.url.searchParams.get('value') ?? 'null');
`,
);

writeFixture(
  fixturesRoot,
  'api/check-throws.mjs',
  `export const GET = () => Response.json({ route: 'check-throws' });

export const authorize = () => {
  throw new Error('policy store down');
};
`,
);

writeFixture(fixturesRoot, 'pages/index.mjs', `export default () => null;\n`);

writeFixture(badRoot, 'api/badget.mjs', `export const GET = 'not a function';\n`);

const mainManifest: RouteManifest = discoverRoutes(fixturesRoot);
const badManifest: RouteManifest = discoverRoutes(badRoot);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SESSION: Session = {
  id: 'session-1',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

/** An app over the main fixtures plus one open GET route at `path`. */
function routeApp(path: string, handler: () => Response): Promise<Hono<AppEnv>> {
  return createApp({
    manifest: mainManifest,
    contributions: appRoutes((routes) =>
      routes.add({ methods: ['GET'], path, access: publicAccess('server probe'), handler }),
    ),
  });
}

function buildApp(overrides: Partial<AppOptions> = {}): Promise<Hono<AppEnv>> {
  return createApp({ manifest: mainManifest, ...overrides });
}

/**
 * `init` carrying a session cookie unless it names one: the session resolver
 * runs only for a request with a credential.
 */
function withCredential(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('cookie')) headers.set('cookie', 'sid=1');
  return { ...init, headers };
}

async function request(app: Hono<AppEnv>, path: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(`${TEST_ORIGIN}${path}`, init));
}

/** {@link request} with a session cookie, so the app's session resolver runs. */
async function credentialed(
  app: Hono<AppEnv>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return request(app, path, withCredential(init));
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface Problem {
  type: string;
  title: string;
  status: number;
  code?: string;
  detail?: string;
  traceId?: string;
  issues?: Array<{ path: (string | number)[]; code: string; message: string }>;
}

async function errorOf(response: Response): Promise<Problem> {
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  return (await response.json()) as Problem;
}

// ---------------------------------------------------------------------------
// Setup validation
// ---------------------------------------------------------------------------

describe('createApp setup validation', () => {
  it('rejects a missing or malformed options object', async () => {
    await assert.rejects(createApp(undefined as unknown as AppOptions), TypeError);
    await assert.rejects(createApp({} as AppOptions), TypeError);
  });

  it('rejects non-function option callbacks', async () => {
    await assert.rejects(
      createApp({
        manifest: mainManifest,
        resolveSession: 42 as unknown as AppOptions['resolveSession'],
      }),
      TypeError,
    );
    for (const maxBodyBytes of [0, MAX_ROUTE_BODY_BYTES + 1]) {
      await assert.rejects(createApp({ manifest: mainManifest, maxBodyBytes }), BodyLimitError);
    }
    const largest = await createApp({ manifest: mainManifest, maxBodyBytes: MAX_ROUTE_BODY_BYTES });
    assert.equal(typeof largest.fetch, 'function');
  });

  it('rejects a method export that is not a function', async () => {
    await assert.rejects(createApp({ manifest: badManifest }), /non-function value/);
  });

  it('rejects a module whose authorize export is not a function', async () => {
    const root = mkdtempSync(join(distDir, 'server-access-bad-'));
    try {
      writeFixture(
        root,
        'api/badauth.mjs',
        `export const GET = () => new Response();
export const authorize = 'nope';
`,
      );
      await assert.rejects(createApp({ manifest: discoverRoutes(root) }), {
        code: 'route.invalid_definition',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a module that exports both access and authorize', async () => {
    const root = mkdtempSync(join(distDir, 'server-access-both-'));
    try {
      writeFixture(
        root,
        'api/both.mjs',
        `export const GET = () => new Response();
export const access = () => true;
export const authorize = () => true;
`,
      );
      await assert.rejects(createApp({ manifest: discoverRoutes(root) }), {
        code: 'route.invalid_definition',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails assembly for a module that states no access', async () => {
    const root = mkdtempSync(join(distDir, 'server-access-none-'));
    try {
      writeFixture(root, 'api/open.mjs', `export const GET = () => new Response();\n`);
      await assert.rejects(createApp({ manifest: discoverRoutes(root) }), {
        code: 'surface.missing_access',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed server.origin', async () => {
    for (const origin of [
      'not-a-url',
      'ftp://example.com',
      'https://example.com/path',
      'https://example.com/path/',
      'https://user:pass@example.com',
      'https://example.com?q=1',
      'https://example.com#frag',
      42,
    ]) {
      await assert.rejects(
        createApp({
          manifest: mainManifest,
          server: { origin: origin as unknown as string },
        }),
        TypeError,
        `expected TypeError for ${String(origin)}`,
      );
    }
  });

  it('does not guess a default export as a handler', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/default-only');
    assert.equal(response.status, 404);
  });

  it('rejects malformed renderer and services options', async () => {
    await assert.rejects(
      createApp({ manifest: mainManifest, renderer: 'no' as unknown as PageRenderer }),
      TypeError,
    );
    await assert.rejects(
      createApp({ manifest: mainManifest, renderer: {} as unknown as PageRenderer }),
      TypeError,
    );
    await assert.rejects(
      createApp({ manifest: mainManifest, services: {} as unknown as ServiceRegistry }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Method dispatch and routing
// ---------------------------------------------------------------------------

describe('method dispatch and routing', () => {
  it('dispatches every recognized HTTP method export', async () => {
    const app = await buildApp();
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request(app, '/api/methods', {
        method,
        headers: { origin: TEST_ORIGIN },
      });
      assert.equal(response.status, 200, method);
      const body = await jsonOf(response);
      assert.equal(body.method, method);
    }
  });

  it('serves HEAD through the explicit HEAD export when present', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/methods', { method: 'HEAD' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('x-method'), 'HEAD');
    assert.equal(await response.text(), '');
  });

  it('falls back to the GET handler for HEAD when no HEAD export exists', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/users', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  it('serves a HEAD-only module for HEAD and answers GET with 405 Allow: HEAD', async () => {
    const app = await buildApp();

    const head = await request(app, '/api/head-only', { method: 'HEAD' });
    assert.equal(head.status, 204);
    assert.equal(head.headers.get('x-method'), 'HEAD-ONLY');

    const get = await request(app, '/api/head-only');
    assert.equal(get.status, 405);
    assert.equal((await errorOf(get)).code, 'http.method_not_allowed');
    assert.equal(get.headers.get('allow'), 'HEAD');
  });

  it('routes static segments before parameter segments', async () => {
    const app = await buildApp();
    const list = await jsonOf(await request(app, '/api/users'));
    assert.equal(list.route, 'users');

    const one = await jsonOf(await request(app, '/api/users/42'));
    assert.equal(one.route, 'user');
    assert.equal(one.id, '42');
  });

  it('exposes query and path params in the request context', async () => {
    const app = await buildApp();
    const body = await jsonOf(await request(app, '/api/users/7?q=hello'));
    assert.equal(body.route, 'user');
    assert.equal(body.id, '7');
    assert.equal(body.q, 'hello');
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('API authorization', () => {
  it('denies an anonymous caller with 401 when the check does not return true', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/guarded');
    assert.equal(response.status, 401);
    assert.equal((await errorOf(response)).code, 'request.unauthenticated');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  });

  it('denies a signed-in caller with 403 when the check does not return true', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    const response = await credentialed(app, '/api/deny-all');
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'request.forbidden');
  });

  it('denies when the check returns a truthy non-boolean value', async () => {
    const app = await buildApp();
    for (const value of [1, 'yes', {}, []]) {
      const query = encodeURIComponent(JSON.stringify(value));
      const response = await request(app, `/api/check-value?value=${query}`);
      assert.equal(response.status, 401, JSON.stringify(value));
    }
    assert.equal((await request(app, '/api/check-value?value=true')).status, 200);
  });

  it('answers a throwing check as a reported 503 fault, never a silent deny', async () => {
    const reported: unknown[] = [];
    const app = await buildApp({
      onError: (error) => {
        reported.push(error);
      },
    });
    const response = await request(app, '/api/check-throws');
    assert.equal(response.status, 503);
    assert.equal((await errorOf(response)).code, 'access.fault');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(reported.length, 1);
  });

  it('allows when the check resolves true', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    assert.equal((await request(app, '/api/users')).status, 200);
    assert.equal((await credentialed(app, '/api/guarded')).status, 200);
  });
});

// ---------------------------------------------------------------------------
// API middleware
// ---------------------------------------------------------------------------

describe('API middleware', () => {
  it('runs middleware in declared order before the method handler', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/mw-order');
    assert.equal(response.status, 200);
    // Prepended after next() resolves: outermost-first, terminal handler last.
    assert.equal(response.headers.get('x-order'), 'first,second,third,handler');
  });

  it('short-circuits the method handler when middleware returns a Response', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/mw-short');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-mw'), 'guard');
    assert.equal(response.headers.get('x-ran'), null);
    assert.equal(await response.text(), 'blocked by middleware');
  });

  it('still narrows through a module authorize that denies despite middleware', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/mw-guarded');
    assert.equal(response.status, 401);
    assert.equal((await errorOf(response)).code, 'request.unauthenticated');
    // Authorization gates before middleware: the middleware never ran.
    assert.equal(response.headers.get('x-mw'), null);
  });

  it('sanitizes a throwing middleware to the bare 500 problem', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/mw-throw');
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.doesNotMatch(raw, /abc123/);
    assert.doesNotMatch(raw, /middleware token/);
    const { traceId, ...problem } = JSON.parse(raw) as Problem;
    assert.match(traceId ?? '', /^[0-9a-f]{32}$/);
    assert.deepEqual(problem, { type: 'about:blank', title: 'Internal Server Error', status: 500 });
  });

  it('rejects a non-array middleware export at assembly (value-free)', async () => {
    const root = mkdtempSync(join(distDir, 'server-mw-bad-'));
    try {
      writeFixture(
        root,
        'api/badmiddleware.mjs',
        `export const GET = () => new Response();
export const middleware = 'not-an-array';
export const authorize = () => true;
`,
      );
      const manifest = discoverRoutes(root);
      await assert.rejects(createApp({ manifest }), /exports "middleware" as a non-array value/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-function middleware entry at assembly (value-free)', async () => {
    const root = mkdtempSync(join(distDir, 'server-mw-bad-'));
    try {
      writeFixture(
        root,
        'api/badmiddleware2.mjs',
        `export const GET = () => new Response();
export const middleware = [() => new Response(), 42];
export const authorize = () => true;
`,
      );
      const manifest = discoverRoutes(root);
      await assert.rejects(
        createApp({ manifest }),
        /exports a non-function middleware entry at index 1/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a middleware name: an entry is the function itself', async () => {
    const root = mkdtempSync(join(distDir, 'server-mw-name-'));
    try {
      writeFixture(
        root,
        'api/named.mjs',
        `export const GET = () => new Response();
export const middleware = ['secret-name'];
export const authorize = () => true;
`,
      );
      const manifest = discoverRoutes(root);
      await assert.rejects(createApp({ manifest }), (error: unknown) => {
        assert.match(String(error), /exports a non-function middleware entry at index 0/);
        assert.doesNotMatch(String(error), /secret-name/);
        return true;
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Session context and the cross-site check
// ---------------------------------------------------------------------------

describe('session context and the cross-site check', () => {
  const mutatingInit = (headers: Record<string, string>): RequestInit => ({
    method: 'POST',
    headers,
  });

  it('exposes the resolved session on read requests', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    const body = await jsonOf(await credentialed(app, '/api/users'));
    assert.equal(body.session, 'session-1');
  });

  it('defaults session to null when no resolver is provided', async () => {
    const app = await buildApp();
    const body = await jsonOf(await request(app, '/api/users'));
    assert.equal(body.session, null);
  });

  it('fails closed to null when resolveSession throws', async () => {
    const app = await buildApp({
      resolveSession: () => {
        throw new Error('store down');
      },
    });
    const body = await jsonOf(await credentialed(app, '/api/users'));
    assert.equal(body.session, null);
  });

  it('accepts a mutation whose Origin is the app origin', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    const response = await credentialed(app, '/api/users', mutatingInit({ origin: TEST_ORIGIN }));
    assert.equal(response.status, 200);
    assert.equal((await jsonOf(response)).session, 'session-1');
  });

  it('accepts a mutation without Origin only when Sec-Fetch-Site is same-origin', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    const sameOrigin = await credentialed(
      app,
      '/api/users',
      mutatingInit({ 'sec-fetch-site': 'same-origin' }),
    );
    assert.equal(sameOrigin.status, 200);
    for (const headers of [
      {} as Record<string, string>,
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site' },
      { referer: `${TEST_ORIGIN}/form` },
    ]) {
      const response = await credentialed(app, '/api/users', mutatingInit(headers));
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal((await errorOf(response)).code, 'access.cross_site');
    }
  });

  it('rejects a mutation from another origin, a null one included', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    for (const origin of ['https://evil.example', 'null', `${TEST_ORIGIN}/`]) {
      const response = await credentialed(app, '/api/users', mutatingInit({ origin }));
      assert.equal(response.status, 403, origin);
      assert.equal((await errorOf(response)).code, 'access.cross_site');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('set-cookie'), null);
    }
  });

  it('rejects an anonymous cross-origin mutation the same way', async () => {
    const app = await buildApp();
    const response = await request(
      app,
      '/api/users',
      mutatingInit({ origin: 'https://evil.example' }),
    );
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'access.cross_site');
  });

  it('exempts a request whose identity came from a header credential', async () => {
    const tokenSession: Session = { ...SESSION, data: { userId: 'u1', authMethod: 'api-token' } };
    const app = await buildApp({ resolveSession: () => tokenSession });
    const response = await request(app, '/api/users', {
      method: 'POST',
      headers: { authorization: 'Bearer t', origin: 'https://evil.example' },
    });
    assert.equal(response.status, 200);
  });
});

// ---------------------------------------------------------------------------
// server.origin behind a TLS-terminating proxy
// ---------------------------------------------------------------------------

describe('server.origin (TLS-terminating proxy)', () => {
  const PUBLIC_ORIGIN = 'https://example.com';
  // The proxy forwards the public Host over plain HTTP.
  const proxied = async (
    app: Hono<AppEnv>,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => app.fetch(new Request(`http://example.com${path}`, withCredential(init)));

  it('accepts an HTTPS Origin against the configured origin', async () => {
    const app = await buildApp({
      resolveSession: () => SESSION,
      server: { origin: PUBLIC_ORIGIN },
    });
    const response = await proxied(app, '/api/users', {
      method: 'POST',
      headers: { origin: PUBLIC_ORIGIN },
    });
    assert.equal(response.status, 200);
    assert.equal((await jsonOf(response)).session, 'session-1');
  });

  it('rejects an Origin that mismatches the configured origin', async () => {
    const app = await buildApp({
      resolveSession: () => SESSION,
      server: { origin: PUBLIC_ORIGIN },
    });
    for (const origin of ['https://evil.example', 'http://example.com']) {
      const response = await proxied(app, '/api/users', {
        method: 'POST',
        headers: { origin },
      });
      assert.equal(response.status, 403, origin);
      assert.equal((await errorOf(response)).code, 'access.cross_site');
    }
  });

  it('never trusts forwarded headers alone to satisfy the origin check', async () => {
    const app = await buildApp({
      resolveSession: () => SESSION,
      server: { origin: PUBLIC_ORIGIN, trustedProxies: { hops: 1 } },
    });
    // Forwarded headers claim the public origin but no Origin header is sent:
    // the cross-site check must still reject (it reads only Origin and Sec-Fetch-Site).
    const response = await proxied(app, '/api/users', {
      method: 'POST',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'example.com',
        'x-forwarded-for': '198.51.100.7',
      },
    });
    assert.equal(response.status, 403);
    assert.equal((await errorOf(response)).code, 'access.cross_site');
  });

  it('answers 421 for a host that is not the configured one, before any other stage', async () => {
    let resolved = 0;
    const app = await buildApp({
      resolveSession: () => {
        resolved += 1;
        return SESSION;
      },
      server: { origin: PUBLIC_ORIGIN },
    });
    for (const url of [
      'http://evil.example/api/users',
      'http://localhost/up',
      'http://example.com.evil.example/',
    ]) {
      const response = await app.fetch(
        new Request(url, { headers: { 'x-forwarded-host': 'example.com' } }),
      );
      assert.equal(response.status, 421, url);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
      assert.equal((await errorOf(response)).code, 'http.misdirected_request');
    }
    assert.equal(resolved, 0);
  });

  it('leaves context.url as the request URL, not the configured origin', async () => {
    const app = await buildApp({ server: { origin: PUBLIC_ORIGIN } });
    const body = await jsonOf(await proxied(app, '/api/users?q=kept'));
    assert.equal(body.q, 'kept');
  });
});

// ---------------------------------------------------------------------------
// Body limit and JSON parsing
// ---------------------------------------------------------------------------

describe('body limit and JSON parsing', () => {
  it('rejects a declared oversized request body before the handler runs', async () => {
    const app = await buildApp({ maxBodyBytes: 32 });
    const response = await request(app, '/api/users', {
      method: 'POST',
      body: 'x'.repeat(100),
      headers: {
        origin: TEST_ORIGIN,
        'content-length': '100',
      },
    });
    assert.equal(response.status, 413);
    assert.equal((await errorOf(response)).code, 'request.too_large');
  });

  it('maps malformed JSON to a 422 request.invalid through the handler', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/echo', {
      method: 'POST',
      body: '{not valid json',
      headers: { origin: TEST_ORIGIN },
    });
    assert.equal(response.status, 422);
    const error = await errorOf(response);
    assert.equal(error.code, 'request.invalid');
    assert.equal(error.issues?.[0]?.code, 'invalid_json');
  });

  it('echoes a valid JSON body', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/echo', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { origin: TEST_ORIGIN },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await jsonOf(response)).echoed, { a: 1 });
  });
});

describe('readJsonBody helper', () => {
  const url = `${TEST_ORIGIN}/x`;

  it('parses valid JSON', async () => {
    const value = await readJsonBody(new Request(url, { method: 'POST', body: '{"a":1}' }));
    assert.deepEqual(value, { a: 1 });
  });

  it('rejects malformed JSON with a ValidationError', async () => {
    await assert.rejects(
      readJsonBody(new Request(url, { method: 'POST', body: '{oops' })),
      (error: unknown) => error instanceof Error && error.name === 'ValidationError',
    );
  });

  it('rejects an empty body with a ValidationError', async () => {
    await assert.rejects(
      readJsonBody(new Request(url, { method: 'POST' })),
      (error: unknown) => error instanceof Error && error.name === 'ValidationError',
    );
  });

  it('rejects a streamed body over maxBytes with request.too_large', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"'));
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    // Node requires `duplex: 'half'` for a stream body; its `RequestInit` type omits it.
    const request = new Request(url, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await assert.rejects(readJsonBody(request, { maxBytes: 16 }), (error: unknown) =>
      RequestErrors.is(error, 'too_large'),
    );
  });

  it('rejects a declared content-length over maxBytes before reading', async () => {
    const request = new Request(url, {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-length': '1000' },
    });
    await assert.rejects(readJsonBody(request, { maxBytes: 16 }), (error: unknown) =>
      RequestErrors.is(error, 'too_large'),
    );
  });

  it('accepts a body within maxBytes', async () => {
    const value = await readJsonBody(new Request(url, { method: 'POST', body: '{"a":1}' }), {
      maxBytes: 16,
    });
    assert.deepEqual(value, { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Error envelope and sanitization
// ---------------------------------------------------------------------------

describe('error envelope and sanitization', () => {
  it('returns a 404 envelope for an unknown route', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/nope');
    assert.equal(response.status, 404);
    assert.equal((await errorOf(response)).code, 'request.not_found');
  });

  it('returns a 405 with an Allow header for a wrong method', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/users/42', { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal((await errorOf(response)).code, 'http.method_not_allowed');
    assert.match(response.headers.get('allow') ?? '', /GET/);
  });

  it('maps a thrown ValidationError to 422 request.invalid with structured issues', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/validate', {
      method: 'POST',
      headers: { origin: TEST_ORIGIN },
    });
    assert.equal(response.status, 422);
    const error = await errorOf(response);
    assert.equal(error.code, 'request.invalid');
    assert.deepEqual(error.issues, [
      { path: ['name'], code: 'min_length', message: 'Must be at least 3 characters' },
    ]);
  });

  it('sanitizes unexpected handler errors without leaking message, stack, or file paths', async () => {
    const app = await buildApp();
    const response = await request(app, '/api/throw');
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.doesNotMatch(raw, /id_rsa/);
    assert.doesNotMatch(raw, /alice/);
    assert.doesNotMatch(raw, /\.ssh/);
    assert.doesNotMatch(raw, /stack/i);
    const { traceId, ...problem } = JSON.parse(raw) as Problem;
    assert.match(traceId ?? '', /^[0-9a-f]{32}$/);
    assert.deepEqual(problem, { type: 'about:blank', title: 'Internal Server Error', status: 500 });
  });
});

// ---------------------------------------------------------------------------
// Pages (renderer injection)
// ---------------------------------------------------------------------------

describe('page rendering', () => {
  it('delegates rendering to the injected renderer with the request context', async () => {
    const app = await buildApp({
      resolveSession: () => SESSION,
      renderer: {
        render: (entry, context) =>
          documentOutcome(
            JSON.stringify({ page: entry.route, session: context.session?.id ?? null }),
          ),
      },
    });
    const body = await jsonOf(await credentialed(app, '/'));
    assert.equal(body.page, '/');
    assert.equal(body.session, 'session-1');
  });

  it('does not serve pages when no renderer is injected', async () => {
    const app = await buildApp();
    assert.equal((await request(app, '/')).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Structured renderer injection
// ---------------------------------------------------------------------------

describe('structured renderer', () => {
  it('serves a page as HTML with typed no-DB services and staticMode false', async () => {
    const site = createServiceToken<{ title: string }>('site');
    const controller = createServiceRegistry();
    controller.registrar.provide(site, { title: 'Hello' });

    const seen: Array<{ staticMode: boolean | undefined; title: string }> = [];
    const renderer: PageRenderer = {
      render(_entry, context, options) {
        const title = context.services?.get(site).title ?? '';
        seen.push({ staticMode: options?.staticMode, title });
        return documentOutcome(`<!doctype html><h1>${title}</h1>`);
      },
    };

    const app = await buildApp({
      resolveSession: () => SESSION,
      services: controller.services,
      renderer,
    });
    const response = await request(app, '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await response.text(), '<!doctype html><h1>Hello</h1>');
    assert.deepEqual(seen, [{ staticMode: false, title: 'Hello' }]);
  });

  it('reduces a non-string renderer result to the generic 500 page', async () => {
    const app = await buildApp({
      renderer: { render: (() => undefined) as unknown as PageRenderer['render'] },
    });
    const response = await request(app, '/');
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const html = await response.text();
    assert.match(html, /500 Internal Server Error/);
    assert.doesNotMatch(html, /renderer|did not return/);
  });
});

// ---------------------------------------------------------------------------
// Page middleware (the page module's own chain)
// ---------------------------------------------------------------------------

describe('page middleware', () => {
  /** An app over one page module whose source is `source`, rendered as `<html/>`. */
  async function pageApp(t: TestContext, source: string): Promise<Hono<AppEnv>> {
    const root = mkdtempSync(join(distDir, 'server-pg-mw-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFixture(root, 'pages/index.mjs', source);
    return createApp({
      manifest: discoverRoutes(root),
      renderer: { render: () => documentOutcome('<html/>') },
    });
  }

  it("runs the page module's middleware around the render", async (t) => {
    const app = await pageApp(
      t,
      `export const middleware = [
  async (c, next) => {
    const response = await next();
    response.headers.set('x-order', 'page,' + (response.headers.get('x-order') ?? ''));
    return response;
  },
];
export default () => null;
`,
    );
    const response = await request(app, '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-order'), 'page,');
    assert.equal(await response.text(), '<html/>');
  });

  it('renders nothing when a page middleware answers first', async (t) => {
    const app = await pageApp(
      t,
      `export const middleware = [async () => new Response('blocked by middleware', { status: 401 })];
export default () => null;
`,
    );
    const response = await request(app, '/');
    assert.equal(response.status, 401);
    assert.equal(await response.text(), 'blocked by middleware');
  });

  it('answers a throwing page middleware with the generic 500 page', async (t) => {
    const app = await pageApp(
      t,
      `export const middleware = [() => { throw new Error('secret token leak page'); }];
export default () => null;
`,
    );
    const response = await request(app, '/');
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.doesNotMatch(raw, /secret token/);
    assert.match(raw, /500 Internal Server Error/);
  });
});

// ---------------------------------------------------------------------------
// Services threading into request contexts
// ---------------------------------------------------------------------------

describe('services threading', () => {
  it('passes services into normal API request contexts', async () => {
    // Every service resolves to 'svc' except the component runtime, whose
    // routes the server mounts as soon as one is registered.
    const services = {
      has: (token: unknown) => token !== serverComponentsToken,
      tryGet: (token: unknown) => (token === serverComponentsToken ? undefined : 'svc'),
      get: () => 'svc',
    } as unknown as ServiceRegistry;
    const app = await buildApp({ services });
    const body = await jsonOf(await request(app, '/api/services'));
    assert.equal(body.hasServices, true);
    assert.equal(body.value, 'svc');
  });

  it('leaves services absent from request contexts when none is supplied', async () => {
    const app = await buildApp();
    const body = await jsonOf(await request(app, '/api/services'));
    assert.equal(body.hasServices, false);
  });
});

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('health endpoint', () => {
  it('serves GET and HEAD with plain-text OK and no-store', async () => {
    const app = await buildApp({ healthPath: '/up' });

    const get = await request(app, '/up');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.equal(await get.text(), 'OK');

    const head = await request(app, '/up', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(head.headers.get('cache-control'), 'no-store');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it('serves a custom path and leaves the default path unregistered', async () => {
    const app = await buildApp({ healthPath: '/healthz' });
    assert.equal((await request(app, '/healthz')).status, 200);
    assert.equal((await request(app, '/up')).status, 404);
  });

  it('is disabled when no healthPath is supplied', async () => {
    const app = await buildApp();
    assert.equal((await request(app, '/up')).status, 404);
  });

  it('is open even when the filesystem API denies the caller', async () => {
    const app = await buildApp({ healthPath: '/up' });
    assert.equal((await request(app, '/up')).status, 200);
    assert.equal((await request(app, '/api/guarded')).status, 401);
  });

  it('rejects an empty healthPath option', async () => {
    await assert.rejects(buildApp({ healthPath: '' }), /healthPath must be a non-empty string/);
  });
});

// ---------------------------------------------------------------------------
// Plugin routes
// ---------------------------------------------------------------------------

describe('plugin routes', () => {
  it('serves a registrar route with its own middleware and the services', async () => {
    const greeting = createServiceToken<{ text: string }>('greeting');
    const runtime = await runExtensions(
      [
        {
          name: 'plugin',
          setup: ({ services, routes }) => {
            services.provide(greeting, { text: 'hi' });
            routes.add({
              methods: ['GET'],
              path: '/plugin/health',
              access: publicAccess('plugin health probe'),
              middleware: [
                async (_context, next) => {
                  const response = await next();
                  response.headers.set('x-plugin', 'on');
                  return response;
                },
              ],
              handler: (context) =>
                Response.json({ ok: true, greeting: context.services?.get(greeting).text }),
            });
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );

    const app = await createApp({
      manifest: mainManifest,
      services: runtime.services,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
    });
    const response = await request(app, '/plugin/health');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-plugin'), 'on');
    assert.deepEqual(await jsonOf(response), { ok: true, greeting: 'hi' });

    await runtime.close();
  });

  it('keeps the filesystem API default-deny beside a public plugin route', async () => {
    const runtime = await runExtensions(
      [
        {
          name: 'plugin',
          setup: ({ routes }) =>
            routes.add({
              methods: ['GET'],
              path: '/plugin/open',
              access: publicAccess('an open plugin page'),
              handler: () => new Response('open'),
            }),
        },
      ],
      { rootDir: import.meta.dirname },
    );

    const app = await createApp({
      manifest: mainManifest,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
    });
    assert.equal((await request(app, '/plugin/open')).status, 200);
    assert.equal((await request(app, '/api/guarded')).status, 401);

    await runtime.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP server factory and one-port broadcast smoke test
// ---------------------------------------------------------------------------

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function connectSocket(port: number, origin: string): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 2000,
    extraHeaders: { Origin: origin },
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('connect timed out'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe('createHttpServer', () => {
  it('rejects a non-Hono app', () => {
    assert.throws(() => createHttpServer({} as Hono<AppEnv>), TypeError);
  });

  it('serves a real HTTP request on a bound ephemeral port', async () => {
    const app = await buildApp();
    const server = createHttpServer(app);
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/users/9?q=real`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { route: string; id: string; q: string };
      assert.equal(body.route, 'user');
      assert.equal(body.id, '9');
      assert.equal(body.q, 'real');
    } finally {
      await closeServer(server);
    }
  });

  it('shares one port between HTTP and Socket.IO broadcast', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    const server = createHttpServer(app);
    const port = await listen(server);
    const origin = `http://127.0.0.1:${port}`;

    const broadcast = await attachBroadcast(server, {
      allowedOrigins: [origin],
      authenticate: () => ({ id: 'user-1' }),
      authorizeChannel: () => true,
    });

    let socket: ClientSocket | undefined;
    try {
      // HTTP still works on the shared port.
      const httpResponse = await fetch(`${origin}/api/users`, { headers: { origin } });
      assert.equal(httpResponse.status, 200);

      // Socket.IO connects on the same port.
      socket = await connectSocket(port, origin);
      const event = new Promise<{ value: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('broadcast event timed out')), 3000);
        socket!.on('jsails:event', (payload: { data: { value: number } }) => {
          clearTimeout(timer);
          resolve(payload.data);
        });
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('subscribe ack timed out')), 3000);
        socket!.emit('jsails:subscribe', { channels: ['room-1'] }, (ack: { ok: boolean }) => {
          clearTimeout(timer);
          if (ack?.ok) resolve();
          else reject(new Error(`subscribe denied: ${JSON.stringify(ack)}`));
        });
      });

      broadcast.emit('room-1', 'ping', { value: 42 });
      assert.deepEqual(await event, { value: 42 });
    } finally {
      socket?.close();
      await broadcast.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ETag middleware and server-sent events
// ---------------------------------------------------------------------------

describe('etag and server-sent events', () => {
  // An SSE response whose `cancel()` reports back so a test can prove the
  // cancellation reaches the source once the stream is dropped.
  function openSseResponse(onCancel?: () => void, contentType = 'text/event-stream'): Response {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: generation\ndata: {"generation":1}\n\n'));
        timer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          } catch {
            if (timer !== undefined) clearInterval(timer);
          }
        }, 5000);
      },
      cancel() {
        if (timer !== undefined) clearInterval(timer);
        onCancel?.();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    });
  }

  async function sseApp(contentType?: string): Promise<Hono<AppEnv>> {
    return routeApp('/events', () => openSseResponse(undefined, contentType));
  }

  it('flushes an open SSE response promptly without buffering or an ETag', async () => {
    const app = await sseApp();

    // The app response and its first frame must resolve while the stream stays
    // open. Pre-fix, the global etag middleware buffered the infinite body to
    // EOF and never returned, so this surfaced as zero bytes after timeout.
    const handle = Async.timeout(2000, { keepAlive: true });
    const timedOut = new Promise<never>((_resolve, reject) => {
      handle.signal.addEventListener('abort', () => reject(handle.signal.reason as DOMException));
    });
    let response: Response;
    try {
      response = await Promise.race([request(app, '/events'), timedOut]);
    } finally {
      handle.clear();
    }

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/i);
    // Never generated: a generated ETag over an open stream is impossible
    // without buffering to EOF, which is exactly what is being prevented.
    assert.equal(response.headers.get('etag'), null);

    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: generation/);
    // The stream is still open: a second read awaits the heartbeat, so release
    // the lock and cancel instead rather than blocking the test on a heartbeat.
    reader.releaseLock();
    await response.body!.cancel();
  });

  it('does not generate an ETag for a mixed-case content type with params', async () => {
    const app = await sseApp('Text/Event-Stream; charset=utf-8');
    const response = await request(app, '/events');
    assert.equal(response.headers.get('etag'), null);
    await response.body?.cancel();
  });

  it('cancellation reaches the source when the client drops the stream', async () => {
    let cancelled = false;
    const app = await routeApp('/events', () => openSseResponse(() => (cancelled = true)));

    const response = await request(app, '/events');
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();

    assert.equal(cancelled, true);
  });

  it('keeps the native ETag and If-None-Match 304 flow for cacheable finite text', async () => {
    const app = await routeApp(
      '/cacheable',
      () =>
        new Response('cacheable body', {
          headers: {
            'content-type': 'text/plain',
            'cache-control': 'public, max-age=60',
          },
        }),
    );

    const first = await request(app, '/cacheable');
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const second = await request(app, '/cacheable', { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), '');
  });

  it('does not digest a default no-store API response', async () => {
    const app = await buildApp();

    const response = await request(app, '/api/users');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('etag'), null);
  });

  it('does not digest a response whose declared length exceeds the digest cap', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const app = await routeApp(
      '/big',
      () =>
        new Response(big, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(big.length),
            'cache-control': 'public, max-age=60',
          },
        }),
    );

    const response = await request(app, '/big');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), null);
    assert.equal((await response.text()).length, big.length);
  });

  it('cancels the discarded body when a pre-set ETag answers 304', async () => {
    let cancelled = false;
    const app = await routeApp('/tagged', () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, {
        headers: { etag: 'W/"v1"', 'cache-control': 'public, max-age=0' },
      });
    });

    const response = await request(app, '/tagged', { headers: { 'If-None-Match': 'W/"v1"' } });
    assert.equal(response.status, 304);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });

  it('flushes a streamed page first chunk before the producer finishes', async () => {
    // The global ETag middleware would buffer a page `stream` export to EOF
    // and withhold the shell until the slow data arrived; the page route marks
    // its response so the middleware skips it.
    const pageRoot = mkdtempSync(join(distDir, 'server-stream-page-'));
    try {
      writeFixture(
        pageRoot,
        'pages/slow.mjs',
        `export async function* stream() {
           yield '<!doctype html><html><body><h1>shell</h1>';
           await new Promise((resolve) => setTimeout(resolve, 3000));
           yield '<p>slow</p></body></html>';
         }
         export default () => null;
        `,
      );
      const manifest = discoverRoutes(pageRoot);
      const app = await createApp({ manifest, renderer: preactPageRenderer });

      const handle = Async.timeout(2000, { keepAlive: true });
      const timedOut = new Promise<never>((_resolve, reject) => {
        handle.signal.addEventListener('abort', () => reject(handle.signal.reason as DOMException));
      });
      let response: Response;
      try {
        response = await Promise.race([request(app, '/slow'), timedOut]);
      } finally {
        handle.clear();
      }

      assert.equal(response.status, 200);
      // No ETag: digesting the body would require buffering to EOF.
      assert.equal(response.headers.get('etag'), null);

      const reader = response.body!.getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /<h1>shell<\/h1>/);
      reader.releaseLock();
      await response.body!.cancel();
    } finally {
      rmSync(pageRoot, { recursive: true, force: true });
    }
  });

  it('still generates an ETag over a cacheable finite non-SSE stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streaming body'));
        controller.close();
      },
    });
    const app = await routeApp(
      '/stream',
      () =>
        new Response(stream, {
          headers: {
            'content-type': 'text/plain',
            'cache-control': 'public, max-age=60',
          },
        }),
    );

    const response = await request(app, '/stream');
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('etag'));
    assert.equal(await response.text(), 'streaming body');
  });

  /**
   * A JSON-lines stream that emits one record every 20 ms and never ends,
   * typed `application/json` so the compression stage handles it too.
   */
  function endlessNdjson(): {
    response: Response;
    cancelled: () => boolean;
    cancellation: Promise<void>;
  } {
    let timer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;
    let markCancelled: () => void = () => undefined;
    const cancellation = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let sequence = 0;
        timer = setInterval(() => {
          sequence += 1;
          try {
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ sequence, pad: 'x'.repeat(64) })}\n`),
            );
          } catch {
            clearInterval(timer);
          }
        }, 20);
      },
      cancel() {
        cancelled = true;
        clearInterval(timer);
        markCancelled();
      },
    });
    const response = new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
    });
    return { response, cancelled: () => cancelled, cancellation };
  }

  async function withinTwoSeconds<T>(work: Promise<T>): Promise<T> {
    const handle = Async.timeout(2000, { keepAlive: true });
    const timedOut = new Promise<never>((_resolve, reject) => {
      handle.signal.addEventListener('abort', () => reject(handle.signal.reason as DOMException));
    });
    try {
      return await Promise.race([work, timedOut]);
    } finally {
      handle.clear();
    }
  }

  for (const acceptEncoding of [undefined, 'gzip', 'br']) {
    it(`answers an endless no-cache ndjson stream promptly (Accept-Encoding: ${String(acceptEncoding)})`, async () => {
      let stream: ReturnType<typeof endlessNdjson> | undefined;
      const app = await routeApp('/feed', () => {
        stream = endlessNdjson();
        return stream.response;
      });

      const response = await withinTwoSeconds(
        request(app, '/feed', {
          headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), null);
      assert.equal(response.headers.get('content-encoding'), acceptEncoding ?? null);

      // Each record must reach the client while the stream stays open, so the
      // compressor cannot hold records back waiting for a full window.
      const reader = response.body!.getReader();
      const first = await withinTwoSeconds(reader.read());
      assert.equal(first.done, false);
      assert.ok((first.value?.byteLength ?? 0) > 0);
      await reader.cancel();
      // The disconnect travels through the compressor and the adapter on later
      // turns of the loop, so wait for the producer's cancel, bounded, rather
      // than a fixed number of ticks a loaded machine may not reach in time.
      await withinTwoSeconds(stream!.cancellation).catch(() => undefined);
      assert.equal(stream?.cancelled(), true, 'the client disconnect must reach the producer');
    });
  }
});

// ---------------------------------------------------------------------------
// Responses with immutable headers
// ---------------------------------------------------------------------------

describe('responses with immutable headers', () => {
  it('serves Response.redirect() from an API route', async () => {
    const root = mkdtempSync(join(distDir, 'server-redirect-api-'));
    try {
      writeFixture(
        root,
        'api/go.mjs',
        `export function GET() { return Response.redirect('${TEST_ORIGIN}/elsewhere', 302); }
export const authorize = () => true;
`,
      );
      const app = await createApp({ manifest: discoverRoutes(root) });

      const response = await request(app, '/api/go');
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), `${TEST_ORIGIN}/elsewhere`);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('x-request-id'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves Response.redirect() from a plugin route', async () => {
    const app = await routeApp('/legacy', () => Response.redirect(`${TEST_ORIGIN}/current`, 301));

    const response = await request(app, '/legacy', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), `${TEST_ORIGIN}/current`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(response.headers.get('x-request-id'));
  });
});
