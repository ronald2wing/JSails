/**
 * The compiled route boundary's fixed order: frame entry, the rate-limit
 * hook, the claim, the access chain (the cross-site check, then the gate),
 * the middleware and the terminal, then the transforms; a throw anywhere is
 * reported once and rendered inside the claim's bindings; a denial is sent
 * `private, no-store` without `Set-Cookie`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestErrorInfo } from '../../src/server/request-errors.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import type { RouteMiddleware } from '../../src/routing/middleware.js';
import { TEST_ORIGIN } from '../fixtures/app.js';

const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] } as const;

interface Harness {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly log: string[];
  readonly reports: { readonly error: unknown; readonly info: RequestErrorInfo }[];
}

async function harness(
  middleware: readonly RouteMiddleware[],
  handler: () => Response | Promise<Response>,
  options: Partial<AppOptions> = {},
): Promise<Harness> {
  const log: string[] = [];
  const reports: { error: unknown; info: RequestErrorInfo }[] = [];
  const registrar = createHttpRoutes({
    owner: 'app',
    origin: 'app',
    allow: { mount: true, guard: true, transform: true },
  });
  registrar.routes.add({
    methods: ['GET', 'POST'],
    path: '/probe',
    access: ({ request }) => {
      log.push('gate');
      return request.headers.get('x-deny') !== '1';
    },
    middleware,
    handler: async () => {
      log.push('handler');
      return handler();
    },
  });
  registrar.routes.transform(['api'], (response) => {
    log.push('transform');
    return response;
  });
  const app = await createApp({
    manifest: EMPTY_MANIFEST,
    contributions: registrar.contributions(),
    resolveSession: () => {
      log.push('claim');
      return null;
    },
    rateLimit: (routed) => {
      log.push('rate-limit');
      return routed.request.headers.get('x-limit') === '1'
        ? new Response('slow down', { status: 429 })
        : undefined;
    },
    onError: (error, info) => {
      reports.push({ error, info });
    },
    ...options,
  });
  return {
    fetch: async (path, init) => app.fetch(new Request(`${TEST_ORIGIN}${path}`, init)),
    log,
    reports,
  };
}

const passthrough =
  (log: string[], name: string): RouteMiddleware =>
  async (_context, next) => {
    log.push(`${name}:in`);
    const response = await next();
    log.push(`${name}:out`);
    return response;
  };

describe('route boundary', () => {
  it('runs the stages in their fixed order', async () => {
    const log: string[] = [];
    const h = await harness(
      [passthrough(log, 'a'), passthrough(log, 'b')],
      () => new Response('ok'),
    );
    const res = await h.fetch('/probe', { headers: { cookie: 'sid=1' } });
    assert.equal(res.status, 200);
    assert.deepEqual(h.log, ['rate-limit', 'claim', 'gate', 'handler', 'transform']);
    assert.deepEqual(log, ['a:in', 'b:in', 'b:out', 'a:out']);
  });

  it('refuses a cross-site unsafe request after the claim and before the gate', async () => {
    const h = await harness([], () => new Response('ok'));
    const res = await h.fetch('/probe', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, 'access.cross_site');
    assert.deepEqual(h.log, ['rate-limit', 'claim']);
  });

  it('lets a same-origin unsafe request through to the gate', async () => {
    const h = await harness([], () => new Response('ok'));
    const res = await h.fetch('/probe', { method: 'POST', headers: { origin: TEST_ORIGIN } });
    assert.equal(res.status, 200);
    assert.deepEqual(h.log, ['rate-limit', 'claim', 'gate', 'handler', 'transform']);
  });

  it('answers a rate-limited request before the claim', async () => {
    const h = await harness([], () => new Response('ok'));
    const res = await h.fetch('/probe', { headers: { 'x-limit': '1', cookie: 'sid=1' } });
    assert.equal(res.status, 429);
    assert.deepEqual(h.log, ['rate-limit']);
  });

  it('runs no middleware, handler or transform for a denied request', async () => {
    const log: string[] = [];
    const h = await harness([passthrough(log, 'a')], () => new Response('ok'));
    const res = await h.fetch('/probe', { headers: { 'x-deny': '1' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(h.log, ['rate-limit', 'claim', 'gate']);
    assert.deepEqual(log, []);
  });

  it('lets a middleware answer in place of the handler', async () => {
    const h = await harness(
      [() => new Response('stopped', { status: 401 })],
      () => new Response('ok'),
    );
    const res = await h.fetch('/probe');
    assert.equal(res.status, 401);
    assert.equal(await res.text(), 'stopped');
    assert.deepEqual(h.log, ['rate-limit', 'claim', 'gate', 'transform']);
  });

  it('refuses a second next() as a reported, value-free fault', async () => {
    const h = await harness(
      [
        async (_context, next) => {
          await next();
          return next();
        },
      ],
      () => new Response('ok'),
    );
    const res = await h.fetch('/probe');
    assert.equal(res.status, 500);
    assert.equal(h.log.filter((entry) => entry === 'handler').length, 1);
    assert.equal(h.reports.length, 1);
    assert.equal((h.reports[0]?.error as { code?: unknown }).code, 'route.next_called_twice');
    assert.equal(h.reports[0]?.info.route, '/probe');
  });

  it('refuses a handler answering something other than a Response', async () => {
    const h = await harness([], () => 'not a response' as unknown as Response);
    const res = await h.fetch('/probe');
    assert.equal(res.status, 500);
    assert.equal((h.reports[0]?.error as { code?: unknown }).code, 'route.invalid_answer');
    assert.doesNotMatch(await res.text(), /not a response/);
  });

  it('reports a throwing handler once and renders it value-free', async () => {
    const h = await harness([], () => {
      throw new Error('secret abc123');
    });
    const res = await h.fetch('/probe');
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /secret/);
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0]?.info.phase, 'handler');
  });

  it('does not let a middleware stage headers on the context', () => {
    const staging: RouteMiddleware = async (context, next) => {
      // @ts-expect-error -- a middleware has no Hono context to stage headers on.
      context.header('x-staged', '1');
      return next();
    };
    assert.equal(typeof staging, 'function');
  });
});
