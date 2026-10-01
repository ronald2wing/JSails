/**
 * Node HTTP server factory for a Hono app.
 *
 * `createHttpServer` wraps a Hono app's `fetch` in a `node:http.Server` via the
 * maintained `@hono/node-server` adapter (`createAdaptorServer`). It
 * never calls `listen()` — binding an ephemeral or configured port and
 * closing the server are entirely the caller's responsibility. The returned
 * server carries no JSails-owned connections (no Valkey, no database) and can
 * be shared with `attachBroadcast` on the same port.
 *
 * `Expect: 100-continue`: Node answers it on arrival unless the server
 * listens for `checkContinue`. This server does, and emits such a request as
 * an ordinary `request` (so every request listener, the drain tracking of
 * `serve.ts` included, sees it) without the interim answer: the request's
 * body budget writes `100 Continue` when a reader first asks for the body
 * (`body-budget.ts`), so a request refused by its length, its origin, its
 * access or a guard never invites the body.
 *
 * Closing after an early answer: a request answered before its body arrived
 * (refused, or past its limit) is answered with `Connection: close`, and the
 * client may still be sending. Closing the socket with those bytes unread
 * makes the kernel reset the connection, and a client whose stack drops
 * unread data on a reset (Windows does) loses the answer it was about to
 * read. Such a connection is half-closed instead: the answer is followed by
 * the end of the stream, and the socket is destroyed {@link LINGER_MS} later,
 * which gives the client time to read the answer. Nothing more of the body
 * is read meanwhile.
 */

import type { createServer as createNodeServer } from 'node:http';
import type {
  IncomingMessage,
  Server as NodeHttpServer,
  ServerOptions,
  ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { owe100Continue } from './body-budget.js';
import type { AppEnv } from './env.js';

/**
 * How long a connection answered before its request body arrived stays
 * half-closed before it is destroyed: the time a client has to read the
 * answer before the unread body makes the close a reset.
 */
export const LINGER_MS = 1_000;

/**
 * Make the server's close of `socket` (`destroySoon`, called once the last
 * answer on it is flushed) end the stream and destroy the socket
 * {@link LINGER_MS} later, or as soon as it closes on its own.
 */
function lingerBeforeClose(socket: Socket): void {
  socket.destroySoon = () => {
    if (socket.writable) socket.end();
    const timer = setTimeout(() => socket.destroy(), LINGER_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  };
}

/** Whether `request`'s framing announces a body: only then can it be unread when answered. */
function framesBody(request: IncomingMessage): boolean {
  const length = request.headers['content-length'];
  return (
    request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && Number(length) !== 0)
  );
}

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  /** Options forwarded to `node:http.createServer`. */
  readonly serverOptions?: ServerOptions;
  /** Custom server factory; defaults to `node:http.createServer`. */
  readonly createServer?: typeof createNodeServer;
}

/**
 * Create a non-listening `node:http.Server` serving `app`. The caller owns
 * `listen()` and `close()`; the Hono app itself is stateless and needs no
 * shutdown. No port is opened and no external connection is established.
 */
export function createHttpServer(
  app: Hono<AppEnv>,
  options: HttpServerOptions = {},
): NodeHttpServer {
  if (app === null || typeof app !== 'object' || typeof app.fetch !== 'function') {
    throw new TypeError('createHttpServer requires a Hono app instance');
  }
  const server = createAdaptorServer({
    fetch: app.fetch,
    serverOptions: options.serverOptions,
    createServer: options.createServer,
  }) as NodeHttpServer;
  // After the adapter's listener, which stays the first: an answer finishes
  // only once its bytes are written, after every listener of its request ran.
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    if (!framesBody(request)) return;
    response.prependOnceListener('finish', () => {
      const socket = response.socket;
      if (socket !== null && !request.complete) lingerBeforeClose(socket);
    });
  });
  server.on('checkContinue', (request: IncomingMessage, response: ServerResponse) => {
    owe100Continue(request, response);
    server.emit('request', request, response);
  });
  return server;
}
