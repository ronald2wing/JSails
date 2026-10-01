/**
 * Tests for the request handler: guards answer and fail through the one
 * finalizer, a challenge keeps its `WWW-Authenticate` without a report, a
 * throw of any shape is reported once and answered value-free, HEAD is
 * finalized from the GET answer, a host the app does not serve is refused
 * before any app code runs, and an answer a route middleware cloned or
 * consumed is still answered through the one finalizer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HTTPException } from 'hono/http-exception';

import { publicAccess } from '../../src/api/access-ref.js';
import { stream } from '../../src/api/responses.js';
import { HttpError, type RouteContext } from '../../src/contracts/http.js';
import type { RouteMiddleware } from '../../src/routing/middleware.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import type { Guard } from '../../src/server/request-frame.js';
import { appRoutes } from '../fixtures/app.js';

const EMPTY_MANIFEST: AppOptions['manifest'] = { entries: [], byRoute: new Map() };
const LARGE_TEXT = 'a line of compressible text\n'.repeat(200);
const CREDENTIALS = `Basic ${btoa('ada:secret')}`;

/** A guard that challenges every request without the expected credentials. */
const basicAuthGuard: Guard = (request) =>
  request.headers.get('authorization') === CREDENTIALS
    ? undefined
    : new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="staging"' },
      });

interface Harness {
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly reports: unknown[];
  readonly hits: string[];
}

/** A GET route at `path`, open to anyone, with `middleware` around `handler`. */
interface ProbeRoute {
  readonly path: string;
  readonly middleware?: readonly RouteMiddleware[];
  handler(context: RouteContext): Response | Promise<Response>;
}

async function harness(
  options: Partial<AppOptions> = {},
  extra: readonly ProbeRoute[] = [],
): Promise<Harness> {
  const reports: unknown[] = [];
  const hits: string[] = [];
  const probes: readonly ProbeRoute[] = [
    {
      path: '/text',
      handler: () => {
        hits.push('text');
        return new Response(LARGE_TEXT, { headers: { 'content-type': 'text/plain' } });
      },
    },
    {
      path: '/http-error',
      handler: () => {
        throw new HttpError('slow_down', 'Slow down.', 429, { 'retry-after': '30' });
      },
    },
    {
      path: '/thrown-string',
      handler: () => {
        throw 'a secret string';
      },
    },
    {
      // What Hono's own middleware throws for a challenge (`hono/basic-auth`).
      path: '/locked',
      handler: () => {
        throw new HTTPException(401, {
          res: new Response('Unauthorized', {
            status: 401,
            headers: { 'www-authenticate': 'Basic realm="Secure Area"' },
          }),
        });
      },
    },
    ...extra,
  ];
  const app = await createApp({
    manifest: EMPTY_MANIFEST,
    onError: (error) => {
      reports.push(error);
    },
    contributions: appRoutes((routes) => {
      for (const probe of probes) {
        routes.add({
          methods: ['GET'],
          path: probe.path,
          access: publicAccess('request handler probe'),
          ...(probe.middleware === undefined ? {} : { middleware: probe.middleware }),
          handler: (context) => probe.handler(context),
        });
      }
    }),
    ...options,
  });
  return { app, reports, hits };
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method, headers });
}

function assertSealed(response: Response): void {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
}

describe('request handler: guards', () => {
  it('answers a basic-auth challenge with 401 and WWW-Authenticate, and reports nothing', async () => {
    const { app, reports, hits } = await harness({ guards: [basicAuthGuard] });
    const response = await app.fetch(get('/text'));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Basic realm="staging"');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assertSealed(response);
    assert.equal(await response.text(), 'Unauthorized');
    assert.deepEqual(hits, [], 'the route behind the guard never ran');
    assert.deepEqual(reports, []);

    const allowed = await app.fetch(get('/text', { authorization: CREDENTIALS }));
    assert.equal(allowed.status, 200);
    assert.deepEqual(hits, ['text']);
  });

  it('fails a throwing guard with a value-free 500 and reports it once', async () => {
    const { app, reports } = await harness({
      guards: [
        () => {
          throw new Error('guard secret');
        },
      ],
    });
    const response = await app.fetch(get('/text'));
    assert.equal(response.status, 500);
    assertSealed(response);
    assert.doesNotMatch(await response.text(), /guard secret/);
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as Error).message, 'guard secret');
  });
});

describe('request handler: failures', () => {
  it("keeps a framework-thrown challenge's WWW-Authenticate with the problem body", async () => {
    const { app, reports } = await harness();
    const response = await app.fetch(get('/locked'));
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Basic realm=/);
    assert.equal(response.headers.get('content-type'), 'application/problem+json');
    assertSealed(response);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.status, 401);
    assert.equal(body.title, 'Unauthorized');
    assert.deepEqual(reports, []);
  });

  it('answers an HttpError with its status, code, message and headers, and reports nothing', async () => {
    const { app, reports } = await harness();
    const response = await app.fetch(get('/http-error'));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '30');
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 'slow_down');
    assert.equal(body.detail, 'Slow down.');
    assert.deepEqual(reports, []);
  });

  it('reports a thrown non-Error once, as thrown, and answers a bare 500', async () => {
    const { app, reports } = await harness();
    const response = await app.fetch(get('/thrown-string'));
    assert.equal(response.status, 500);
    assertSealed(response);
    const raw = await response.text();
    assert.doesNotMatch(raw, /secret/);
    assert.deepEqual(reports, ['a secret string']);
  });

  it('refuses a host the app does not serve with a sealed 421 before any route runs', async () => {
    const { app, hits } = await harness({ server: { origin: 'https://example.com' } });
    const response = await app.fetch(new Request('http://evil.example/text'));
    assert.equal(response.status, 421);
    assertSealed(response);
    assert.equal(((await response.json()) as { code: string }).code, 'http.misdirected_request');
    assert.deepEqual(hits, []);
  });
});

describe('request handler: HEAD', () => {
  it('finalizes a HEAD from the GET answer: same headers and length, no body', async () => {
    const { app } = await harness();
    const full = await app.fetch(get('/text'));
    const head = await app.fetch(get('/text', {}, 'HEAD'));
    assert.equal(head.status, 200);
    for (const name of ['content-length', 'content-type', 'cache-control', 'vary']) {
      assert.equal(head.headers.get(name), full.headers.get(name), name);
    }
    assert.equal(head.headers.get('content-length'), String(LARGE_TEXT.length));
    assert.equal(await head.text(), '');
  });

  it('labels an encoded HEAD with the coding a GET gets, without compressing for a length', async () => {
    const { app } = await harness();
    const headers = { 'accept-encoding': 'gzip' };
    const full = await app.fetch(get('/text', headers));
    const head = await app.fetch(get('/text', headers, 'HEAD'));
    assert.equal(full.headers.get('content-encoding'), 'gzip');
    assert.equal(head.headers.get('content-encoding'), 'gzip');
    assert.equal(head.headers.get('vary'), full.headers.get('vary'));
    // RFC 9110 lets a HEAD omit a length known only once the content is made.
    assert.equal(head.headers.get('content-length'), null);
    assert.equal(await head.text(), '');
  });
});

describe('request handler: answers a route middleware touched', () => {
  async function* chunks(): AsyncGenerator<string> {
    yield 'first,';
    yield 'second';
  }

  async function touched(touch: (response: Response) => Promise<unknown>): Promise<Harness> {
    return harness({}, [
      {
        path: '/touched',
        middleware: [
          async (_context, next) => {
            const response = await next();
            pending.push(touch(response));
            return response;
          },
        ],
        handler: () => stream(chunks(), { headers: { 'content-type': 'text/plain' } }),
      },
    ]);
  }

  /** What each middleware started on its copy; settled once the answer was read. */
  const pending: Promise<unknown>[] = [];

  it('streams a Respond.stream whose response a middleware cloned', async () => {
    // A tee branch's cancel settles once the other branch ends too.
    const { app, reports } = await touched(async (response) => response.clone().body?.cancel());
    const response = await app.fetch(get('/touched'));
    assert.equal(response.status, 200);
    assertSealed(response);
    assert.equal(await response.text(), 'first,second');
    await Promise.all(pending.splice(0));
    assert.deepEqual(reports, []);
  });

  it('answers a consumed body with a sealed, value-free 500 and reports it once', async () => {
    const { app, reports } = await touched((response) => response.text());
    const response = await app.fetch(get('/touched'));
    assert.equal(response.status, 500);
    assertSealed(response);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.doesNotMatch(await response.text(), /first|second/);
    await Promise.all(pending.splice(0));
    assert.equal(reports.length, 1);
    assert.equal((reports[0] as { code?: unknown }).code, 'response_finalizer.body_taken');
  });
});
