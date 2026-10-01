/**
 * The drain protocol, through a real application over loopback: in-flight
 * requests finish, live answers end when the drain starts (also one whose
 * head is written during it), drain participants close their own sockets,
 * and at the deadline whatever is still open is stopped and named. Ordering
 * comes from events (a marker participant tells when the drain started), never
 * from sleeps; a short `shutdownTimeoutMs` only triggers the deadline path.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { publicAccess } from '../../src/api/access-ref.js';
import { eventStream, stream } from '../../src/api/responses.js';
import { createApplication, type Application } from '../../src/app/application.js';
import { validateAppConfig } from '../../src/app/config/index.js';
import { ServeErrors } from '../../src/app/serve-errors.js';
import { broadcastPlugin } from '../../src/broadcast/plugin.js';
import { BROADCAST_PATH } from '../../src/broadcast/server.js';
import type { RouteContext } from '../../src/contracts/http.js';
import type { JsailsExtension, ServeAttachment } from '../../src/extensions/extension.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';
import type { RouteSpec } from '../../src/server/http-routes.js';
import type { RequestErrorInfo } from '../../src/server/request-errors.js';

const ORIGIN = 'https://app.example';
const root = mkdtempSync(join(tmpdir(), 'jsails-serve-drain-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** A promise and the function that settles it. */
function signal<T = void>(): { readonly promise: Promise<T>; readonly fire: (value: T) => void } {
  let fire!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (fire = resolve));
  return { promise, fire };
}

interface Report {
  readonly error: unknown;
  readonly info: RequestErrorInfo;
}

interface ServedApp {
  readonly app: Application;
  readonly port: number;
  readonly reports: Report[];
  /** Resolves on the first report `matches` accepts. */
  reported(matches: (report: Report) => boolean): Promise<Report>;
}

interface AppSpec {
  readonly routes?: readonly RouteSpec[];
  readonly extensions?: readonly JsailsExtension[];
  readonly shutdownTimeoutMs?: number;
}

async function serveApp(spec: AppSpec = {}): Promise<ServedApp> {
  const dir = mkdtempSync(join(root, 'app-'));
  const reports: Report[] = [];
  const waiters: { matches: (report: Report) => boolean; fire: (report: Report) => void }[] = [];
  const routes = spec.routes ?? [];
  const routesPlugin = definePlugin({
    name: 'drain-routes',
    setup({ routes: registrar }) {
      for (const route of routes) registrar.add(route);
    },
  })();
  const config = validateAppConfig(
    {
      rootDir: dir,
      host: '127.0.0.1',
      port: 0,
      shutdownTimeoutMs: spec.shutdownTimeoutMs ?? 30_000,
      onError: (error: unknown, info: RequestErrorInfo) => {
        const report = { error, info };
        reports.push(report);
        for (const waiter of waiters.filter((entry) => entry.matches(report))) waiter.fire(report);
      },
      plugins: { use: [routesPlugin] },
      extensions: [...(spec.extensions ?? [])],
    },
    { cwd: dir },
  );
  const app = await createApplication(config);
  const handle = await app.serve();
  return {
    app,
    port: handle.port,
    reports,
    reported(matches) {
      const found = reports.find(matches);
      if (found !== undefined) return Promise.resolve(found);
      const waiter = signal<Report>();
      waiters.push({ matches, fire: waiter.fire });
      return waiter.promise;
    },
  };
}

/**
 * Resolves when `abort` aborts: how a producer that waits on something else
 * stops when its request ends (an iterable parked in an `await` cannot be
 * returned until that await settles).
 */
function aborted(abort: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abort.aborted) resolve();
    else abort.addEventListener('abort', () => resolve(), { once: true });
  });
}

function route(path: string, handler: (context: RouteContext) => Response | Promise<Response>) {
  return { methods: ['GET'], path, access: publicAccess('drain test'), handler } as const;
}

/** An extension whose drain participant fires `started` when the drain reaches phase 2. */
function drainMarker(): { readonly extension: JsailsExtension; readonly started: Promise<void> } {
  const started = signal();
  return {
    started: started.promise,
    extension: {
      name: 'drain-marker',
      setup({ onServe }) {
        onServe(() => ({ name: 'marker', drain: async () => started.fire() }));
      },
    },
  };
}

/** An extension whose serve hook returns `attachment`. */
function participant(name: string, attachment: ServeAttachment): JsailsExtension {
  return {
    name,
    setup({ onServe }) {
      onServe(() => attachment);
    },
  };
}

interface OpenedResponse {
  /** The response head. */
  readonly head: Promise<IncomingMessage>;
  /** The first body chunk. */
  readonly firstChunk: Promise<void>;
  /** The whole exchange: whether the body ended cleanly, and what arrived. */
  readonly done: Promise<{ readonly complete: boolean; readonly body: string }>;
}

function open(port: number, path: string): OpenedResponse {
  const head = signal<IncomingMessage>();
  const firstChunk = signal();
  const done = signal<{ complete: boolean; body: string }>();
  const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
    head.fire(res);
    let body = '';
    let complete = false;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      body += chunk;
      firstChunk.fire();
    });
    res.on('end', () => (complete = true));
    res.on('close', () => done.fire({ complete, body }));
    res.on('error', () => done.fire({ complete: false, body }));
  });
  req.on('error', () => done.fire({ complete: false, body: '' }));
  req.end();
  return { head: head.promise, firstChunk: firstChunk.promise, done: done.promise };
}

/** A body that sends `first` and then stays open; `cancelled` fires when its reader cancels it. */
function openBody(first: string): {
  readonly body: ReadableStream<Uint8Array>;
  readonly cancelled: Promise<void>;
} {
  const cancelled = signal();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
    cancel() {
      cancelled.fire();
    },
  });
  return { body, cancelled: cancelled.promise };
}

function connectSocket(port: number): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    path: BROADCAST_PATH,
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { Origin: ORIGIN, Authorization: 'Bearer drain' },
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function socketBroadcast(): JsailsExtension {
  return broadcastPlugin({
    allowedOrigins: [ORIGIN],
    authenticate: (handshake) => (handshake.headers.authorization === 'Bearer drain' ? 'u' : null),
  });
}

describe('drain: in-flight requests and live answers', () => {
  it('lets an in-flight request finish with 200 and Connection: close', async () => {
    const marker = drainMarker();
    const started = signal();
    const served = await serveApp({
      extensions: [marker.extension],
      routes: [
        route('/slow', async () => {
          started.fire();
          await marker.started;
          return new Response('done');
        }),
      ],
    });
    const pending = open(served.port, '/slow');
    await started.promise;
    await served.app.close();
    const res = await pending.head;
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.connection, 'close');
    assert.deepEqual(await pending.done, { complete: true, body: 'done' });
  });

  it('ends an open event stream when the drain starts: the client sees a clean end', async () => {
    const { body, cancelled } = openBody('data: hello\n\n');
    const served = await serveApp({
      routes: [
        route(
          '/events',
          () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        ),
      ],
    });
    const events = open(served.port, '/events');
    await events.firstChunk;
    await served.app.close();
    assert.deepEqual(await events.done, { complete: true, body: 'data: hello\n\n' });
    await cancelled;
  });

  it('ends a live answer whose head is written during the drain', async () => {
    const marker = drainMarker();
    const requested = signal();
    let finished = false;
    const served = await serveApp({
      extensions: [marker.extension],
      routes: [
        route('/late', async (context) => {
          requested.fire();
          await marker.started;
          return eventStream(
            (async function* () {
              try {
                yield 'late';
                await aborted(context.signal);
              } finally {
                finished = true;
              }
            })(),
          );
        }),
      ],
    });
    const late = open(served.port, '/late');
    await requested.promise;
    await served.app.close();
    const { complete } = await late.done;
    assert.equal(complete, true);
    assert.equal(finished, true, "the producer's finally ran");
  });

  it("ends a live Respond.stream: its producer stops and the route's signal aborts with serve.draining", async () => {
    let routeSignal: AbortSignal | undefined;
    const stopped = signal();
    const served = await serveApp({
      routes: [
        route('/feed', (context) => {
          routeSignal = context.signal;
          return stream(
            (async function* () {
              try {
                yield '{"tick":1}\n';
                await aborted(context.signal);
              } finally {
                stopped.fire();
              }
            })(),
            { headers: { 'content-type': 'application/x-ndjson' } },
            { live: true },
          );
        }),
      ],
    });
    const feed = open(served.port, '/feed');
    await feed.firstChunk;
    await served.app.close();
    await stopped.promise;
    assert.deepEqual(await feed.done, { complete: true, body: '{"tick":1}\n' });
    assert.ok(routeSignal?.aborted);
    assert.ok(ServeErrors.is(routeSignal.reason, 'draining'));
  });
});

describe('drain: many live answers', () => {
  it('ends a dozen live answers at once without a listener-leak warning', async () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on('warning', onWarning);
    try {
      const served = await serveApp({
        routes: [
          route('/sse', (context) =>
            eventStream(
              (async function* () {
                yield 'hello';
                await aborted(context.signal);
              })(),
            ),
          ),
        ],
      });
      const streams = Array.from({ length: 12 }, () => open(served.port, '/sse'));
      await Promise.all(streams.map((opened) => opened.firstChunk));
      await served.app.close();
      const outcomes = await Promise.all(streams.map((opened) => opened.done));
      assert.ok(outcomes.every((outcome) => outcome.complete));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        warnings.filter((name) => name === 'MaxListenersExceededWarning'),
        [],
      );
    } finally {
      process.off('warning', onWarning);
    }
  });
});

describe('drain: the deadline', () => {
  it('stops a request still hung at the deadline and counts it', async () => {
    const started = signal();
    const release = signal();
    let routeSignal: AbortSignal | undefined;
    const served = await serveApp({
      shutdownTimeoutMs: 200,
      routes: [
        route('/hung', async (context) => {
          routeSignal = context.signal;
          started.fire();
          await release.promise;
          return new Response('late');
        }),
      ],
    });
    const hung = open(served.port, '/hung');
    await started.promise;
    const error = await served.app.close().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(ServeErrors.is(error, 'shutdown_timeout'), String(error));
    assert.deepEqual(error.context, {
      attachments: 0,
      streams: 0,
      requests: 1,
      connections: 1,
      upgraded: 0,
    });
    assert.deepEqual(error.payload, { attachments: [] });
    assert.equal((await hung.done).complete, false, 'the socket was destroyed');
    assert.ok(ServeErrors.is(routeSignal?.reason, 'stopped'));
    release.fire();
  });

  it('reports an endless stream that never declared itself live, and counts one unfinished stream', async () => {
    const { body } = openBody('{"tick":1}\n');
    const served = await serveApp({
      shutdownTimeoutMs: 200,
      routes: [
        route('/ndjson', () =>
          stream(body, { headers: { 'content-type': 'application/x-ndjson' } }),
        ),
      ],
    });
    const ndjson = open(served.port, '/ndjson');
    await ndjson.firstChunk;
    const error = await served.app.close().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(ServeErrors.is(error, 'shutdown_timeout'), String(error));
    assert.equal(error.context.streams, 1);
    assert.equal(error.context.requests, 0);
    const report = await served.reported(({ error: reported }) =>
      ServeErrors.is(reported, 'unfinished_stream'),
    );
    assert.deepEqual(
      { phase: report.info.phase, route: report.info.route },
      {
        phase: 'timeout',
        route: '/ndjson',
      },
    );
    assert.equal((await ndjson.done).complete, false);
  });

  it('names the participant still draining at the deadline', async () => {
    const release = signal();
    const served = await serveApp({
      shutdownTimeoutMs: 200,
      extensions: [
        participant('stuck-plugin', { name: 'stuck', drain: () => release.promise }),
        participant('quick-plugin', { name: 'quick', drain: async () => undefined }),
      ],
    });
    const error = await served.app.close().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    release.fire();
    assert.ok(ServeErrors.is(error, 'shutdown_timeout'), String(error));
    assert.equal(error.context.attachments, 1);
    assert.deepEqual(error.payload, { attachments: ['stuck'] });
  });

  it('blames a hung request, not the Socket.IO participant that disconnected its clients', async () => {
    const started = signal();
    const release = signal();
    const served = await serveApp({
      shutdownTimeoutMs: 300,
      extensions: [socketBroadcast()],
      routes: [
        route('/hung', async () => {
          started.fire();
          await release.promise;
          return new Response('late');
        }),
      ],
    });
    const socket = await connectSocket(served.port);
    const disconnected = signal<string>();
    socket.once('disconnect', (reason) => disconnected.fire(reason));
    const hung = open(served.port, '/hung');
    await started.promise;
    const error = await served.app.close().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    release.fire();
    assert.ok(ServeErrors.is(error, 'shutdown_timeout'), String(error));
    assert.equal(error.context.attachments, 0, 'broadcast finished with its own client');
    assert.equal(error.context.requests, 1);
    assert.deepEqual(error.payload, { attachments: [] });
    // A transport close, not a server disconnect: the client reconnects elsewhere.
    assert.equal(await disconnected.promise, 'transport close');
    assert.equal((await hung.done).complete, false);
    socket.close();
  });

  it('hands each participant the deadline signal', async () => {
    const seen = signal<AbortSignal>();
    const served = await serveApp({
      shutdownTimeoutMs: 200,
      extensions: [
        participant('watcher', {
          name: 'watcher',
          drain: (deadline) => {
            seen.fire(deadline);
            return new Promise((resolve) => deadline.addEventListener('abort', () => resolve()));
          },
        }),
      ],
    });
    // The participant ends once the deadline aborts, so the drain still times out naming it.
    await assert.rejects(served.app.close(), (error: unknown) =>
      ServeErrors.is(error, 'shutdown_timeout'),
    );
    assert.equal((await seen.promise).aborted, true);
  });

  it("surfaces a participant's failed drain once everything else finished", async () => {
    const served = await serveApp({
      extensions: [
        participant('failing', {
          name: 'failing',
          drain: async () => {
            throw new Error('drain boom');
          },
        }),
      ],
    });
    await assert.rejects(served.app.close(), /drain boom/);
  });
});

describe('drain: the application', () => {
  it('drains a socket.io client, an open SSE response and a slow finite stream inside the deadline', async () => {
    const marker = drainMarker();
    const served = await serveApp({
      extensions: [socketBroadcast(), marker.extension],
      routes: [
        route('/sse', (context) =>
          eventStream(
            (async function* () {
              yield 'hello';
              await aborted(context.signal);
            })(),
          ),
        ),
        route('/finite', () =>
          stream(
            (async function* () {
              yield 'one,';
              await marker.started;
              yield 'two,';
              yield 'three';
            })(),
            { headers: { 'content-type': 'text/plain' } },
          ),
        ),
      ],
    });
    const socket = await connectSocket(served.port);
    const disconnected = signal<string>();
    socket.once('disconnect', (reason) => disconnected.fire(reason));
    const sse = open(served.port, '/sse');
    const finite = open(served.port, '/finite');
    await Promise.all([sse.firstChunk, finite.firstChunk]);

    await served.app.close();

    assert.deepEqual(await finite.done, { complete: true, body: 'one,two,three' });
    assert.equal((await sse.done).complete, true);
    assert.equal(typeof (await disconnected.promise), 'string');
    socket.close();
  });

  it('refuses to serve with an upgrade listener no participant drains', async () => {
    const dir = mkdtempSync(join(root, 'raw-'));
    const rawSockets: JsailsExtension = {
      name: 'raw-sockets',
      setup({ onServe }) {
        onServe((server) => {
          server.on('upgrade', (_request, socket) => socket.destroy());
        });
      },
    };
    const app = await createApplication(
      validateAppConfig(
        { rootDir: dir, host: '127.0.0.1', port: 0, extensions: [rawSockets] },
        { cwd: dir },
      ),
    );
    await assert.rejects(
      app.serve(),
      (error: unknown) =>
        ServeErrors.is(error, 'missing_attachment') && error.context.owner === 'raw-sockets',
    );
    await app.close();
  });

  it('leaves no resource behind across 50 serve and close cycles', async (t) => {
    const cycle = async (): Promise<void> => {
      const served = await serveApp({
        extensions: [socketBroadcast()],
        routes: [
          route('/sse', (context) =>
            eventStream(
              (async function* () {
                yield 'hello';
                await aborted(context.signal);
              })(),
            ),
          ),
          route('/finite', () => new Response('finite')),
        ],
      });
      const socket = await connectSocket(served.port);
      const closed = signal();
      socket.once('disconnect', () => closed.fire());
      const sse = open(served.port, '/sse');
      await sse.firstChunk;
      assert.equal((await open(served.port, '/finite').done).body, 'finite');
      await served.app.close();
      await Promise.all([sse.done, closed.promise]);
      socket.close();
    };
    const snapshot = (): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
      for (const event of ['exit', 'beforeExit', 'warning', 'SIGINT', 'SIGTERM'] as const) {
        counts[`listeners:${event}`] = process.listenerCount(event);
      }
      return counts;
    };
    // Settle resources a closed cycle leaves for one turn (a socket's final close).
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    for (let index = 0; index < 5; index += 1) await cycle();
    await settle();
    const before = snapshot();
    for (let index = 0; index < 50; index += 1) await cycle();
    await settle();
    const after = snapshot();
    t.diagnostic(`resources before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    // A leak grows with the cycles (50 more of something); a loose bound
    // tolerates what a loaded machine leaves in flight for a turn.
    for (const kind of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const growth = (after[kind] ?? 0) - (before[kind] ?? 0);
      assert.ok(growth <= 5, `${kind} grew by ${growth} over 50 cycles`);
    }
  });
});
