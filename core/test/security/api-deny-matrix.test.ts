/**
 * Consolidated, table-driven deny matrix for filesystem API routes served by
 * `createApp`: the cross-site check on unsafe requests (cookie-authenticated
 * and anonymous alike), the access chain's verdicts (only an exact `true`
 * admits; a denial is 401 for an anonymous caller, a throw a reported 503),
 * default `no-store` caching for sessioned and denied responses, value-free
 * error envelopes, and request-body limits.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Hono } from 'hono';

import type { Authorize, Session } from '../../src/contracts/http.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
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

/** The access statement of a fixture open to every caller the chain lets through. */
const ALLOW = 'export const authorize = () => true;\n';

/** The access statement of a fixture whose answers a shared cache may keep. */
const PUBLIC = `import { publicAccess } from ${JSON.stringify(
  pathToFileURL(join(distDir, 'src/api/access-ref.js')).href,
)};\nexport const access = publicAccess('deny-matrix cached route');\n`;

/**
 * The global the `verdict` fixture's access check delegates to, so one route
 * can be probed with every return value a check might produce.
 */
const GATE = Symbol.for('jsails.test.api-deny-matrix.gate');

function setGate(gate: Authorize): void {
  Reflect.set(globalThis, GATE, gate);
}

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
${ALLOW}`,
);

writeFixture(
  root,
  'api/verdict.mjs',
  `export const authorize = (context) => globalThis[Symbol.for(${JSON.stringify(GATE.description)})](context);
export const GET = () => Response.json({ reached: true });
export const POST = () => Response.json({ reached: true });
`,
);

writeFixture(
  root,
  'api/signed-in.mjs',
  `export const authorize = (context) => context.session !== null;
export const GET = () => Response.json({ reached: true });
export const POST = () => Response.json({ reached: true });
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
${ALLOW}`,
);

writeFixture(
  root,
  'api/cached.mjs',
  `export const cacheControl = { maxAge: 60, staleWhileRevalidate: 30 };
export const GET = () => Response.json({ ok: true });
export const POST = () => Response.json({ ok: true });
${PUBLIC}`,
);

writeFixture(
  root,
  'api/cached-checked.mjs',
  `export const cacheControl = { maxAge: 60 };
export const GET = () => Response.json({ ok: true });
${ALLOW}`,
);

writeFixture(
  root,
  'api/cached-deny.mjs',
  `export const cacheControl = { maxAge: 60 };
export const GET = () => Response.json({ ok: true });
export const authorize = () => false;
`,
);

writeFixture(
  root,
  'api/cached-cookie.mjs',
  `export const cacheControl = { maxAge: 60 };
export const GET = () => new Response('{}', {
  headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; HttpOnly' },
});
${PUBLIC}`,
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
${PUBLIC}`,
);

writeFixture(
  root,
  'api/errors/sync.mjs',
  `export const GET = () => { throw new Error(${JSON.stringify(`${SECRET} /home/alice/.ssh/id_rsa`)}); };
${ALLOW}`,
);

writeFixture(
  root,
  'api/errors/async.mjs',
  `export const GET = async () => { throw new Error(${JSON.stringify(SECRET)}); };
${ALLOW}`,
);

writeFixture(
  root,
  'api/errors/string.mjs',
  `export const GET = () => { throw ${JSON.stringify(SECRET)}; };
${ALLOW}`,
);

writeFixture(
  root,
  'api/errors/cause.mjs',
  `export const GET = () => {
  throw new Error('wrapped', { cause: new Error(${JSON.stringify(SECRET)}) });
};
${ALLOW}`,
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
${ALLOW}`,
);

writeFixture(
  root,
  'api/errors/to-json.mjs',
  `export const GET = () => {
  throw { message: ${JSON.stringify(SECRET)}, toJSON() { return { leaked: ${JSON.stringify(SECRET)} }; } };
};
${ALLOW}`,
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
${ALLOW}`,
);

const manifest = discoverRoutes(root);

const SESSION: Session = {
  id: 'session-deny-matrix',
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
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  const body = (await response.json()) as { code?: string };
  return body.code;
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
      'a new dispatchable method needs cross-site rows in this suite',
    );
    assert.equal(classified.size, HTTP_METHODS.length);
  });
});

// ---------------------------------------------------------------------------
// The cross-site check on unsafe requests
// ---------------------------------------------------------------------------

interface SiteRow {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Whether the check admits it as sent from the app's own origin. */
  readonly sameOrigin: boolean;
}

/**
 * `Origin` must equal the app origin exactly; only when it is absent does
 * `Sec-Fetch-Site: same-origin` stand in. `Referer` and every other header
 * are never read, so a request naming no site is cross-site: there is no
 * token and no "non-browser client" exception.
 */
const SITE_ROWS: readonly SiteRow[] = [
  { name: 'same Origin', headers: { origin: TEST_ORIGIN }, sameOrigin: true },
  {
    name: 'Sec-Fetch-Site same-origin',
    headers: { 'sec-fetch-site': 'same-origin' },
    sameOrigin: true,
  },
  { name: 'cross Origin', headers: { origin: 'https://evil.example' }, sameOrigin: false },
  { name: 'opaque "null" Origin', headers: { origin: 'null' }, sameOrigin: false },
  {
    name: 'Origin with a trailing slash',
    headers: { origin: `${TEST_ORIGIN}/` },
    sameOrigin: false,
  },
  {
    name: 'look-alike host suffix',
    headers: { origin: `${TEST_ORIGIN}.evil.example` },
    sameOrigin: false,
  },
  { name: 'different port', headers: { origin: 'http://127.0.0.1:9998' }, sameOrigin: false },
  { name: 'different scheme', headers: { origin: 'https://127.0.0.1:9999' }, sameOrigin: false },
  {
    name: 'cross Origin with a same-origin Sec-Fetch-Site',
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    sameOrigin: false,
  },
  {
    name: 'Sec-Fetch-Site cross-site',
    headers: { 'sec-fetch-site': 'cross-site' },
    sameOrigin: false,
  },
  {
    name: 'Sec-Fetch-Site same-site',
    headers: { 'sec-fetch-site': 'same-site' },
    sameOrigin: false,
  },
  { name: 'Sec-Fetch-Site none', headers: { 'sec-fetch-site': 'none' }, sameOrigin: false },
  {
    name: 'same-origin Referer only',
    headers: { referer: `${TEST_ORIGIN}/login` },
    sameOrigin: false,
  },
  { name: 'no site headers', headers: {}, sameOrigin: false },
];

/** Assert a cross-site refusal: 403 `access.cross_site`, uncacheable, no cookie set. */
async function assertCrossSite(response: Response): Promise<void> {
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await errorCode(response), 'access.cross_site');
}

for (const [label, session] of [
  ['cookie-authenticated', SESSION],
  ['anonymous', null],
] as const) {
  describe(`deny matrix: the cross-site check on ${label} mutations`, async () => {
    const app = await buildApp({ resolveSession: () => session });
    const credential: Record<string, string> = session === null ? {} : { cookie: 'sid=abc' };

    for (const method of MUTATING_METHODS) {
      for (const row of SITE_ROWS) {
        it(`${method} ${row.name} -> ${row.sameOrigin ? '200' : '403 access.cross_site'}`, async () => {
          const response = await send(app, '/api/items', {
            method,
            headers: { ...credential, ...row.headers },
          });
          if (row.sameOrigin) {
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { method });
          } else {
            await assertCrossSite(response);
          }
        });
      }
    }
  });
}

describe('deny matrix: what the cross-site check leaves alone', async () => {
  const app = await buildApp({ resolveSession: () => SESSION });

  for (const method of SAFE_METHODS) {
    it(`${method} is a read: a cross-origin request is not checked`, async () => {
      const response = await send(app, '/api/items', {
        method,
        headers: { origin: 'https://evil.example', cookie: 'sid=abc' },
      });
      assert.ok(response.status === 200 || response.status === 204, String(response.status));
    });
  }

  it('the check runs before the access check and the handler', async () => {
    let gated = 0;
    setGate(() => {
      gated += 1;
      return true;
    });
    const response = await send(app, '/api/verdict', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    await assertCrossSite(response);
    assert.equal(gated, 0, 'the access check ran for a cross-site request');
  });

  for (const authMethod of ['bearer', 'api-token']) {
    it(`a ${authMethod} session mutates without naming a site`, async () => {
      const headerSession: Session = { ...SESSION, data: { authMethod } };
      const tokenApp = await buildApp({ resolveSession: () => headerSession });
      const response = await send(tokenApp, '/api/items', {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
      });
      assert.equal(response.status, 200);
    });
  }

  it('a same-origin anonymous mutation still meets the access check', async () => {
    const anonymous = await buildApp();
    const response = await send(anonymous, '/api/signed-in', {
      method: 'POST',
      headers: { origin: TEST_ORIGIN },
    });
    assert.equal(response.status, 401);
    assert.equal(await errorCode(response), 'request.unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// The access check's verdicts
// ---------------------------------------------------------------------------

interface VerdictRow {
  readonly name: string;
  readonly gate: Authorize;
  readonly outcome: 'allowed' | 'denied' | 'fault';
}

/** Bypass the declared `boolean` return to probe non-boolean results. */
function returning(value: unknown): Authorize {
  return () => value as boolean;
}

const VERDICT_ROWS: readonly VerdictRow[] = [
  { name: 'false', gate: () => false, outcome: 'denied' },
  { name: 'truthy number 1', gate: returning(1), outcome: 'denied' },
  { name: 'string "true"', gate: returning('true'), outcome: 'denied' },
  { name: 'empty object', gate: returning({}), outcome: 'denied' },
  { name: 'Boolean object wrapping true', gate: returning(Object(true)), outcome: 'denied' },
  { name: 'undefined', gate: returning(undefined), outcome: 'denied' },
  { name: 'null', gate: returning(null), outcome: 'denied' },
  {
    name: 'promise of 1',
    gate: () => Promise.resolve(1 as unknown as boolean),
    outcome: 'denied',
  },
  {
    name: 'synchronous throw',
    gate: () => {
      throw new Error(SECRET);
    },
    outcome: 'fault',
  },
  { name: 'rejection', gate: () => Promise.reject(new Error(SECRET)), outcome: 'fault' },
  { name: 'exact true', gate: () => true, outcome: 'allowed' },
  { name: 'promise of true', gate: () => Promise.resolve(true), outcome: 'allowed' },
];

/** The status and code each outcome answers an anonymous and a signed-in caller with. */
const OUTCOMES = {
  denied: { anonymous: [401, 'request.unauthenticated'], session: [403, 'request.forbidden'] },
  fault: { anonymous: [503, 'access.fault'], session: [503, 'access.fault'] },
} as const;

describe('deny matrix: only an exact true admits', () => {
  for (const row of VERDICT_ROWS) {
    for (const caller of ['anonymous', 'session'] as const) {
      for (const method of ['GET', 'POST'] as const) {
        it(`${method} by an ${caller} caller, check returning ${row.name} -> ${row.outcome}`, async () => {
          setGate(row.gate);
          const app = await buildApp(caller === 'session' ? { resolveSession: () => SESSION } : {});
          const response = await send(app, '/api/verdict', {
            method,
            headers: {
              origin: TEST_ORIGIN,
              ...(caller === 'session' ? { cookie: 'sid=abc' } : {}),
            },
          });
          if (row.outcome === 'allowed') {
            assert.equal(response.status, 200);
            return;
          }
          const [status, code] = OUTCOMES[row.outcome][caller];
          assert.equal(response.status, status);
          assert.equal(response.headers.get('cache-control'), 'private, no-store');
          const raw = await response.text();
          assert.ok(!raw.includes(SECRET), 'a denial must not echo the check failure');
          assert.equal((JSON.parse(raw) as { code: string }).code, code);
        });
      }
    }
  }

  it('reports a throwing check to onError with the authorize phase', async () => {
    setGate(() => {
      throw new Error(SECRET);
    });
    const phases: string[] = [];
    const app = await buildApp({
      onError: (_error, info) => {
        phases.push(info.phase);
      },
    });
    const response = await send(app, '/api/verdict');
    assert.equal(response.status, 503);
    assert.deepEqual(phases, ['authorize']);
  });

  it('refuses to assemble an app with an API module that states no access', async (t) => {
    const bare = mkdtempSync(join(distDir, 'security-api-bare-'));
    t.after(() => rmSync(bare, { recursive: true, force: true }));
    writeFixture(bare, 'api/open.mjs', 'export const GET = () => Response.json({});\n');
    await assert.rejects(createApp({ manifest: discoverRoutes(bare) }), {
      code: 'surface.missing_access',
    });
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
    name: 'declared route behind an access check, anonymous',
    path: '/api/cached-checked',
    session: false,
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
        ...(row.session ? { resolveSession: () => SESSION } : {}),
      });
      const method = row.method ?? 'GET';
      const headers: Record<string, string> = { origin: TEST_ORIGIN };
      if (row.session) headers['cookie'] = 'sid=abc';
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

  it('a denial of a declared route is never cacheable and sets no cookie', async () => {
    const app = await buildApp();
    const response = await send(app, '/api/cached-deny');
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('surrogate-control'), null);
    assert.equal(response.headers.get('set-cookie'), null);
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
    it(`a ${route} handler failure returns the bare 500 problem`, async () => {
      const app = await buildApp();
      const response = await send(app, `/api/errors/${route}`);
      const raw = await response.text();
      assert.equal(response.status, 500);
      assert.ok(!raw.includes(SECRET), 'the error envelope must not echo the thrown value');
      assert.doesNotMatch(raw, /id_rsa|\.ssh|\bat .*:\d+:\d+/);
      const { traceId, ...problem } = JSON.parse(raw) as Record<string, unknown>;
      assert.match(String(traceId), /^[0-9a-f]{32}$/);
      assert.deepEqual(problem, {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
      });
    });
  }

  it('reports a thrown non-Error value to onError as it was thrown', async () => {
    const reported: unknown[] = [];
    const app = await buildApp({
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
    const app = await buildApp();
    const response = await send(app, '/api/errors/to-json', {
      headers: { accept: 'text/html' },
    });
    const raw = await response.text();
    assert.equal(response.status, 500);
    assert.ok(!raw.includes(SECRET));
  });

  it('a throwing resolveSession fails closed without leaking', async () => {
    const app = await buildApp({
      resolveSession: () => {
        throw new Error(SECRET);
      },
    });
    const response = await send(app, '/api/signed-in', { headers: { cookie: 'sid=abc' } });
    const raw = await response.text();
    assert.equal(response.status, 401);
    assert.ok(!raw.includes(SECRET));
  });

  it('an unknown route answers 404 without echoing the requested path', async () => {
    const app = await buildApp();
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
        const app = await buildApp({ maxBodyBytes: LIMIT });
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
          assert.equal(await errorCode(response), 'request.too_large');
        } else {
          assert.deepEqual(await response.json(), { length: row.bytes });
        }
      });
    }
  }

  it('a declared length over the cap is refused before the access chain', async () => {
    let sessions = 0;
    const app = await buildApp({
      resolveSession: () => {
        sessions += 1;
        return SESSION;
      },
      maxBodyBytes: LIMIT,
    });
    const response = await send(app, '/api/echo', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-length': String(LIMIT + 1) },
      body: 'a'.repeat(LIMIT + 1),
    });
    assert.equal(response.status, 413);
    assert.equal(sessions, 0, 'no identity was resolved for a body refused by its length');
  });

  it('a body of unknown length is never read for a request the gate refuses', async () => {
    const app = await buildApp({ resolveSession: () => SESSION, maxBodyBytes: LIMIT });
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 16;
          controller.enqueue(new Uint8Array(16).fill(0x61));
        },
      },
      { highWaterMark: 0 },
    );
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body,
      duplex: 'half',
    };
    const response = await send(app, '/api/echo', init);
    assert.equal(response.status, 403);
    assert.equal(pulled, 0, 'body bytes read before the origin check refused');
  });
});
