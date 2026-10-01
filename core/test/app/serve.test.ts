/**
 * Server lifecycle: proxy-friendly timeouts, and a shutdown that drains
 * in-flight requests within the deadline instead of resetting them.
 */

import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Hono } from 'hono';

import {
  assertServableOrigin,
  closeServer,
  openServer,
  ShutdownTimeoutError,
  type ServedServer,
} from '../../src/app/serve.js';
import { DEFAULT_SERVER_TIMEOUTS, resolveServerTimeouts } from '../../src/app/server-timeouts.js';
import { AppConfigError, type ResolvedAppConfig } from '../../src/app/config/index.js';
import type { ExtensionRuntime } from '../../src/extensions/extension.js';
import { isDraining } from '../../src/server/readiness.js';
import type { AppEnv } from '../../src/server/env.js';

const storageDir = mkdtempSync(join(tmpdir(), 'jsails-serve-'));
after(() => rmSync(storageDir, { recursive: true, force: true }));

function config(shutdownTimeoutMs: number): ResolvedAppConfig {
  return {
    storageDir,
    host: '127.0.0.1',
    port: 0,
    shutdownTimeoutMs,
    server: { origin: undefined, hosts: [], trustedProxies: 'none', timeouts: {} },
  } as unknown as ResolvedAppConfig;
}

const runtime = { serveHooks: [], services: undefined } as unknown as ExtensionRuntime;

/** A request whose handler waits until `release` is called. */
function slowApp(): { app: Hono<AppEnv>; started: Promise<void>; release: () => void } {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const app = new Hono<AppEnv>();
  app.get('/slow', async () => {
    markStarted();
    await gate;
    return new Response('done');
  });
  return { app, started, release };
}

function get(served: ServedServer, path: string): Promise<{ res: IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: served.port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ res, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** An SSE response that sends one event and then stays open forever. */
function eventStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** Open a streaming request: resolves on its first chunk, and again once it ends either way. */
function openStream(
  served: ServedServer,
  path: string,
): { firstChunk: Promise<void>; closed: Promise<void> } {
  let markFirst!: () => void;
  let markClosed!: () => void;
  const firstChunk = new Promise<void>((resolve) => (markFirst = resolve));
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const req = httpRequest({ host: '127.0.0.1', port: served.port, path, agent: false }, (res) => {
    res.on('data', () => markFirst());
    res.on('close', () => markClosed());
    res.on('error', () => markClosed());
  });
  req.on('error', () => markClosed());
  req.end();
  return { firstChunk, closed };
}

describe('server timeouts', () => {
  it('applies keep-alive and header timeouts above common proxy idle timeouts', async () => {
    const { app } = slowApp();
    const served = await openServer({ app, config: config(1000), runtime });
    try {
      assert.equal(served.server.keepAliveTimeout, DEFAULT_SERVER_TIMEOUTS.keepAliveTimeoutMs);
      assert.ok(served.server.keepAliveTimeout > 60_000);
      assert.ok(served.server.headersTimeout > served.server.keepAliveTimeout);
    } finally {
      await closeServer(served, 1000);
    }
  });

  it('accepts overrides and rejects inconsistent values', async () => {
    const { app } = slowApp();
    const served = await openServer({
      app,
      config: config(1000),
      runtime,
      timeouts: { keepAliveTimeoutMs: 1000, headersTimeoutMs: 2000, requestTimeoutMs: 3000 },
    });
    try {
      assert.equal(served.server.keepAliveTimeout, 1000);
      assert.equal(served.server.requestTimeout, 3000);
    } finally {
      await closeServer(served, 1000);
    }
    assert.throws(() => resolveServerTimeouts({ keepAliveTimeoutMs: -1 }), TypeError);
    assert.throws(
      () => resolveServerTimeouts({ headersTimeoutMs: 10_000, requestTimeoutMs: 5000 }),
      /headersTimeoutMs/,
    );
  });
});

describe('graceful shutdown', () => {
  it('lets an in-flight request finish with 200 and Connection: close', async () => {
    const { app, started, release } = slowApp();
    const served = await openServer({ app, config: config(5000), runtime });
    const pending = get(served, '/slow');
    await started;

    const closing = closeServer(served, 5000);
    assert.equal(isDraining(app), true);
    setTimeout(release, 50);

    const { res, body } = await pending;
    assert.equal(res.statusCode, 200);
    assert.equal(body, 'done');
    assert.equal(res.headers.connection, 'close');
    await closing;
    assert.equal(served.server.listening, false);
  });

  it('ends an open event stream at once instead of waiting out the deadline', async () => {
    const app = new Hono<AppEnv>();
    app.get('/events', () => eventStream());
    const served = await openServer({ app, config: config(5000), runtime });
    const ended = openStream(served, '/events');
    await ended.firstChunk;

    const started = Date.now();
    await closeServer(served, 5000);
    assert.ok(Date.now() - started < 2000, 'close waited for the event stream');
    await ended.closed;
  });

  it('ends an event stream whose head is written while draining', async () => {
    let markRequested!: () => void;
    let startDraining!: () => void;
    const requested = new Promise<void>((resolve) => (markRequested = resolve));
    const draining = new Promise<void>((resolve) => (startDraining = resolve));
    const app = new Hono<AppEnv>();
    app.get('/late-events', async () => {
      markRequested();
      await draining;
      return eventStream();
    });
    const served = await openServer({ app, config: config(5000), runtime });
    const stream = openStream(served, '/late-events');
    await requested;

    const begin = Date.now();
    const closing = closeServer(served, 5000);
    startDraining();
    await closing;
    assert.ok(Date.now() - begin < 2000, 'close waited for the late event stream');
    await stream.closed;
  });

  it('destroys a request still hung at the deadline and raises ShutdownTimeoutError', async () => {
    const { app, started, release } = slowApp();
    const served = await openServer({ app, config: config(50), runtime });
    const pending = get(served, '/slow').then(
      () => 'completed',
      () => 'reset',
    );
    await started;

    await assert.rejects(closeServer(served, 50), ShutdownTimeoutError);
    assert.equal(await pending, 'reset');
    release();
  });
});

describe('serving outside development and test', () => {
  const unset = { origin: undefined, hosts: [], trustedProxies: 'none', timeouts: {} } as const;

  it('requires server.origin', () => {
    for (const nodeEnv of ['production', undefined, '', 'staging']) {
      assert.throws(
        () => assertServableOrigin({ server: unset }, nodeEnv),
        (error: unknown) =>
          error instanceof AppConfigError &&
          error.message ===
            'config.server.origin is required to serve outside the development and test environments',
        String(nodeEnv),
      );
    }
  });

  it('serves development and test without one, and any environment with one', () => {
    assertServableOrigin({ server: unset }, 'development');
    assertServableOrigin({ server: unset }, 'test');
    assertServableOrigin({ server: { ...unset, origin: 'https://example.com' } }, 'production');
    assertServableOrigin({ server: { ...unset, origin: 'https://example.com' } }, undefined);
  });
});
