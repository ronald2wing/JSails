/**
 * Handler deadlines: a route that does not answer within its `timeoutMs`
 * (else the app's `handlerTimeoutMs`) is answered 504, its request signal
 * aborts with the deadline's error, the expiry is reported with phase
 * `timeout`, and whatever it produces later is discarded or reported. `0`
 * disables the deadline; a claim that never
 * settles is still answered; and a streamed answer declaring
 * `stream.timeoutMs` fails once its producer idles past it.
 *
 * Deadlines are short and assertions are about order, never tight timing, so
 * a slow runner only makes the tests slower.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicAccess } from '../../src/api/access-ref.js';
import type { RouteContext } from '../../src/contracts/http.js';
import { createApp, type AppOptions } from '../../src/server/app.js';
import { DeadlineErrors } from '../../src/server/deadline.js';
import { createHttpRoutes, type RouteSpec } from '../../src/server/http-routes.js';
import type { RequestErrorInfo } from '../../src/server/request-errors.js';

const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] } as const;
const OPEN = publicAccess('deadline test');

/** A promise that never settles. */
const never = (): Promise<never> => new Promise<never>(() => undefined);

/** Resolves after `ms`. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Report {
  readonly error: unknown;
  readonly info: RequestErrorInfo;
}

/** An app serving `specs` (GET routes), recording what it reports. */
async function buildApp(
  specs: readonly (Omit<RouteSpec, 'methods' | 'access'> & { readonly path: string })[],
  options: Partial<AppOptions> = {},
): Promise<{ app: Awaited<ReturnType<typeof createApp>>; reports: Report[] }> {
  const reports: Report[] = [];
  const { routes, contributions } = createHttpRoutes({
    owner: 'app',
    origin: 'app',
    allow: { mount: false, guard: false, transform: false },
  });
  for (const spec of specs) routes.add({ methods: ['GET'], access: OPEN, ...spec });
  const app = await createApp({
    manifest: EMPTY_MANIFEST,
    contributions: contributions(),
    onError: (error, info) => {
      reports.push({ error, info });
    },
    ...options,
  });
  return { app, reports };
}

/** Wait until `predicate` holds, polling; the deadline is the test runner's. */
async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await delay(5);
}

describe('handler deadlines', () => {
  it('answers a never-resolving handler 504 at its timeoutMs and aborts its signal', async () => {
    let signal: AbortSignal | undefined;
    const { app, reports } = await buildApp([
      {
        path: '/stuck',
        timeoutMs: 50,
        handler: (context: RouteContext) => {
          signal = context.signal;
          return never();
        },
      },
    ]);
    const started = performance.now();
    const response = await app.fetch(new Request('http://localhost/stuck'));
    const elapsed = performance.now() - started;
    assert.equal(response.status, 504);
    assert.ok(elapsed >= 45, `answered after ${elapsed} ms, before the deadline`);
    assert.ok(signal?.aborted, 'the request signal aborted at the deadline');
    assert.ok(DeadlineErrors.is(signal.reason, 'handler_timeout'));
    // An operator failure: the caller sees the status, never the code or the deadline.
    const body = (await response.json()) as { code?: string; status: number };
    assert.equal(body.status, 504);
    assert.equal(body.code, undefined);
    const report = reports.find(({ info }) => info.phase === 'timeout');
    assert.ok(report, 'the expiry was reported');
    assert.equal(report.info.route, '/stuck');
    assert.ok(DeadlineErrors.is(report.error, 'handler_timeout'));
  });

  it("applies the app's handlerTimeoutMs to a route that declares none", async () => {
    const { app } = await buildApp([{ path: '/stuck', handler: never }], {
      handlerTimeoutMs: 30,
    });
    assert.equal((await app.fetch(new Request('http://localhost/stuck'))).status, 504);
  });

  it('lets a route opt out with timeoutMs: 0', async () => {
    const { app } = await buildApp(
      [
        {
          path: '/slow',
          timeoutMs: 0,
          handler: async () => {
            await delay(80);
            return new Response('done');
          },
        },
      ],
      { handlerTimeoutMs: 20 },
    );
    const response = await app.fetch(new Request('http://localhost/slow'));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'done');
  });

  it('cancels the body of a response that arrives after the deadline', async () => {
    let cancelled = false;
    let answered = false;
    const { app } = await buildApp([
      {
        path: '/late',
        timeoutMs: 20,
        handler: async () => {
          await delay(80);
          answered = true;
          const body = new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          });
          return new Response(body);
        },
      },
    ]);
    assert.equal((await app.fetch(new Request('http://localhost/late'))).status, 504);
    await until(() => answered);
    await until(() => cancelled);
  });

  it('reports a rejection that arrives after the deadline with phase timeout', async () => {
    const { app, reports } = await buildApp([
      {
        path: '/late-failure',
        timeoutMs: 20,
        handler: async () => {
          await delay(60);
          throw new Error('late failure');
        },
      },
    ]);
    assert.equal((await app.fetch(new Request('http://localhost/late-failure'))).status, 504);
    await until(() =>
      reports.some(({ error }) => error instanceof Error && error.message === 'late failure'),
    );
    const late = reports.find(
      ({ error }) => error instanceof Error && error.message === 'late failure',
    );
    assert.equal(late?.info.phase, 'timeout');
  });

  it('answers a claim that never settles with the built-in 504', async () => {
    const { app } = await buildApp(
      [{ path: '/claimed', handler: () => new Response('unreachable') }],
      {
        handlerTimeoutMs: 30,
        resolveSession: never,
        errorPage: () => 'app error page',
      },
    );
    const response = await app.fetch(new Request('http://localhost/claimed'));
    assert.equal(response.status, 504);
    assert.notEqual(await response.text(), 'app error page');
  });

  it('runs nothing of the route for a claim that settles after the deadline', async () => {
    let ran = false;
    let resolved = false;
    const { app } = await buildApp(
      [
        {
          path: '/late-claim',
          handler: () => {
            ran = true;
            return new Response('unreachable');
          },
        },
      ],
      {
        handlerTimeoutMs: 20,
        resolveSession: async () => {
          await delay(60);
          resolved = true;
          return null;
        },
      },
    );
    assert.equal((await app.fetch(new Request('http://localhost/late-claim'))).status, 504);
    await until(() => resolved);
    await delay(20);
    assert.equal(ran, false, 'the route ran after its deadline');
  });

  it('refuses an invalid handlerTimeoutMs and route timeoutMs at assembly', async () => {
    await assert.rejects(buildApp([], { handlerTimeoutMs: -1 }), TypeError);
    await assert.rejects(buildApp([], { handlerTimeoutMs: 1.5 }), TypeError);
    await assert.rejects(
      buildApp([{ path: '/x', timeoutMs: 2 ** 31, handler: () => new Response('') }]),
      (error: unknown) => (error as { code?: unknown }).code === 'route.invalid_route',
    );
  });
});

describe('streamed answer idle bound', () => {
  it('fails a stream whose producer idles past stream.timeoutMs, reported with phase timeout', async () => {
    const { app, reports } = await buildApp([
      {
        path: '/feed',
        stream: { timeoutMs: 30 },
        handler: () => {
          let sent = false;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode('first'));
                return;
              }
              await never();
            },
          });
          return new Response(body, { headers: { 'content-type': 'text/plain' } });
        },
      },
    ]);
    const response = await app.fetch(new Request('http://localhost/feed'));
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), (error: unknown) =>
      DeadlineErrors.is(error, 'stream_idle'),
    );
    const report = reports.find(({ info }) => info.phase === 'timeout');
    assert.ok(report && DeadlineErrors.is(report.error, 'stream_idle'));
  });

  it('leaves a stream that keeps producing alone', async () => {
    const { app } = await buildApp([
      {
        path: '/feed',
        stream: { timeoutMs: 200 },
        handler: () => {
          let count = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (count === 3) {
                controller.close();
                return;
              }
              count += 1;
              await delay(10);
              controller.enqueue(new TextEncoder().encode(String(count)));
            },
          });
          return new Response(body, { headers: { 'content-type': 'text/plain' } });
        },
      },
    ]);
    const response = await app.fetch(new Request('http://localhost/feed'));
    assert.equal(await response.text(), '123');
  });
});
