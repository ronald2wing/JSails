/**
 * The HTTP listener: proxy-friendly timeouts, the serve hook contract (drain
 * participants, `serve.missing_attachment`, `serve.invalid_attachment`), the
 * standby state in which every hook ran and nothing listens, accepting on a
 * passed listening handle (a native handle or `{ fd }`; refused on Windows,
 * tested by injecting the platform), the readiness flip of the drain's first
 * phase, and the production origin rule.
 */

import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';

import {
  assertServableOrigin,
  closeServers,
  openServer,
  type ListenHandle,
  type OpenServerOptions,
} from '../../src/app/serve.js';
import { ServeErrors } from '../../src/app/serve-errors.js';
import { DEFAULT_SERVER_TIMEOUTS, resolveServerTimeouts } from '../../src/app/server-timeouts.js';
import { AppConfigError, type ResolvedAppConfig } from '../../src/app/config/index.js';
import type { ServeHook, ServeHookRegistration } from '../../src/extensions/extension.js';
import { discoverRoutes } from '../../src/routing/routes.js';
import { createApp } from '../../src/server/app.js';
import type { AppEnv } from '../../src/server/env.js';

const storageDir = mkdtempSync(join(tmpdir(), 'jsails-serve-'));
after(() => rmSync(storageDir, { recursive: true, force: true }));

function config(shutdownTimeoutMs = 5000): ResolvedAppConfig {
  return {
    storageDir,
    host: '127.0.0.1',
    port: 0,
    shutdownTimeoutMs,
    server: {
      origin: undefined,
      hosts: [],
      trustedProxies: 'none',
      timeouts: {},
      handlerTimeoutMs: 30_000,
    },
  } as unknown as ResolvedAppConfig;
}

function helloApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', () => new Response(`served by ${process.pid}`));
  return app;
}

function runtime(...hooks: [owner: string, hook: ServeHook][]): OpenServerOptions['runtime'] {
  const serveHooks: ServeHookRegistration[] = hooks.map(([owner, hook]) => ({ owner, hook }));
  return { serveHooks, services: undefined as never };
}

function get(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** The native handle of a listening `net.Server`: what a supervisor sends over IPC. */
function nativeHandle(server: NetServer): ListenHandle {
  return (server as unknown as { readonly _handle: ListenHandle })._handle;
}

// Windows, a development-only platform, has no listening descriptor to pass:
// a test of a real handle states that, and the refusal is tested everywhere
// by injecting the platform.
const NO_HANDLES_ON_WINDOWS =
  process.platform === 'win32' ? 'Windows has no listening descriptor to pass' : false;

/** A promise and the function that settles it. */
function signal(): { readonly promise: Promise<void>; readonly fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => (fire = resolve));
  return { promise, fire };
}

function listeningNetServer(): Promise<NetServer> {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('server timeouts', () => {
  it('applies keep-alive and header timeouts above common proxy idle timeouts', async () => {
    const listener = await openServer({ app: helloApp(), config: config(), runtime: runtime() });
    try {
      assert.equal(listener.server.keepAliveTimeout, DEFAULT_SERVER_TIMEOUTS.keepAliveTimeoutMs);
      assert.ok(listener.server.keepAliveTimeout > 60_000);
      assert.ok(listener.server.headersTimeout > listener.server.keepAliveTimeout);
    } finally {
      await closeServers([listener], 1000);
    }
  });

  it('accepts overrides and rejects inconsistent values', async () => {
    const listener = await openServer({
      app: helloApp(),
      config: config(),
      runtime: runtime(),
      timeouts: { keepAliveTimeoutMs: 1000, headersTimeoutMs: 2000, requestTimeoutMs: 3000 },
    });
    try {
      assert.equal(listener.server.keepAliveTimeout, 1000);
      assert.equal(listener.server.requestTimeout, 3000);
    } finally {
      await closeServers([listener], 1000);
    }
    assert.throws(() => resolveServerTimeouts({ keepAliveTimeoutMs: -1 }), TypeError);
    assert.throws(
      () => resolveServerTimeouts({ headersTimeoutMs: 10_000, requestTimeoutMs: 5000 }),
      /headersTimeoutMs/,
    );
  });
});

describe('standby and accept', () => {
  it('runs every hook with nothing listening, then accepts on the configured address', async () => {
    const seen: boolean[] = [];
    const listener = await openServer({
      app: helloApp(),
      config: config(),
      runtime: runtime(['probe', (server) => void seen.push(server.listening)]),
    });
    try {
      assert.deepEqual(seen, [false]);
      assert.equal(listener.server.listening, false);
      assert.equal(listener.address, undefined);
      const address = await listener.accept();
      assert.equal(await listener.accept(), address, 'accept is idempotent');
      assert.equal(listener.address, address);
      assert.equal(address.url, `http://127.0.0.1:${address.port}/`);
      assert.equal((await get(address.port)).status, 200);
    } finally {
      await closeServers([listener], 1000);
    }
  });

  it(
    'accepts on a passed native listening handle and reports its bound address',
    { skip: NO_HANDLES_ON_WINDOWS },
    async () => {
      const handle = await listeningNetServer();
      const bound = handle.address();
      assert.ok(bound !== null && typeof bound === 'object');
      const listener = await openServer({
        app: helloApp(),
        config: config(),
        runtime: runtime(),
        listen: { handle: nativeHandle(handle) },
      });
      try {
        assert.equal(listener.server.listening, false);
        const address = await listener.accept();
        assert.equal(address.port, bound.port);
        assert.equal(address.url, `http://127.0.0.1:${bound.port}/`);
        assert.deepEqual(await get(address.port), {
          status: 200,
          body: `served by ${process.pid}`,
        });
      } finally {
        await closeServers([listener], 1000);
        handle.close();
      }
    },
  );

  it('refuses a value that is not a listening handle before running any hook', async () => {
    let ran = false;
    const started = await listeningNetServer();
    // A net.Server is already accepting connections, so it cannot stand by.
    for (const handle of [{ fd: -1 }, { fd: 1.5 }, {}, null, started]) {
      await assert.rejects(
        openServer({
          app: helloApp(),
          config: config(),
          runtime: runtime(['probe', () => void (ran = true)]),
          listen: { handle: handle as never },
          platform: 'linux',
        }),
        (error: unknown) => ServeErrors.is(error, 'invalid_handle'),
      );
    }
    started.close();
    assert.equal(ran, false);
  });

  it('refuses every handle on Windows before running any hook, after the shape check', async () => {
    let ran = false;
    const options = (handle: unknown): OpenServerOptions => ({
      app: helloApp(),
      config: config(),
      runtime: runtime(['probe', () => void (ran = true)]),
      listen: { handle: handle as ListenHandle },
      platform: 'win32',
    });
    // A descriptor, and the negative one a native handle reports on Windows.
    for (const handle of [{ fd: 3 }, { fd: -1 }]) {
      await assert.rejects(openServer(options(handle)), (error: unknown) => {
        assert.ok(ServeErrors.is(error, 'unsupported_platform'), String(error));
        assert.deepEqual(error.context, { platform: 'win32' });
        return true;
      });
    }
    // A malformed handle is a usage error on every platform.
    for (const handle of [{ fd: 1.5 }, {}, null]) {
      await assert.rejects(openServer(options(handle)), (error: unknown) =>
        ServeErrors.is(error, 'invalid_handle'),
      );
    }
    assert.equal(ran, false);
  });

  it('refuses to accept once the drain started, and drains once', async () => {
    const listener = await openServer({ app: helloApp(), config: config(), runtime: runtime() });
    const deadline = new AbortController();
    const first = listener.drain(deadline.signal);
    assert.equal(listener.drain(new AbortController().signal), first);
    await first;
    await assert.rejects(listener.accept(), (error: unknown) => ServeErrors.is(error, 'draining'));
  });

  it('lets a failed accept be retried', async () => {
    const taken = await listeningNetServer();
    const port = (taken.address() as { port: number }).port;
    const listener = await openServer({
      app: helloApp(),
      config: { ...config(), port },
      runtime: runtime(),
    });
    try {
      await assert.rejects(listener.accept(), /EADDRINUSE/);
      await new Promise<void>((resolve) => taken.close(() => resolve()));
      const address = await listener.accept();
      assert.equal(address.port, port);
    } finally {
      await closeServers([listener], 1000);
    }
  });
});

/** The real pipeline over an empty site: its health route is `/up`. */
async function healthApp(): Promise<Hono<AppEnv>> {
  const dir = mkdtempSync(join(storageDir, 'health-'));
  mkdirSync(join(dir, 'pages'));
  writeFileSync(join(dir, 'pages', 'index.js'), 'export default () => null;\n');
  return createApp({ manifest: discoverRoutes(dir), healthPath: '/up' });
}

async function health(app: Hono<AppEnv>): Promise<number> {
  return (await app.fetch(new Request('http://localhost/up'))).status;
}

describe('readiness during the drain', () => {
  it('answers 503 on the health route once a listening server starts draining', async () => {
    const app = await healthApp();
    const reached = signal();
    const release = signal();
    const listener = await openServer({
      app,
      config: config(),
      runtime: runtime([
        'marker',
        () => ({
          name: 'marker',
          drain: async () => {
            reached.fire();
            await release.promise;
          },
        }),
      ]),
    });
    await listener.accept();
    assert.equal(await health(app), 200);
    const drained = closeServers([listener], 5000);
    // Participants drain in phase 2, so phase 1 has flipped readiness by now.
    await reached.promise;
    assert.equal(await health(app), 503);
    release.fire();
    await drained;
    assert.equal(await health(app), 503, 'for the rest of its life');
  });

  it('leaves readiness alone when a server that never accepted drains', async () => {
    const app = await healthApp();
    const listener = await openServer({ app, config: config(), runtime: runtime() });
    await closeServers([listener], 5000);
    assert.equal(await health(app), 200, 'the pipeline it shares with fetch stays ready');
  });
});

/** The next IPC message of `type` from `child`. */
function nextMessage(
  child: ChildProcess,
  type: string,
): Promise<Record<string, unknown> & { type: string }> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: Record<string, unknown> & { type: string }): void => {
      if (message.type === 'failed') {
        cleanup();
        reject(new Error(`the child failed: ${String(message.name)}`));
      } else if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(`the child exited before sending ${type}`));
    };
    const cleanup = (): void => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

describe('a handle passed by a supervisor', () => {
  // Handle passing serves the production supervisor (MKT-09), which Windows,
  // a development-only platform, never runs.
  it(
    'stands by ready with connections queued, then serves them from the child on accept',
    { skip: NO_HANDLES_ON_WINDOWS },
    async () => {
      const handle = await listeningNetServer();
      const port = (handle.address() as { port: number }).port;
      const dir = mkdtempSync(join(storageDir, 'standby-'));
      const child = fork(fileURLToPath(new URL('./standby-child.js', import.meta.url)), [dir], {
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      try {
        await nextMessage(child, 'started');
        const ready = nextMessage(child, 'ready');
        // The parent keeps no copy: from now on only the child can accept.
        await new Promise<void>((resolve, reject) => {
          child.send({ type: 'handle' }, nativeHandle(handle) as never, (error) =>
            error === null ? resolve() : reject(error),
          );
        });
        handle.close();
        assert.equal((await ready).listening, false, 'ready before it listens');

        // A connection made now waits in the shared socket's backlog.
        const queued = get(port, '/pid');
        const counted = nextMessage(child, 'count');
        child.send({ type: 'count' });
        assert.equal((await counted).served, 0, 'nothing is served before accept');

        const accepted = nextMessage(child, 'accepted');
        child.send({ type: 'accept' });
        assert.equal((await accepted).port, port);
        assert.deepEqual(await queued, { status: 200, body: String(child.pid) });

        child.send({ type: 'close' });
        assert.equal(await exited, 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        handle.close();
      }
    },
  );

  it(
    'serves from the child on { fd } of a listening socket it inherited',
    { skip: NO_HANDLES_ON_WINDOWS },
    async () => {
      const handle = await listeningNetServer();
      const port = (handle.address() as { port: number }).port;
      const dir = mkdtempSync(join(storageDir, 'standby-fd-'));
      // The listening socket becomes the child's descriptor 4, after its stdio
      // and the IPC channel, as a socket-activated service inherits it.
      const child = fork(fileURLToPath(new URL('./standby-child.js', import.meta.url)), [dir], {
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'inherit', 'ipc', nativeHandle(handle).fd],
      });
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      try {
        await nextMessage(child, 'started');
        // The child holds its own copy of the descriptor now.
        handle.close();
        const ready = nextMessage(child, 'ready');
        child.send({ type: 'handle', fd: 4 });
        assert.equal((await ready).listening, false, 'ready before it listens');

        const accepted = nextMessage(child, 'accepted');
        child.send({ type: 'accept' });
        assert.equal((await accepted).port, port);
        assert.deepEqual(await get(port, '/pid'), { status: 200, body: String(child.pid) });

        child.send({ type: 'close' });
        assert.equal(await exited, 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        handle.close();
      }
    },
  );
});

describe('the serve hook contract', () => {
  it('keeps the drain participants hooks return, in hook order', async () => {
    const drained: string[] = [];
    const listener = await openServer({
      app: helloApp(),
      config: config(),
      runtime: runtime(
        ['first', () => ({ name: 'one', drain: async () => void drained.push('one') })],
        ['plain', () => undefined],
        ['second', async () => ({ name: 'two', drain: async () => void drained.push('two') })],
      ),
    });
    assert.deepEqual(
      listener.attachments.map((attachment) => attachment.name),
      ['one', 'two'],
    );
    await closeServers([listener], 1000);
    assert.deepEqual(drained.sort(), ['one', 'two']);
  });

  it('fails a hook that listens for upgrades without a participant, naming its owner', async () => {
    let drained = false;
    const error = await openServer({
      app: helloApp(),
      config: config(),
      runtime: runtime(
        ['earlier', () => ({ name: 'earlier', drain: async () => void (drained = true) })],
        [
          'sockets',
          (server) => {
            server.on('upgrade', (_request, socket) => socket.destroy());
          },
        ],
      ),
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(ServeErrors.is(error, 'missing_attachment'), String(error));
    assert.deepEqual(error.context, { owner: 'sockets' });
    assert.equal(drained, true, 'the participant an earlier hook returned was drained');
  });

  it('accepts an upgrade listener whose hook returns its participant', async () => {
    const listener = await openServer({
      app: helloApp(),
      config: config(),
      runtime: runtime([
        'sockets',
        (server) => {
          server.on('upgrade', (_request, socket) => socket.destroy());
          return { name: 'sockets', drain: async () => undefined };
        },
      ]),
    });
    await closeServers([listener], 1000);
  });

  it('fails a hook that returns something other than a participant', async () => {
    for (const returned of [
      null,
      'broadcast',
      { name: 'no drain' },
      { name: 'not an identifier!', drain: async () => undefined },
      { drain: async () => undefined },
    ]) {
      await assert.rejects(
        openServer({
          app: helloApp(),
          config: config(),
          runtime: runtime(['odd', () => returned as never]),
        }),
        (error: unknown) =>
          ServeErrors.is(error, 'invalid_attachment') && error.context.owner === 'odd',
      );
    }
  });

  it('releases what earlier hooks attached when a later hook throws', async () => {
    let drained = false;
    await assert.rejects(
      openServer({
        app: helloApp(),
        config: config(),
        runtime: runtime(
          ['first', () => ({ name: 'first', drain: async () => void (drained = true) })],
          [
            'second',
            () => {
              throw new Error('hook boom');
            },
          ],
        ),
      }),
      /hook boom/,
    );
    assert.equal(drained, true);
  });
});

describe('serving outside development and test', () => {
  const unset = {
    origin: undefined,
    hosts: [],
    trustedProxies: 'none',
    timeouts: {},
    handlerTimeoutMs: 30_000,
  } as const;

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
