/**
 * The request body budget, end to end: a body is read only when a reader
 * asks for it, so a request the gate refuses, or one declaring a length over
 * its route's limit, costs none of its body; a read past the limit answers
 * 413 whatever the handler does with the error, after reading no more than
 * the limit; `Expect: 100-continue` is answered only when a reader asks; and
 * the `ctx.body` readers enforce the route's declared kind.
 *
 * Bytes read are counted at the source: in process, a high-water-mark-0
 * stream counts each chunk the server pulls; over loopback, the server
 * socket's `bytesRead` bounds what was taken from the client. Memory is
 * measured after a full collection between the reads of a handler that
 * streams the body, so it counts what the framework keeps reachable, not
 * what the heap has yet to reclaim.
 *
 * Also: a declared over-limit body is refused with the built-in page even
 * when the app has its own (which would claim the request); a route declares
 * a limit above the app-wide one of its own; a connection answered early is
 * half-closed and destroyed only after the linger, so the client reads the
 * answer before any reset; and a bodiless DELETE over HTTP/1 has no body to
 * leave unread, so its refusal keeps the connection.
 */

import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { legacyAccess, publicAccess } from '../../src/api/access-ref.js';
import type { RouteContext } from '../../src/contracts/http.js';
import { createApp } from '../../src/server/app.js';
import { MAX_ROUTE_BODY_BYTES, type BodySpec } from '../../src/server/route-limits.js';
import { createHttpRoutes } from '../../src/server/http-routes.js';
import { createHttpServer, LINGER_MS } from '../../src/server/http-server.js';
import type { RequestErrorInfo } from '../../src/server/request-errors.js';

const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] } as const;
const MiB = 1024 * 1024;
const CHUNK = 64 * 1024;
const LIMIT = MiB;
const UPLOAD = 40 * MiB;

/**
 * A request body of `total` bytes in `CHUNK`-sized chunks that counts what a
 * consumer pulls. The high-water mark of 0 keeps it from filling a queue
 * ahead of a read, so the count is exactly what the server took.
 */
function countingBody(total = UPLOAD): {
  readonly body: ReadableStream<Uint8Array>;
  pulled(): number;
} {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK, total - pulled);
        pulled += size;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

/**
 * A full garbage collection, so a memory sample holds only what is still
 * reachable. The test process is started without `--expose-gc`; the flag is
 * set at run time and the collector taken from a fresh context. V8 releases
 * the memory of unreachable array buffers on a background sweep that the
 * next collection finishes, so one collection runs twice.
 */
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  return () => {
    gc();
    gc();
  };
}

/** A streamed POST (no `Content-Length`, as a chunked upload arrives). */
function streamed(
  path: string,
  body: ReadableStream<Uint8Array>,
  headers: Readonly<Record<string, string>> = {},
): Request {
  // Same-origin, as a browser's post is, so the cross-site check admits it.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { origin: 'http://localhost', ...headers },
    body,
    duplex: 'half',
  };
  return new Request(`http://localhost${path}`, init);
}

interface BudgetApp {
  readonly app: Awaited<ReturnType<typeof createApp>>;
  /** How many times the app resolved an identity. */
  sessions(): number;
  readonly reports: { error: unknown; info: RequestErrorInfo }[];
}

/**
 * An app with a gate-denied route, a raw upload route capped at `LIMIT`,
 * routes whose handler swallows the read error, a JSON route, a route
 * declaring twice the app-wide cap, and a route declaring no body and a mount
 * that read under the app-wide cap (also `LIMIT`).
 */
async function buildApp(): Promise<BudgetApp> {
  let sessions = 0;
  const reports: { error: unknown; info: RequestErrorInfo }[] = [];
  const { routes, contributions } = createHttpRoutes({
    owner: 'app',
    origin: 'app',
    allow: { mount: true, guard: false, transform: false },
  });
  const open = publicAccess('body budget test');
  const raw: BodySpec = { kind: 'raw', maxBytes: LIMIT };
  const add = (
    path: string,
    body: BodySpec,
    handler: (context: RouteContext) => Promise<Response>,
  ) => routes.add({ methods: ['POST'], path, access: open, credentials: [], body, handler });
  routes.add({
    methods: ['POST'],
    path: '/denied',
    access: legacyAccess(() => false),
    credentials: [],
    body: raw,
    handler: async (context) => new Response(String((await context.body.bytes()).byteLength)),
  });
  add('/upload', raw, async (context) => {
    const bytes = await context.body.bytes();
    return new Response(String(bytes.byteLength));
  });
  add('/swallow', raw, async (context) => {
    try {
      await context.body.bytes();
    } catch {
      // Deliberately answering as if the body were malformed.
      return new Response('bad request', { status: 400 });
    }
    return new Response('read');
  });
  add('/json', { kind: 'json', maxBytes: 1024 }, async (context) => {
    const value = await context.body.json({
      validate: (input: unknown) => {
        if (typeof input !== 'object' || input === null) throw new TypeError('not an object');
        const record: { name?: unknown } = input;
        return record;
      },
    });
    return Response.json({ name: value.name });
  });
  add('/json-as-bytes', { kind: 'json', maxBytes: 1024 }, async (context) => {
    await context.body.bytes();
    return new Response('read');
  });
  add('/form', { kind: 'form', maxBytes: 1024 }, async (context) => {
    const form = await context.body.form();
    return Response.json({ name: form.get('name') });
  });
  routes.mount(
    '/mounted',
    async (request) => {
      try {
        await request.arrayBuffer();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      return new Response('read');
    },
    { access: open, credentials: [] },
  );
  // Declares no body, so the raw request reads under the app-wide cap.
  routes.add({
    methods: ['POST'],
    path: '/plain/swallow',
    access: open,
    credentials: [],
    handler: async ({ request }) => {
      try {
        await request.arrayBuffer();
      } catch {
        return new Response('bad request', { status: 400 });
      }
      return new Response('read');
    },
  });
  add('/large', { kind: 'raw', maxBytes: 2 * LIMIT }, async (context) => {
    return new Response(String((await context.body.bytes()).byteLength));
  });
  const app = await createApp({
    manifest: EMPTY_MANIFEST,
    maxBodyBytes: LIMIT,
    contributions: contributions(),
    resolveSession: () => {
      sessions += 1;
      return null;
    },
    onError: (error, info) => {
      reports.push({ error, info });
    },
  });
  return { app, sessions: () => sessions, reports };
}

describe('the body budget in process', () => {
  let subject: BudgetApp;
  before(async () => {
    subject = await buildApp();
  });

  it('refuses a chunked 40 MiB POST to a gate-denied route 401, pulling at most one chunk', async () => {
    const counted = countingBody();
    const response = await subject.app.fetch(streamed('/denied', counted.body));
    assert.equal(response.status, 401);
    assert.ok(counted.pulled() <= CHUNK, `pulled ${counted.pulled()} bytes before the gate`);
    assert.equal(response.headers.get('connection'), 'close');
  });

  it('answers an over-limit chunked upload 413, reading no further than the limit', async () => {
    const counted = countingBody();
    const response = await subject.app.fetch(streamed('/upload', counted.body));
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { code: string }).code, 'request.too_large');
    assert.equal(response.headers.get('connection'), 'close');
    assert.ok(counted.pulled() <= LIMIT + CHUNK, `pulled ${counted.pulled()} bytes`);
  });

  it('reads a body within the limit whole', async () => {
    const counted = countingBody(LIMIT);
    const response = await subject.app.fetch(streamed('/upload', counted.body));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), String(LIMIT));
    assert.equal(response.headers.get('connection'), null);
  });

  it('answers 413 when the handler catches the read error and answers 400', async () => {
    for (const path of ['/swallow', '/plain/swallow', '/mounted']) {
      const counted = countingBody();
      const response = await subject.app.fetch(streamed(path, counted.body));
      assert.equal(response.status, 413, path);
      assert.ok(counted.pulled() <= LIMIT + CHUNK, `${path} pulled ${counted.pulled()} bytes`);
    }
  });

  it('refuses a declared over-limit Content-Length 413 with no pull and no identity resolved', async () => {
    for (const path of ['/upload', '/denied', '/plain/swallow', '/mounted']) {
      const counted = countingBody();
      const before = subject.sessions();
      const response = await subject.app.fetch(
        streamed(path, counted.body, { 'content-length': String(LIMIT + 1) }),
      );
      assert.equal(response.status, 413, path);
      assert.equal(counted.pulled(), 0, `${path} pulled a declared over-limit body`);
      assert.equal(subject.sessions(), before, `${path} resolved an identity`);
      await counted.body.cancel();
    }
  });

  it('reads a body under the limit its route declares above the app-wide one', async () => {
    const within = countingBody(2 * LIMIT);
    const read = await subject.app.fetch(streamed('/large', within.body));
    assert.equal(read.status, 200);
    assert.equal(await read.text(), String(2 * LIMIT));
    const over = countingBody();
    const refused = await subject.app.fetch(streamed('/large', over.body));
    assert.equal(refused.status, 413);
    assert.ok(over.pulled() <= 2 * LIMIT + CHUNK, `pulled ${over.pulled()} bytes`);
    const declared = countingBody();
    const early = await subject.app.fetch(
      streamed('/large', declared.body, { 'content-length': String(2 * LIMIT + 1) }),
    );
    assert.equal(early.status, 413);
    assert.equal(declared.pulled(), 0);
    await declared.body.cancel();
  });

  it('validates a JSON body through the schema the route passes', async () => {
    const ok = await subject.app.fetch(
      new Request('http://localhost/json', { method: 'POST', body: '{"name":"Ada"}' }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: 'Ada' });
    const malformed = await subject.app.fetch(
      new Request('http://localhost/json', { method: 'POST', body: '{' }),
    );
    assert.equal(malformed.status, 422);
    const oversized = await subject.app.fetch(
      new Request('http://localhost/json', { method: 'POST', body: `"${'x'.repeat(2048)}"` }),
    );
    assert.equal(oversized.status, 413);
  });

  it('reads a urlencoded form', async () => {
    const response = await subject.app.fetch(
      new Request('http://localhost/form', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=Ada',
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'Ada' });
  });

  it('refuses a reader of a kind the route does not declare, outside production', async () => {
    const response = await subject.app.fetch(
      new Request('http://localhost/json-as-bytes', { method: 'POST', body: '{}' }),
    );
    assert.equal(response.status, 500);
    const report = subject.reports.find(
      ({ error }) => (error as { code?: unknown }).code === 'body.undeclared_read',
    );
    assert.ok(report, 'the undeclared read was reported');
    assert.equal(report.info.route, '/json-as-bytes');
  });
});

describe('the body budget with an app error page', () => {
  it('refuses a declared over-limit body 413 with the built-in page, resolving nothing', async () => {
    let sessions = 0;
    let pages = 0;
    const { routes, contributions } = createHttpRoutes({
      owner: 'app',
      origin: 'app',
      allow: { mount: true, guard: false, transform: false },
    });
    const open = publicAccess('error page test');
    routes.mount('/mounted', () => new Response('read'), { access: open, credentials: [] });
    const app = await createApp({
      manifest: EMPTY_MANIFEST,
      maxBodyBytes: LIMIT,
      contributions: contributions(),
      resolveSession: () => {
        sessions += 1;
        return null;
      },
      errorPage: () => {
        pages += 1;
        return '<p>the app page</p>';
      },
      onError: () => undefined,
    });
    // A browser-like request: it prefers HTML and carries a credential, so
    // an app page would claim the request and resolve its identity.
    const cases = [
      ['/mounted', LIMIT + 1],
      ['/unrouted', MAX_ROUTE_BODY_BYTES + 1],
    ] as const;
    for (const [path, length] of cases) {
      const counted = countingBody();
      const response = await app.fetch(
        streamed(path, counted.body, {
          accept: 'text/html',
          cookie: 'sid=1',
          'content-length': String(length),
        }),
      );
      assert.equal(response.status, 413, path);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/, path);
      assert.doesNotMatch(await response.text(), /the app page/, path);
      assert.equal(counted.pulled(), 0, `${path} pulled a declared over-limit body`);
      assert.equal(sessions, 0, `${path} resolved an identity`);
      assert.equal(pages, 0, `${path} ran the app error page`);
      await counted.body.cancel();
    }
  });
});

describe('the body budget memory bound', () => {
  it('holds under two chunks while a handler streams an over-limit upload', async () => {
    const gc = collector();
    let peak = 0;
    let baseline = 0;
    const { routes, contributions } = createHttpRoutes({
      owner: 'app',
      origin: 'app',
      allow: { mount: false, guard: false, transform: false },
    });
    routes.add({
      methods: ['POST'],
      path: '/stream',
      access: publicAccess('memory bound test'),
      credentials: [],
      body: { kind: 'raw', maxBytes: LIMIT },
      handler: async (context) => {
        const reader = context.body.stream().getReader();
        try {
          // Each chunk is dropped once read; what stays reachable between
          // reads is what the framework itself holds.
          while (!(await reader.read()).done) {
            gc();
            peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
          }
        } catch {
          return new Response('bad request', { status: 400 });
        }
        return new Response('read');
      },
    });
    const app = await createApp({
      manifest: EMPTY_MANIFEST,
      maxBodyBytes: LIMIT,
      contributions: contributions(),
      resolveSession: () => null,
      onError: () => undefined,
    });
    const counted = countingBody();
    gc();
    baseline = process.memoryUsage().arrayBuffers;
    const response = await app.fetch(streamed('/stream', counted.body));
    assert.equal(response.status, 413);
    assert.ok(counted.pulled() > LIMIT, 'the handler read up to the limit');
    assert.ok(peak < 2 * CHUNK, `${peak} bytes stayed reachable while streaming`);
  });
});

/** Answers from the loopback server, with the bytes its sockets took from the client. */
describe('the body budget over loopback', () => {
  let subject: BudgetApp;
  let server: ReturnType<typeof createHttpServer>;
  let port: number;
  const sockets: Socket[] = [];

  before(async () => {
    subject = await buildApp();
    server = createHttpServer(subject.app);
    server.on('connection', (socket: Socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The bytes the server's sockets have read so far. */
  const bytesRead = (): number => sockets.reduce((sum, socket) => sum + socket.bytesRead, 0);

  /**
   * POST up to `total` bytes to `path`, writing as fast as the server
   * takes them and stopping once the answer arrives. Resolves the answer and
   * whether a `100 Continue` arrived.
   */
  function upload(
    path: string,
    total: number,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<{ response: IncomingMessage; body: string; continued: boolean }> {
    return new Promise((resolve, reject) => {
      let answered = false;
      let continued = false;
      const expecting = headers.expect !== undefined;
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        // Chunked unless the caller declares the length.
        headers:
          headers['content-length'] === undefined
            ? { 'transfer-encoding': 'chunked', ...headers }
            : headers,
      });
      let written = 0;
      const pump = (): void => {
        while (!answered && written < total) {
          written += CHUNK;
          if (!request.write(new Uint8Array(CHUNK).fill(0x61))) {
            request.once('drain', pump);
            return;
          }
        }
        if (!answered) request.end();
      };
      request.on('continue', () => {
        continued = true;
        pump();
      });
      request.on('response', (response) => {
        answered = true;
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          request.destroy();
          resolve({ response, body, continued });
        });
        // A connection cut while the answer is read fails the request
        // instead of leaving it waiting for an end that never comes.
        response.on('error', reject);
        response.on('aborted', () => reject(new Error('the answer was cut short')));
      });
      // Writes cut off by the server's close after its answer are expected.
      request.on('error', (error) => {
        if (!answered) reject(error);
      });
      if (expecting) request.flushHeaders();
      else pump();
    });
  }

  it('refuses a chunked 40 MiB POST to a gate-denied route, taking almost none of it', async () => {
    const before = bytesRead();
    const { response } = await upload('/denied', UPLOAD);
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers.connection, 'close');
    const taken = bytesRead() - before;
    assert.ok(taken < 4 * MiB, `the server read ${taken} bytes of a refused 40 MiB body`);
  });

  it('answers an over-limit chunked upload 413, taking little more than the limit', async () => {
    const before = bytesRead();
    const { response } = await upload('/upload', UPLOAD);
    assert.equal(response.statusCode, 413);
    assert.equal(response.headers.connection, 'close');
    const taken = bytesRead() - before;
    assert.ok(taken < LIMIT + 4 * MiB, `the server read ${taken} bytes for a 1 MiB limit`);
  });

  it('never sends 100 Continue to a request the gate refuses', async () => {
    const { response, continued } = await upload('/denied', UPLOAD, { expect: '100-continue' });
    assert.equal(response.statusCode, 401);
    assert.equal(continued, false, 'a denied request was invited to send its body');
  });

  it('never sends 100 Continue to a declared over-limit body', async () => {
    const { response, continued } = await upload('/upload', LIMIT + 1, {
      expect: '100-continue',
      'content-length': String(LIMIT + 1),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(continued, false, 'an over-limit request was invited to send its body');
  });

  it('sends 100 Continue once a reader asks for the body', async () => {
    const { response, body, continued } = await upload('/upload', 4 * CHUNK, {
      expect: '100-continue',
    });
    assert.equal(continued, true);
    assert.equal(response.statusCode, 200);
    assert.equal(body, String(4 * CHUNK));
  });

  it('half-closes a connection it answers early and destroys it only after the linger', async () => {
    let finished = 0;
    let closed = 0;
    let serverClosed: Promise<void> | undefined;
    const onRequest = (_request: IncomingMessage, outgoing: ServerResponse): void => {
      outgoing.once('finish', () => {
        finished = performance.now();
      });
      const socket = outgoing.socket;
      if (socket === null) return;
      serverClosed = new Promise((resolve) => {
        socket.once('close', () => {
          closed = performance.now();
          resolve();
        });
      });
    };
    server.on('request', onRequest);
    try {
      // The client stops writing once answered and never closes first: the
      // server's close ends the connection, and the test measures when.
      const status = await new Promise<number | undefined>((resolve) => {
        let answered: number | undefined;
        const request = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/denied',
          headers: { 'transfer-encoding': 'chunked' },
        });
        const pump = (): void => {
          while (answered === undefined) {
            if (!request.write(new Uint8Array(CHUNK).fill(0x61))) {
              request.once('drain', pump);
              return;
            }
          }
        };
        request.on('response', (response) => {
          answered = response.statusCode;
          response.resume();
        });
        // The reset that ends the linger fails the writes still queued.
        request.on('error', () => undefined);
        request.on('close', () => resolve(answered));
        pump();
      });
      await serverClosed;
      assert.equal(status, 401);
      assert.ok(finished > 0 && closed > 0, 'the answer finished and the connection closed');
      // Timers never fire early by more than a millisecond.
      const held = closed - finished;
      assert.ok(held >= LINGER_MS - 2, `the connection closed ${held} ms after the answer`);
    } finally {
      server.off('request', onRequest);
    }
  });

  it('keeps a connection alive after refusing a bodiless DELETE or OPTIONS', async () => {
    for (const method of ['DELETE', 'OPTIONS']) {
      // Node's client sends neither Content-Length nor Transfer-Encoding for
      // these: over HTTP/1 the request has no body to leave unread.
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest({ host: '127.0.0.1', port, method, path: '/nope' });
        request.on('response', (answer) => {
          answer.resume();
          answer.on('end', () => resolve(answer));
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(response.statusCode, 404, method);
      assert.notEqual(response.headers.connection, 'close', `${method} closed the connection`);
    }
  });
});
