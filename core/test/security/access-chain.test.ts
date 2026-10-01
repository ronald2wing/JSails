/**
 * The access chain (`security/access-chain.ts`) against an assembled app: its
 * order (the cross-site check, then the gate, then the route's own code, with
 * no body byte read for a request either refuses), the verdicts it maps to
 * statuses, the seal on every denial (no-store and no `Set-Cookie`; a
 * response transform that adds a cookie to every answer never reaches one),
 * the identity a surface's declared
 * credentials let it act on, and the one fact the cache policy takes from an
 * admission.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Hono } from 'hono';

import { legacyAccess, publicAccess } from '../../src/api/access-ref.js';
import type { Session } from '../../src/contracts/http.js';
import { runExtensions } from '../../src/extensions/index.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { isPubliclyCacheable } from '../../src/security/access-record.js';
import { publicFilesSurface } from '../../src/security/surfaces.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import type { AppEnv } from '../../src/server/env.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import type { RequestScopeSpec } from '../../src/server/request-scope.js';
import { TEST_ORIGIN, writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'security-access-chain-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Where the fixtures record what ran, so a test can assert the order. */
const LOG = Symbol.for('jsails.test.access-chain.log');

function log(): string[] {
  const existing: unknown = Reflect.get(globalThis, LOG);
  if (Array.isArray(existing)) return existing as string[];
  const fresh: string[] = [];
  Reflect.set(globalThis, LOG, fresh);
  return fresh;
}

const record = `const log = (entry) => globalThis[Symbol.for(${JSON.stringify(LOG.description)})].push(entry);\n`;

writeFixture(
  root,
  'api/notes.mjs',
  `${record}export const authorize = ({ request }) => {
  log('gate');
  if (request.headers.get('x-fault') === '1') throw new Error('policy store down');
  return request.headers.get('x-allow') === '1';
};
export const POST = async (request) => {
  log('handler');
  return Response.json({ length: (await request.text()).length });
};
`,
);

const SESSION: Session = { id: 's1', data: {}, expiresAt: 2_000_000_000_000 };

/** A request body that counts the bytes a consumer pulls; it never pre-fills its queue. */
function countingBody(): { readonly body: ReadableStream<Uint8Array>; pulled(): number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= 64 * 1024) {
          controller.close();
          return;
        }
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

async function buildApp(overrides: Partial<AppOptions> = {}): Promise<Hono<AppEnv>> {
  return createApp({ manifest: discoverRoutes(root), onError: () => undefined, ...overrides });
}

async function postNotes(
  app: Hono<AppEnv>,
  headers: Record<string, string>,
): Promise<{ readonly response: Response; readonly pulled: number; readonly ran: string[] }> {
  const ran = log();
  ran.length = 0;
  const counted = countingBody();
  const response = await app.fetch(
    new Request(`${TEST_ORIGIN}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...headers },
      body: counted.body,
      duplex: 'half',
    } as RequestInit),
  );
  return { response, pulled: counted.pulled(), ran: [...ran] };
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

describe('the access chain order', () => {
  it('refuses a cross-site request before the gate runs, reading no body byte', async () => {
    const app = await buildApp();
    const { response, pulled, ran } = await postNotes(app, {
      origin: 'https://evil.example',
      'x-allow': '1',
    });
    assert.equal(response.status, 403);
    assert.equal(await codeOf(response), 'access.cross_site');
    assert.deepEqual(ran, []);
    assert.equal(pulled, 0);
  });

  it('refuses a gate-denied request before the handler runs, reading no body byte', async () => {
    const app = await buildApp();
    const { response, pulled, ran } = await postNotes(app, { origin: TEST_ORIGIN });
    assert.equal(response.status, 401);
    assert.equal(await codeOf(response), 'request.unauthenticated');
    assert.deepEqual(ran, ['gate']);
    assert.equal(pulled, 0);
  });

  it('answers a signed-in caller the gate denies 403', async () => {
    const app = await buildApp({ resolveSession: () => SESSION });
    const { response, pulled } = await postNotes(app, { origin: TEST_ORIGIN, cookie: 'sid=1' });
    assert.equal(response.status, 403);
    assert.equal(await codeOf(response), 'request.forbidden');
    assert.equal(pulled, 0);
  });

  it('answers a throwing gate as a reported 503 fault, reading no body byte', async () => {
    const phases: string[] = [];
    const app = await buildApp({
      onError: (_error, info) => {
        phases.push(info.phase);
      },
    });
    const { response, pulled } = await postNotes(app, { origin: TEST_ORIGIN, 'x-fault': '1' });
    assert.equal(response.status, 503);
    assert.equal(await codeOf(response), 'access.fault');
    assert.deepEqual(phases, ['authorize']);
    assert.equal(pulled, 0);
  });

  it('runs the handler, which reads the body, only after both pass', async () => {
    const app = await buildApp();
    const { response, pulled, ran } = await postNotes(app, {
      'sec-fetch-site': 'same-origin',
      'x-allow': '1',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { length: 64 * 1024 });
    assert.deepEqual(ran, ['gate', 'handler']);
    assert.ok(pulled >= 64 * 1024);
  });
});

describe('the denial seal', () => {
  /** An app whose response transform adds a cookie to every API answer. */
  async function cookieSettingApp(): Promise<Hono<AppEnv>> {
    const runtime = await runExtensions(
      [
        {
          name: 'refresher',
          setup: ({ routes }) =>
            routes.transform(['api'], (response) => {
              const headers = new Headers(response.headers);
              headers.set('set-cookie', 'refreshed=1; HttpOnly');
              headers.set('surrogate-control', 'max-age=600');
              return new Response(response.body, { status: response.status, headers });
            }),
        },
      ],
      { rootDir: import.meta.dirname },
    );
    return buildApp({ contributions: { routes: runtime.routes, transforms: runtime.transforms } });
  }

  for (const [label, headers] of [
    ['a cross-site refusal', { origin: 'https://evil.example' }],
    ['a gate denial', { origin: TEST_ORIGIN }],
    ['a fault', { origin: TEST_ORIGIN, 'x-fault': '1' }],
  ] as const) {
    it(`sends ${label} no-store and without the cookie a transform adds`, async () => {
      const app = await cookieSettingApp();
      const { response } = await postNotes(app, headers);
      assert.ok(response.status >= 400, String(response.status));
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('surrogate-control'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    });
  }

  it('leaves an admitted answer its cookie (the control)', async () => {
    const app = await cookieSettingApp();
    const { response } = await postNotes(app, { origin: TEST_ORIGIN, 'x-allow': '1' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), 'refreshed=1; HttpOnly');
  });
});

describe('declared credentials', () => {
  const credentialsRoot = mkdtempSync(join(distDir, 'security-access-credentials-'));
  after(() => rmSync(credentialsRoot, { recursive: true, force: true }));
  const api = JSON.stringify(pathToFileURL(join(distDir, 'src/api/index.js')).href);
  // The route the finding names: a write that only header tokens may drive.
  writeFixture(
    credentialsRoot,
    'api/transfer.mjs',
    `import { defineApi } from ${api};
export default defineApi('/api/transfer', {
  access: ({ session }) => session !== null,
  credentials: ['token'],
  POST: ({ session }) => Response.json({ actedAs: session.id }),
});
`,
  );
  for (const [name, credentials] of [
    ['cookie-only', ['cookie']],
    ['no-credentials', []],
  ] as const) {
    writeFixture(
      credentialsRoot,
      `api/${name}.mjs`,
      `import { defineApi, publicAccess } from ${api};
export default defineApi('/api/${name}', {
  access: publicAccess('declared-credentials probe'),
  credentials: ${JSON.stringify(credentials)},
  GET: ({ session }) => Response.json({ session: session?.id ?? null }),
  POST: ({ session }) => Response.json({ session: session?.id ?? null }),
});
`,
    );
  }

  const VICTIM: Session = { id: 'victim', data: { authMethod: 'cookie' }, expiresAt: 2e12 };
  const HOLDER: Session = { id: 'holder', data: { authMethod: 'bearer' }, expiresAt: 2e12 };

  /** The app, the resolver's calls, and the identities the request scope saw. */
  function credentialsApp(overrides: Partial<AppOptions> = {}): {
    readonly app: Promise<Hono<AppEnv>>;
    readonly resolved: string[];
    readonly scoped: (string | null)[];
  } {
    const resolved: string[] = [];
    const scoped: (string | null)[] = [];
    const scope: RequestScopeSpec = {
      name: 'probe',
      cache: 'transparent',
      resolve: ({ identity }) => {
        scoped.push(identity?.id ?? null);
        return undefined;
      },
    };
    const app = createApp({
      manifest: discoverRoutes(credentialsRoot),
      onError: () => undefined,
      requestScopes: [scope],
      resolveSession: (request) => {
        resolved.push(new URL(request.url).pathname);
        if (request.headers.get('authorization') === 'Bearer t1') return HOLDER;
        return request.headers.get('cookie') === 'sid=victim' ? VICTIM : null;
      },
      ...overrides,
    });
    return { app, resolved, scoped };
  }

  async function send(
    app: Hono<AppEnv>,
    method: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const response = await app.fetch(new Request(`${TEST_ORIGIN}${path}`, { method, headers }));
    return { status: response.status, body: await response.json() };
  }

  it('never acts on a cookie session for a token-only route, even cross-site', async () => {
    const { app, scoped } = credentialsApp();
    const crossSite = await send(await app, 'POST', '/api/transfer', {
      origin: 'https://evil.example',
      cookie: 'sid=victim',
    });
    assert.equal(crossSite.status, 401);
    assert.equal((crossSite.body as { code: string }).code, 'request.unauthenticated');
    const sameOrigin = await send(await app, 'POST', '/api/transfer', {
      origin: TEST_ORIGIN,
      cookie: 'sid=victim',
    });
    assert.equal(sameOrigin.status, 401);
    // The request scopes resolve with the identity the route accepts, too.
    assert.deepEqual(scoped, [null, null]);
  });

  it('acts on a header token for a token-only route, with no cross-site check', async () => {
    const { app, scoped } = credentialsApp();
    const answer = await send(await app, 'POST', '/api/transfer', {
      origin: 'https://evil.example',
      authorization: 'Bearer t1',
    });
    assert.deepEqual(answer, { status: 200, body: { actedAs: 'holder' } });
    assert.deepEqual(scoped, ['holder']);
  });

  it('treats a header token as no identity on a cookie-only route', async () => {
    const { app } = credentialsApp();
    const token = await send(await app, 'GET', '/api/cookie-only', { authorization: 'Bearer t1' });
    assert.deepEqual(token, { status: 200, body: { session: null } });
    const cookie = await send(await app, 'GET', '/api/cookie-only', { cookie: 'sid=victim' });
    assert.deepEqual(cookie, { status: 200, body: { session: 'victim' } });
  });

  it('never resolves an identity for a route that declares no credentials', async () => {
    const { app, resolved, scoped } = credentialsApp();
    for (const method of ['GET', 'POST']) {
      const answer = await send(await app, method, '/api/no-credentials', {
        origin: 'https://evil.example',
        cookie: 'sid=victim',
        authorization: 'Bearer t1',
      });
      assert.deepEqual(answer, { status: 200, body: { session: null } });
    }
    assert.deepEqual(resolved, []);
    assert.deepEqual(scoped, [null, null]);
  });

  it('holds for registrar routes as for API modules', async () => {
    const { routes, contributions } = createHttpRoutes({
      owner: 'acme',
      origin: 'code-plugin',
      allow: { mount: true, guard: false, transform: false },
    });
    const probe = ({ session }: { readonly session: Session | null }) =>
      Response.json({ session: session?.id ?? null });
    routes.add({
      methods: ['POST'],
      path: '/acme/tokens-only',
      access: publicAccess('declared-credentials probe'),
      credentials: ['token'],
      handler: probe,
    });
    // A mount reads only its request, so what it can show is that nothing resolved.
    routes.mount('/acme/mounted', () => Response.json({ reached: true }), {
      access: publicAccess('declared-credentials probe'),
      credentials: [],
    });
    const { app, resolved } = credentialsApp({ contributions: contributions() });
    const cookie = { origin: 'https://evil.example', cookie: 'sid=victim' };
    assert.deepEqual(await send(await app, 'POST', '/acme/tokens-only', cookie), {
      status: 200,
      body: { session: null },
    });
    assert.deepEqual(await send(await app, 'POST', '/acme/mounted/x', cookie), {
      status: 200,
      body: { reached: true },
    });
    assert.deepEqual(resolved, ['/acme/tokens-only']);
  });
});

describe('isPubliclyCacheable', () => {
  const open = publicFilesSurface();
  const checked = { ...open, access: legacyAccess(() => true) };

  it('is true only for a public surface and an anonymous caller', () => {
    assert.equal(isPubliclyCacheable({ surface: open, anonymous: true }), true);
    assert.equal(isPubliclyCacheable({ surface: open, anonymous: false }), false);
    assert.equal(isPubliclyCacheable({ surface: checked, anonymous: true }), false);
    const reasoned = { ...open, access: publicAccess('another public reason') };
    assert.equal(isPubliclyCacheable({ surface: reasoned, anonymous: true }), true);
  });
});
