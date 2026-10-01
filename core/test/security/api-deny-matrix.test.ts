/**
 * Consolidated, table-driven deny matrix for filesystem API routes served by
 * `createApp`: CSRF and same-origin enforcement on cookie-authenticated
 * mutations, the origin gate on anonymous mutations, default-deny authorization, default `no-store` caching for
 * sessioned responses, value-free error envelopes, and request-body limits.
 *
 * Every row is one request through the real Hono pipeline against compiled ESM
 * route fixtures in a temp tree; nothing binds a port or opens an external
 * service. The tables are the contract: a new HTTP method the pipeline accepts
 * fails the enumeration check below until it is classified as mutating or
 * safe and given rows.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Hono } from 'hono';

import type { Authorize, Session } from '../../src/contracts/http.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { CSRF_HEADER, createApp, type AppOptions } from '../../src/server/app.js';
import type { AppEnv } from '../../src/server/env.js';
import { HTTP_METHODS } from '../../src/server/request-pipeline.js';
import { TEST_ORIGIN, writeFixture } from '../fixtures/app.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'security-api-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The planted secret every error fixture tries to leak. */
const SECRET = 'sk_live_planted_secret_7f3a';

writeFixture(
  root,
  'api/items.mjs',
  `const respond = (request) => Response.json({ method: request.method });
export const GET = respond;
export const POST = respond;
export const PUT = respond;
export const PATCH = respond;
export const DELETE = respond;
export const OPTIONS = respond;
export const HEAD = () => new Response(null, { status: 204 });
`,
);

writeFixture(
  root,
  'api/module-deny.mjs',
  `export const authorize = () => false;
export const GET = () => Response.json({ reached: true });
export const POST = () => Response.json({ reached: true });
`,
);

writeFixture(
  root,
  'api/module-truthy.mjs',
  `export const authorize = () => 'yes';
export const GET = () => Response.json({ reached: true });
`,
);

writeFixture(
  root,
  'api/plain.mjs',
  `export const GET = () => Response.json({ ok: true });
`,
);

writeFixture(
  root,
  'api/cached.mjs',
  `export const cacheControl = { maxAge: 60, staleWhileRevalidate: 30 };
export const GET = () => Response.json({ ok: true });
export const POST = () => Response.json({ ok: true });
`,
);

writeFixture(
  root,
  'api/cached-cookie.mjs',
  `export const cacheControl = { maxAge: 60 };
export const GET = () => new Response('{}', {
  headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; HttpOnly' },
});
`,
);

writeFixture(
  root,
  'api/explicit-public-cookie.mjs',
  `export const GET = () => new Response('{}', {
  headers: {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=600',
    'surrogate-control': 'max-age=600',
    'set-cookie': 'sid=abc; HttpOnly',
  },
});
`,
);

writeFixture(
  root,
  'api/errors/sync.mjs',
  `export const GET = () => { throw new Error(${JSON.stringify(`${SECRET} /home/alice/.ssh/id_rsa`)}); };
`,
);

writeFixture(
  root,
  'api/errors/async.mjs',
  `export const GET = async () => { throw new Error(${JSON.stringify(SECRET)}); };
`,
);

writeFixture(
  root,
  'api/errors/string.mjs',
  `export const GET = () => { throw ${JSON.stringify(SECRET)}; };
`,
);

writeFixture(
  root,
  'api/errors/cause.mjs',
  `export const GET = () => {
  throw new Error('wrapped', { cause: new Error(${JSON.stringify(SECRET)}) });
};
`,
);

writeFixture(
  root,
  'api/errors/status-like.mjs',
  `export const GET = () => {
  const error = new Error(${JSON.stringify(SECRET)});
  error.status = 400;
  error.statusCode = 400;
  error.expose = true;
  throw error;
};
`,
);

writeFixture(
  root,
  'api/errors/to-json.mjs',
  `export const GET = () => {
  throw { message: ${JSON.stringify(SECRET)}, toJSON() { return { leaked: ${JSON.stringify(SECRET)} }; } };
};
`,
);

writeFixture(
  root,
  'api/echo.mjs',
  `const echo = async (request) => {
  const text = await request.text();
  return Response.json({ length: text.length });
};
export const POST = echo;
export const PUT = echo;
export const PATCH = echo;
export const DELETE = echo;
`,
);

const manifest = discoverRoutes(root);

const SESSION: Session = {
  id: 'session-deny-matrix',
  csrfToken: 'csrf-token-deny-matrix-0123456789',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

function buildApp(overrides: Partial<AppOptions> = {}): Promise<Hono<AppEnv>> {
  return createApp({ manifest, onError: () => undefined, ...overrides });
}

async function send(app: Hono<AppEnv>, path: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(`${TEST_ORIGIN}${path}`, init));
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

// ---------------------------------------------------------------------------
// Method classification
// ---------------------------------------------------------------------------

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

describe('deny matrix: method classification', () => {
  it('classifies every method the pipeline dispatches as mutating or safe', () => {
    const classified = new Set<string>([...MUTATING_METHODS, ...SAFE_METHODS]);
    assert.deepEqual(
      [...HTTP_METHODS].filter((method) => !classified.has(method)),
      [],
      'a new dispatchable method needs CSRF rows in this suite',
    );
    assert.equal(classified.size, HTTP_METHODS.length);
  });
});

// ---------------------------------------------------------------------------
// CSRF + same-origin on cookie-authenticated mutations
// ---------------------------------------------------------------------------

interface CsrfRow {
  readonly name: string;
  readonly origin: string | undefined;
  readonly token: string | undefined;
  readonly status: number;
  readonly code?: string;
}

const CSRF_ROWS: readonly CsrfRow[] = [
  {
    name: 'same origin and matching token',
    origin: TEST_ORIGIN,
    token: SESSION.csrfToken,
    status: 200,
  },
  {
    name: 'missing token',
    origin: TEST_ORIGIN,
    token: undefined,
    status: 403,
    code: 'csrf_mismatch',
  },
  { name: 'empty token', origin: TEST_ORIGIN, token: '', status: 403, code: 'csrf_mismatch' },
  {
    name: 'wrong token',
    origin: TEST_ORIGIN,
    token: 'not-the-token',
    status: 403,
    code: 'csrf_mismatch',
  },
  {
    name: 'token prefix',
    origin: TEST_ORIGIN,
    token: SESSION.csrfToken.slice(0, -1),
    status: 403,
    code: 'csrf_mismatch',
  },
  {
    name: 'token with suffix',
    origin: TEST_ORIGIN,
    token: `${SESSION.csrfToken}x`,
    status: 403,
    code: 'csrf_mismatch',
  },
  {
    name: 'cross origin with a valid token',
    origin: 'https://evil.example',
    token: SESSION.csrfToken,
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'missing Origin with a valid token',
    origin: undefined,
    token: SESSION.csrfToken,
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'opaque "null" Origin',
    origin: 'null',
    token: SESSION.csrfToken,
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'look-alike host suffix',
    origin: `${TEST_ORIGIN}.evil.example`,
    token: SESSION.csrfToken,
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'different port',
    origin: 'http://127.0.0.1:9998',
    token: SESSION.csrfToken,
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'different scheme',
    origin: 'https://127.0.0.1:9999',
    token: SESSION.csrfToken,
    status: 403,
    code: 'origin_mismatch',
  },
];

function mutationHeaders(row: CsrfRow): Record<string, string> {
  return {
    ...(row.origin === undefined ? {} : { origin: row.origin }),
    ...(row.token === undefined ? {} : { [CSRF_HEADER]: row.token }),
  };
}

describe('deny matrix: CSRF on cookie-authenticated mutations', async () => {
  const app = await buildApp({ authorize: () => true, resolveSession: () => SESSION });

  for (const method of MUTATING_METHODS) {
    for (const row of CSRF_ROWS) {
      it(`${method} ${row.name} -> ${row.status}${row.code ? ` ${row.code}` : ''}`, async () => {
        const response = await send(app, '/api/items', { method, headers: mutationHeaders(row) });
        assert.equal(response.status, row.status);
        if (row.code === undefined) {
          assert.deepEqual(await response.json(), { method });
        } else {
          assert.equal(await errorCode(response), row.code);
        }
      });
    }
  }

  for (const method of SAFE_METHODS) {
    it(`${method} is a read: a cross-origin request without a token is not CSRF-gated`, async () => {
      const response = await send(app, '/api/items', {
        method,
        headers: { origin: 'https://evil.example' },
      });
      assert.ok(response.status === 200 || response.status === 204, String(response.status));
    });
  }

  it('the CSRF gate runs before the module authorize and the handler', async () => {
    const response = await send(app, '/api/module-deny', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), 'origin_mismatch');
  });
});

interface AnonymousRow {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly code?: string;
}

/**
 * An anonymous unsafe request is login CSRF or forced registration when a
 * hostile page sends it, so the origin gate runs without a session too:
 * `Origin`, then `Sec-Fetch-Site`, then `Referer`. A request naming no site
 * passes only from a client without cookies.
 */
const ANONYMOUS_ROWS: readonly AnonymousRow[] = [
  { name: 'same Origin', headers: { origin: TEST_ORIGIN }, status: 200 },
  {
    name: 'cross Origin',
    headers: { origin: 'https://evil.example' },
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'opaque "null" Origin',
    headers: { origin: 'null' },
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'cross Origin with a same-origin Sec-Fetch-Site',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    status: 403,
    code: 'origin_mismatch',
  },
  { name: 'Sec-Fetch-Site same-origin', headers: { 'sec-fetch-site': 'same-origin' }, status: 200 },
  {
    name: 'Sec-Fetch-Site cross-site',
    headers: { 'sec-fetch-site': 'cross-site' },
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'Sec-Fetch-Site same-site',
    headers: { 'sec-fetch-site': 'same-site', referer: `${TEST_ORIGIN}/login` },
    status: 403,
    code: 'origin_mismatch',
  },
  { name: 'same-origin Referer', headers: { referer: `${TEST_ORIGIN}/login` }, status: 200 },
  {
    name: 'cross-site Referer',
    headers: { referer: 'https://evil.example/attack' },
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'unparseable Referer',
    headers: { referer: 'not a url' },
    status: 403,
    code: 'origin_mismatch',
  },
  { name: 'no site headers and no cookie (a non-browser client)', headers: {}, status: 200 },
  {
    name: 'no site headers but a cookie',
    headers: { cookie: 'session=stale' },
    status: 403,
    code: 'origin_mismatch',
  },
];

describe('deny matrix: anonymous mutations are origin-checked', async () => {
  const app = await buildApp({ authorize: () => true });

  for (const method of MUTATING_METHODS) {
    for (const row of ANONYMOUS_ROWS) {
      it(`${method} ${row.name} -> ${row.status}${row.code ? ` ${row.code}` : ''}`, async () => {
        const response = await send(app, '/api/items', { method, headers: row.headers });
        assert.equal(response.status, row.status);
        if (row.code === undefined) {
          assert.deepEqual(await response.json(), { method });
        } else {
          assert.equal(await errorCode(response), row.code);
        }
      });
    }
  }

  it('a same-origin anonymous mutation still meets authorize', async () => {
    const requireSession: Authorize = (context) => context.session !== null;
    const gated = await buildApp({ authorize: requireSession });
    const response = await send(gated, '/api/items', {
      method: 'POST',
      headers: { origin: TEST_ORIGIN },
    });
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), 'forbidden');
  });
});

// ---------------------------------------------------------------------------
// Default-deny API authorization
// ---------------------------------------------------------------------------

interface AuthorizeRow {
  readonly name: string;
  readonly authorize: Authorize | undefined;
  readonly allowed: boolean;
}

/** Bypass the declared `boolean` return to probe non-boolean results. */
function returning(value: unknown): Authorize {
  return () => value as boolean;
}

const AUTHORIZE_ROWS: readonly AuthorizeRow[] = [
  { name: 'no authorize callback', authorize: undefined, allowed: false },
  { name: 'false', authorize: () => false, allowed: false },
  { name: 'truthy number 1', authorize: returning(1), allowed: false },
  { name: 'string "true"', authorize: returning('true'), allowed: false },
  { name: 'empty object', authorize: returning({}), allowed: false },
  { name: 'Boolean object wrapping true', authorize: returning(Object(true)), allowed: false },
  { name: 'undefined', authorize: returning(undefined), allowed: false },
  { name: 'null', authorize: returning(null), allowed: false },
  {
    name: 'promise of 1',
    authorize: () => Promise.resolve(1 as unknown as boolean),
    allowed: false,
  },
  {
    name: 'synchronous throw',
    authorize: () => {
      throw new Error(SECRET);
    },
    allowed: false,
  },
  { name: 'rejection', authorize: () => Promise.reject(new Error(SECRET)), allowed: false },
  { name: 'exact true', authorize: () => true, allowed: true },
  { name: 'promise of true', authorize: () => Promise.resolve(true), allowed: true },
];

describe('deny matrix: default-deny API authorization', () => {
  for (const row of AUTHORIZE_ROWS) {
    for (const method of ['GET', 'POST'] as const) {
      it(`${method} with authorize ${row.name} -> ${row.allowed ? 'allowed' : 'denied'}`, async () => {
        const app = await buildApp(row.authorize === undefined ? {} : { authorize: row.authorize });
        const response = await send(app, '/api/items', {
          method,
          headers: { origin: TEST_ORIGIN },
        });
        if (row.allowed) {
          assert.equal(response.status, 200);
          return;
        }
        assert.equal(response.status, 403);
        const raw = await response.text();
        assert.ok(!raw.includes(SECRET), 'a denial must not echo the authorize failure');
        assert.equal((JSON.parse(raw) as { error: { code: string } }).error.code, 'forbidden');
      });
    }
  }

  it('a module authorize can only restrict a global allow', async () => {
    const app = await buildApp({ authorize: () => true });
    for (const path of ['/api/module-deny', '/api/module-truthy']) {
      const response = await send(app, path);
      assert.equal(response.status, 403, path);
      assert.equal(await errorCode(response), 'forbidden');
    }
  });

  it('a module authorize never widens a global deny', async () => {
    const app = await buildApp({ authorize: () => false });
    const response = await send(app, '/api/plain');
    assert.equal(response.status, 403);
  });
});

// ---------------------------------------------------------------------------
// Default no-store caching
// ---------------------------------------------------------------------------

interface CacheRow {
  readonly name: string;
  readonly path: string;
  readonly method?: string;
  readonly session: boolean;
  /** `private` means the response must be `private, no-store`. */
  readonly expect: 'private' | 'public';
}

const CACHE_ROWS: readonly CacheRow[] = [
  { name: 'undeclared route, anonymous', path: '/api/plain', session: false, expect: 'private' },
  { name: 'undeclared route, sessioned', path: '/api/plain', session: true, expect: 'private' },
  {
    name: 'declared public route, anonymous',
    path: '/api/cached',
    session: false,
    expect: 'public',
  },
  {
    name: 'declared public route, sessioned',
    path: '/api/cached',
    session: true,
    expect: 'private',
  },
  {
    name: 'declared public route, POST',
    path: '/api/cached',
    method: 'POST',
    session: false,
    expect: 'private',
  },
  {
    name: 'declared public route setting a cookie',
    path: '/api/cached-cookie',
    session: false,
    expect: 'private',
  },
  {
    name: 'handler-set public header with a cookie',
    path: '/api/explicit-public-cookie',
    session: false,
    expect: 'private',
  },
];

describe('deny matrix: default no-store caching', () => {
  for (const row of CACHE_ROWS) {
    it(`${row.name} -> ${row.expect}`, async () => {
      const app = await buildApp({
        authorize: () => true,
        ...(row.session ? { resolveSession: () => SESSION } : {}),
      });
      const method = row.method ?? 'GET';
      const headers: Record<string, string> = { origin: TEST_ORIGIN };
      if (row.session && method !== 'GET') headers[CSRF_HEADER] = SESSION.csrfToken;
      const response = await send(app, row.path, { method, headers });
      assert.equal(response.status, 200);
      const cacheControl = response.headers.get('cache-control') ?? '';
      if (row.expect === 'private') {
        assert.equal(cacheControl, 'private, no-store');
        assert.equal(response.headers.get('surrogate-control'), null);
      } else {
        assert.match(cacheControl, /^public,/);
      }
    });
  }

  it('error responses are never publicly cacheable', async () => {
    const app = await buildApp({ authorize: () => false });
    const response = await send(app, '/api/cached');
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.headers.get('cache-control') ?? '', /public/);
  });
});

// ---------------------------------------------------------------------------
// Value-free errors
// ---------------------------------------------------------------------------

/**
 * `string` and `to-json` throw values that are not `Error`s. Hono's own error
 * stage ignores those, so createApp normalizes them into the same envelope.
 */
const ERROR_ROUTES: readonly string[] = [
  'sync',
  'async',
  'string',
  'cause',
  'status-like',
  'to-json',
];

describe('deny matrix: value-free error envelopes', () => {
  for (const route of ERROR_ROUTES) {
    it(`a ${route} handler failure returns the generic 500 envelope`, async () => {
      const app = await buildApp({ authorize: () => true });
      const response = await send(app, `/api/errors/${route}`);
      const raw = await response.text();
      assert.equal(response.status, 500);
      assert.ok(!raw.includes(SECRET), 'the error envelope must not echo the thrown value');
      assert.doesNotMatch(raw, /id_rsa|\.ssh|\bat .*:\d+:\d+/);
      assert.deepEqual(JSON.parse(raw), {
        error: { status: 500, code: 'internal_error', message: 'Internal Server Error' },
      });
    });
  }

  it('reports a thrown non-Error value to onError as it was thrown', async () => {
    const reported: unknown[] = [];
    const app = await buildApp({
      authorize: () => true,
      onError: (error) => {
        reported.push(error);
      },
    });
    const response = await send(app, '/api/errors/string');
    await response.text();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(response.headers.has('x-request-id'));
    assert.deepEqual(reported, [SECRET]);
  });

  it('keeps the envelope value-free for a non-Error throw requested as HTML', async () => {
    const app = await buildApp({ authorize: () => true });
    const response = await send(app, '/api/errors/to-json', {
      headers: { accept: 'text/html' },
    });
    const raw = await response.text();
    assert.equal(response.status, 500);
    assert.ok(!raw.includes(SECRET));
  });

  it('a throwing resolveSession fails closed without leaking', async () => {
    const app = await buildApp({
      authorize: (context) => context.session !== null,
      resolveSession: () => {
        throw new Error(SECRET);
      },
    });
    const response = await send(app, '/api/plain');
    const raw = await response.text();
    assert.equal(response.status, 403);
    assert.ok(!raw.includes(SECRET));
  });

  it('an unknown route answers 404 without echoing the requested path', async () => {
    const app = await buildApp({ authorize: () => true });
    const probe = `/api/${encodeURIComponent(`<script>${SECRET}</script>`)}`;
    const response = await send(app, probe, { headers: { accept: 'application/json' } });
    const raw = await response.text();
    assert.equal(response.status, 404);
    assert.ok(!raw.includes(SECRET));
    assert.ok(!raw.includes('<script>'));
  });
});

// ---------------------------------------------------------------------------
// Body limits
// ---------------------------------------------------------------------------

interface BodyRow {
  readonly name: string;
  readonly bytes: number;
  readonly streamed: boolean;
  readonly status: number;
}

const LIMIT = 64;

const BODY_ROWS: readonly BodyRow[] = [
  { name: 'declared length under the cap', bytes: LIMIT - 1, streamed: false, status: 200 },
  { name: 'declared length at the cap', bytes: LIMIT, streamed: false, status: 200 },
  { name: 'declared length one over the cap', bytes: LIMIT + 1, streamed: false, status: 413 },
  { name: 'declared length far over the cap', bytes: LIMIT * 100, streamed: false, status: 413 },
  { name: 'streamed body under the cap', bytes: LIMIT - 1, streamed: true, status: 200 },
  { name: 'streamed body over the cap', bytes: LIMIT * 4, streamed: true, status: 413 },
];

function streamOf(bytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(16).fill(0x61);
  let remaining = bytes;
  return new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(remaining, chunk.length);
      remaining -= size;
      controller.enqueue(chunk.slice(0, size));
    },
  });
}

describe('deny matrix: request-body limits', () => {
  for (const method of MUTATING_METHODS) {
    for (const row of BODY_ROWS) {
      it(`${method} ${row.name} -> ${row.status}`, async () => {
        const app = await buildApp({ authorize: () => true, maxBodyBytes: LIMIT });
        const init: RequestInit & { duplex?: 'half' } = {
          method,
          headers: { origin: TEST_ORIGIN, 'content-type': 'text/plain' },
        };
        if (row.streamed) {
          init.body = streamOf(row.bytes);
          init.duplex = 'half';
        } else {
          init.body = 'a'.repeat(row.bytes);
        }
        const response = await send(app, '/api/echo', init);
        assert.equal(response.status, row.status);
        if (row.status === 413) {
          assert.equal(await errorCode(response), 'payload_too_large');
        } else {
          assert.deepEqual(await response.json(), { length: row.bytes });
        }
      });
    }
  }

  it('the body limit applies before authorization and CSRF', async () => {
    const app = await buildApp({ resolveSession: () => SESSION, maxBodyBytes: LIMIT });
    const response = await send(app, '/api/echo', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: 'a'.repeat(LIMIT + 1),
    });
    assert.equal(response.status, 413);
  });
});
