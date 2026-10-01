/**
 * The HTTP server lifecycle behind `Application.serve` and `Application.close`.
 *
 * `openServer` creates one `node:http` server over the assembled Hono app,
 * tracks every socket it accepts, runs each extension serve hook against it,
 * and listens. A failed start releases only what it created, so the
 * application can still build or serve again. `closeServer` stops a listening
 * server within the configured grace period: idle keep-alive and in-flight
 * requests are force-closed first so a normal close resolves promptly, and
 * when the deadline elapses the tracked sockets are destroyed (an upgraded
 * socket Socket.IO does not own is the typical straggler) and a
 * {@link ShutdownTimeoutError} is raised. Only sockets the server accepted are
 * ever touched. The server's listening state is the only guard against a
 * double close, so a broadcast transport that already closed the server and
 * one that leaves it alive both end with the server released.
 */

import { mkdirSync } from 'node:fs';
import type { Server as NodeHttpServer } from 'node:http';
import type { Socket } from 'node:net';

import type { Hono } from 'hono';

import { JsailsError } from '../errors/jsails-error.js';
import type { ExtensionRuntime } from '../extensions/extension.js';
import type { AppEnv } from '../server/env.js';
import { createHttpServer } from '../server/http-server.js';
import type { ResolvedAppConfig } from './config/index.js';

/** The only failure the server lifecycle raises itself. */
export type ShutdownTimeoutErrorCode = 'timed_out';

/** Raised when the server fails to stop within `config.shutdownTimeoutMs`. */
export class ShutdownTimeoutError extends JsailsError {
  readonly code: ShutdownTimeoutErrorCode = 'timed_out';

  constructor() {
    super('server shutdown exceeded the configured timeout');
  }
}

/** A listening server together with the sockets it accepted. */
export interface ServedServer {
  readonly server: NodeHttpServer;
  /** Sockets the server accepted, so a stuck close can destroy only these. */
  readonly sockets: ReadonlySet<Socket>;
  /** The bound port (resolved when `config.port` is `0`). */
  readonly port: number;
  /** The server's origin URL, e.g. `http://127.0.0.1:3000/`. */
  readonly url: string;
}

/** Inputs to {@link openServer}. */
export interface OpenServerOptions {
  /** The assembled Hono pipeline the server dispatches to. */
  readonly app: Hono<AppEnv>;
  readonly config: ResolvedAppConfig;
  /** The extension runtime whose serve hooks run before the server listens. */
  readonly runtime: ExtensionRuntime;
}

/** Create, hook, and listen one HTTP server; release it again when any step fails. */
export async function openServer(options: OpenServerOptions): Promise<ServedServer> {
  const { app, config, runtime } = options;

  // Serving is the only operation that creates the storage directory: build
  // and fetch never materialize the folder.
  mkdirSync(config.storageDir, { recursive: true });

  const server = createHttpServer(app);
  const sockets = trackConnections(server);
  try {
    for (const hook of runtime.serveHooks) {
      await hook(server, { config, services: runtime.services });
    }
    await listen(server, config.host, config.port);
  } catch (error) {
    try {
      await closeServer({ server, sockets }, config.shutdownTimeoutMs);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'serve failed', { cause: error });
    }
    throw error;
  }

  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : config.port;
  return { server, sockets, port, url: `http://${formatHost(config.host)}:${port}/` };
}

/** Stop a served server within `timeoutMs`; a server already closed is left alone. */
export async function closeServer(
  entry: Pick<ServedServer, 'server' | 'sockets'>,
  timeoutMs: number,
): Promise<void> {
  if (!entry.server.listening) return;
  entry.server.closeIdleConnections();
  entry.server.closeAllConnections();

  const force = (): void => {
    for (const socket of entry.sockets) {
      socket.destroy();
    }
  };
  await withShutdownDeadline(closeHttpServer(entry.server), timeoutMs, force);
}

/** Track every socket the server accepts so a stuck close can destroy only them. */
function trackConnections(server: NodeHttpServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

/** Bind the server, resolving on `listening` and rejecting on `error`. */
function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Race a close operation against the shutdown deadline. When the deadline
 * wins, `force` destroys the lingering sockets and a {@link ShutdownTimeoutError}
 * is thrown. The timer is always cleared, and the operation's promise is always
 * handled so a late settlement never becomes an unhandled rejection.
 */
async function withShutdownDeadline(
  operation: Promise<void>,
  timeoutMs: number,
  force: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        force();
        reject(new ShutdownTimeoutError());
      }, timeoutMs);
      operation.then(
        () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Close a listening server, resolving once all its connections have ended. */
function closeHttpServer(server: NodeHttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Wrap a bare IPv6 host in brackets so it forms a valid URL authority. */
function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
