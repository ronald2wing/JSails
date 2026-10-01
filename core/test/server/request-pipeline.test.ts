/**
 * Session resolution is lazy and memoized per request: a request no route
 * claims never touches the resolver, and a routed request resolves it once
 * however many stages read it. A header-authenticated session is exempt from
 * the cross-site check; a cookie session is not.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
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
writeFixture(
  root,
  'api/notes.mjs',
  `export const POST = () => Response.json({ ok: true });
export const authorize = () => true;\n`,
);
writeFixture(
  root,
  'api/context.mjs',
  `export const middleware = [
  async (context, next) => {
    globalThis.__contextProbe.middleware = context;
    return next();
  },
];
export const authorize = (context) => {
  globalThis.__contextProbe.authorize = context;
  return true;
};
export const GET = (request, context) => {
  globalThis.__contextProbe.handler = context;
  return Response.json({ id: context.session?.id ?? null });
};\n`,
);
const manifest = discoverRoutes(root);

const SESSION: Session = { id: 's1', data: {}, expiresAt: Date.now() + 60_000 };

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
    const res = await app.fetch(
      new Request('http://localhost/assets/app.js', { headers: { cookie: 'sid=1' } }),
    );
    assert.equal(res.status, 404);
    assert.equal(resolver.calls(), 0);
  });

  it('resolves once for an API route read by authorize gates and the handler', async () => {
    const resolver = countingResolver(SESSION);
    const app = await createApp({
      manifest,
      resolveSession: resolver.resolve,
    });
    const res = await app.fetch(
      new Request('http://localhost/api/me', { headers: { cookie: 'sid=1' } }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: 's1' });
    assert.equal(resolver.calls(), 1);
  });

  it('resolves once for an extension route and never for a request no route claims', async () => {
    const resolver = countingResolver(null);
    const runtime = await runExtensions(
      [
        {
          name: 'probe',
          setup: ({ routes }) => {
            const access = publicAccess('session resolution probe');
            routes.add({
              methods: ['GET'],
              path: '/whoami',
              access,
              handler: ({ session }) => Response.json({ session }),
            });
            routes.add({
              methods: ['GET'],
              path: '/static-ish',
              access,
              handler: () => new Response('ok'),
            });
          },
        },
      ],
      { rootDir: import.meta.dirname },
    );
    const app = await createApp({
      manifest,
      resolveSession: resolver.resolve,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
    });

    await app.fetch(new Request('http://localhost/static-ish', { headers: { cookie: 'sid=1' } }));
    assert.equal(resolver.calls(), 1, 'a plugin route claims the request');
    await app.fetch(new Request('http://localhost/nothing', { headers: { cookie: 'sid=1' } }));
    assert.equal(resolver.calls(), 1, 'an unmatched request claims nothing');

    const res = await app.fetch(
      new Request('http://localhost/whoami', { headers: { cookie: 'sid=1' } }),
    );
    assert.deepEqual(await res.json(), { session: null });
    assert.equal(resolver.calls(), 2);
  });
});

describe('the cross-site check for header-authenticated sessions', () => {
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
    });
    return app.fetch(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { cookie: 'sid=1', ...headers },
      }),
    );
  }

  for (const method of ['bearer', 'api-token']) {
    it(`lets a ${method} session mutate without Origin`, async () => {
      const res = await post(sessionWith(method));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    });
  }

  it('keeps the check for a cookie session', async () => {
    const res = await post(sessionWith('cookie'));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'access.cross_site');

    const sameOrigin = await post(sessionWith('cookie'), { origin: 'http://localhost' });
    assert.equal(sameOrigin.status, 200);
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
    middleware?: unknown;
    handler?: unknown;
  }
  const probe = (globalThis as { __contextProbe?: Probe }).__contextProbe ?? {};
  (globalThis as { __contextProbe?: Probe }).__contextProbe = probe;

  it('hands the access check, the middleware and the handler one RequestContext', async () => {
    const app = await createApp({ manifest, resolveSession: async () => SESSION });
    const res = await app.fetch(
      new Request('http://localhost/api/context?x=1', { headers: { cookie: 'sid=1' } }),
    );
    assert.deepEqual(await res.json(), { id: 's1' });
    assert.ok(probe.authorize !== undefined);
    assert.equal(probe.middleware, probe.authorize);
    assert.equal(probe.handler, probe.authorize);
  });
});
