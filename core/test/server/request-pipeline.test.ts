/**
 * Session resolution is lazy and memoized per request: a request no route
 * claims never touches the resolver, and a routed request resolves it once
 * however many stages read it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { createApp } from '../../src/server/app.js';
import type { Session } from '../../src/contracts/http.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { runExtensions } from '../../src/extensions/index.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'request-pipeline-'));
after(() => rmSync(root, { recursive: true, force: true }));

writeFixture(
  root,
  'api/me.mjs',
  `export const authorize = (context) => context.session !== null;
export const GET = (request, context) => Response.json({ id: context.session?.id ?? null });\n`,
);
writeFixture(root, 'api/notes.mjs', `export const POST = () => Response.json({ ok: true });\n`);
writeFixture(
  root,
  'api/context.mjs',
  `export const middleware = [
  async (c, next) => {
    if (c.req.header('x-swap-session') === '1') c.set('session', { ...c.var.session, id: 'swapped' });
    return next();
  },
];
export const GET = (request, context) => {
  globalThis.__contextProbe.handler = context;
  return Response.json({ id: context.session?.id ?? null });
};\n`,
);
const manifest = discoverRoutes(root);

const SESSION: Session = { id: 's1', csrfToken: 't', data: {}, expiresAt: Date.now() + 60_000 };

function countingResolver(result: Session | null): {
  readonly calls: () => number;
  readonly resolve: () => Promise<Session | null>;
} {
  let calls = 0;
  return {
    calls: () => calls,
    resolve: async () => {
      calls += 1;
      return result;
    },
  };
}

describe('lazy session resolution', () => {
  it('never resolves the session for an unmatched request', async () => {
    const resolver = countingResolver(SESSION);
    const app = await createApp({ manifest, resolveSession: resolver.resolve, onError: () => {} });
    const res = await app.fetch(new Request('http://localhost/assets/app.js'));
    assert.equal(res.status, 404);
    assert.equal(resolver.calls(), 0);
  });

  it('resolves once for an API route read by authorize gates and the handler', async () => {
    const resolver = countingResolver(SESSION);
    const app = await createApp({
      manifest,
      resolveSession: resolver.resolve,
      authorize: (context) => context.session !== null,
    });
    const res = await app.fetch(new Request('http://localhost/api/me'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 's1' });
    assert.equal(resolver.calls(), 1);
  });

  it('memoizes an anonymous result and exposes loadSession to extension routes', async () => {
    const resolver = countingResolver(null);
    const runtime = await runExtensions([
      {
        name: 'probe',
        setup: ({ configureHttp }) =>
          configureHttp((app) => {
            app.get('/whoami', async (c) => {
              const first = await c.var.loadSession?.();
              const second = await c.var.loadSession?.();
              return Response.json({ first: first ?? null, second: second ?? null });
            });
            app.get('/static-ish', () => new Response('ok'));
          }),
      },
    ]);
    const app = await createApp({
      manifest,
      resolveSession: resolver.resolve,
      httpHooks: runtime.httpHooks,
    });

    await app.fetch(new Request('http://localhost/static-ish'));
    assert.equal(resolver.calls(), 0);

    const res = await app.fetch(new Request('http://localhost/whoami'));
    assert.deepEqual(await res.json(), { first: null, second: null });
    assert.equal(resolver.calls(), 1);
  });
});

describe('CSRF for header-authenticated sessions', () => {
  function sessionWith(authMethod: string | undefined): Session {
    return {
      ...SESSION,
      data: authMethod === undefined ? {} : { authMethod },
    };
  }

  async function post(session: Session, headers: Record<string, string> = {}): Promise<Response> {
    const app = await createApp({
      manifest,
      resolveSession: async () => session,
      authorize: () => true,
    });
    return app.fetch(new Request('http://localhost/api/notes', { method: 'POST', headers }));
  }

  for (const method of ['bearer', 'api-token']) {
    it(`lets a ${method} session mutate without Origin or a CSRF token`, async () => {
      const res = await post(sessionWith(method));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });
  }

  it('keeps the Origin and CSRF checks for a cookie session', async () => {
    const res = await post(sessionWith('cookie'));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'origin_mismatch');

    const sameOrigin = await post(sessionWith('cookie'), { origin: 'http://localhost' });
    assert.equal(sameOrigin.status, 403);

    const valid = await post(sessionWith('cookie'), {
      origin: 'http://localhost',
      'x-csrf-token': 't',
    });
    assert.equal(valid.status, 200);
  });

  it('keeps the checks when the marker is absent or unrecognized', async () => {
    assert.equal((await post(sessionWith(undefined))).status, 403);
    assert.equal((await post(sessionWith('Bearer'))).status, 403);
    assert.equal((await post(sessionWith('session'))).status, 403);
  });
});

describe('per-request context cache', () => {
  interface Probe {
    authorize?: unknown;
    handler?: unknown;
  }
  const probe = (globalThis as { __contextProbe?: Probe }).__contextProbe ?? {};
  (globalThis as { __contextProbe?: Probe }).__contextProbe = probe;

  it('hands the authorize gate and the handler one RequestContext', async () => {
    const app = await createApp({
      manifest,
      resolveSession: async () => SESSION,
      authorize: (context) => {
        probe.authorize = context;
        return true;
      },
    });
    const res = await app.fetch(new Request('http://localhost/api/context?x=1'));
    assert.deepEqual(await res.json(), { id: 's1' });
    assert.ok(probe.authorize !== undefined);
    assert.equal(probe.handler, probe.authorize);
  });

  it('builds a fresh context once a middleware swaps the session', async () => {
    const app = await createApp({
      manifest,
      resolveSession: async () => SESSION,
      authorize: (context) => {
        probe.authorize = context;
        return true;
      },
    });
    const res = await app.fetch(
      new Request('http://localhost/api/context', { headers: { 'x-swap-session': '1' } }),
    );
    assert.deepEqual(await res.json(), { id: 'swapped' });
    assert.notEqual(probe.handler, probe.authorize);
    const handler = probe.handler as { url: URL };
    const gate = probe.authorize as { url: URL };
    assert.equal(handler.url, gate.url, 'the parsed URL is still shared');
  });
});
