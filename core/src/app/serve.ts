/**
 * The HTTP server lifecycle behind `Application.serve` and `Application.close`.
 *
 * `openServer` creates one `node:http` server over the assembled Hono app with
 * proxy-friendly timeouts (`DEFAULT_SERVER_TIMEOUTS` in `server-timeouts.ts`:
 * keep-alive above the 60 s idle timeout common to load balancers, so the
 * proxy never reuses a socket Node just closed), tracks every socket and
 * in-flight request it
 * accepts, runs each extension serve hook against it, and listens. A failed
 * start releases only what it created, so the application can still build or
 * serve again.
 *
 * `closeServer` drains: it flips the app's health route to 503, stops
 * accepting connections, closes idle keep-alive sockets, and lets every
 * in-flight request finish (each answered with `Connection: close`, its socket
 * released as soon as it goes idle). An open `text/event-stream` response never
 * finishes by itself, so it is ended when the drain starts; its client
 * reconnects elsewhere. Only when `shutdownTimeoutMs` elapses are
 * the remaining tracked sockets destroyed (a hung handler, or an upgraded
 * socket Socket.IO does not own) and a {@link ShutdownTimeoutError} raised.
 * Only sockets the server accepted are ever touched. The server's listening
 * state is the only guard against a double close, so a broadcast transport
 * that already closed the server and one that leaves it alive both end with
 * the server released.
 */

import { mkdirSync } from 'node:fs';
import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { Hono } from 'hono';

import { JsailsError } from '../errors/jsails-error.js';
import type { ExtensionRuntime } from '../extensions/extension.js';
import type { AppEnv } from '../server/env.js';
import { createHttpServer } from '../server/http-server.js';
import { markDraining } from '../server/readiness.js';
import { AppConfigError, type ResolvedAppConfig } from './config/index.js';
import { resolveServerTimeouts, type ServerTimeouts } from './server-timeouts.js';

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
  /** Overrides for `DEFAULT_SERVER_TIMEOUTS`. */
  readonly timeouts?: Partial<ServerTimeouts>;
}

/** What `closeServer` needs to drain a server it did not create itself. */
interface DrainState {
  readonly app: object;
  readonly active: Set<ServerResponse>;
  /** Responses whose head declared `text/event-stream`; they never end by themselves. */
  readonly eventStreams: Set<ServerResponse>;
  draining: boolean;
}

/** Drain bookkeeping for every server `openServer` created. */
const drainStates = new WeakMap<NodeHttpServer, DrainState>();

/**
 * The `NODE_ENV` values the runtime treats as non-production; an unset
 * `NODE_ENV` is production.
 */
const NON_PRODUCTION_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * Refuse to serve production without `server.origin`: without it every `Host`
 * is accepted as its own origin, so the cross-site check would trust whatever
 * host a request names. Development and test serve without one.
 */
export function assertServableOrigin(
  config: Pick<ResolvedAppConfig, 'server'>,
  nodeEnv: string | undefined,
): void {
  if (config.server.origin !== undefined) return;
  if (nodeEnv !== undefined && NON_PRODUCTION_ENVIRONMENTS.has(nodeEnv)) return;
  throw new AppConfigError(
    'config.server.origin is required to serve outside the development and test environments',
  );
}

/** Create, hook, and listen one HTTP server; release it again when any step fails. */
export async function openServer(options: OpenServerOptions): Promise<ServedServer> {
  const { app, config, runtime } = options;
  assertServableOrigin(config, process.env.NODE_ENV);

  // Serving is the only operation that creates the storage directory: build
  // and fetch never materialize the folder.
  mkdirSync(config.storageDir, { recursive: true });

  const server = createHttpServer(app);
  applyTimeouts(server, resolveServerTimeouts(options.timeouts));
  const sockets = trackConnections(server);
  trackRequests(server, app);
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
  const state = drainStates.get(entry.server);
  if (state !== undefined) {
    state.draining = true;
    markDraining(state.app);
    for (const response of state.active) closeAfterResponse(response);
    for (const response of state.eventStreams) endEventStream(response);
  }
  // Stop accepting first, then release idle keep-alive sockets; `close`
  // resolves once every in-flight request has finished and its socket ended.
  const closing = closeHttpServer(entry.server);
  entry.server.closeIdleConnections();

  const force = (): void => {
    entry.server.closeAllConnections();
    for (const socket of entry.sockets) {
      socket.destroy();
    }
  };
  await withShutdownDeadline(closing, timeoutMs, force);
}

function applyTimeouts(server: NodeHttpServer, timeouts: ServerTimeouts): void {
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
}

/**
 * Track in-flight requests so a drain can let them finish. While draining,
 * each response closes its connection and a socket that goes idle is released
 * at once instead of waiting out the keep-alive timeout.
 *
 * An event stream never finishes by itself (the dev live-reload channel, an
 * app's SSE endpoint), so waiting for it would turn every shutdown into a
 * full `shutdownTimeoutMs` wait and a {@link ShutdownTimeoutError}. Those
 * responses are recognised when their head is written and ended when the
 * drain starts (or at once, when one starts during a drain); SSE clients
 * reconnect by design. The listener is prepended so it is in place before the
 * app's own listener can write a head.
 */
function trackRequests(server: NodeHttpServer, app: object): void {
  const state: DrainState = { app, active: new Set(), eventStreams: new Set(), draining: false };
  drainStates.set(server, state);
  server.prependListener('request', (_request: IncomingMessage, response: ServerResponse) => {
    state.active.add(response);
    if (state.draining) closeAfterResponse(response);
    watchForEventStream(response, () => {
      state.eventStreams.add(response);
      if (state.draining) endEventStream(response);
    });
    response.once('close', () => {
      state.active.delete(response);
      state.eventStreams.delete(response);
      if (state.draining) setImmediate(() => server.closeIdleConnections());
    });
  });
}

/** Ask Node to send `Connection: close` and end the socket after this response. */
function closeAfterResponse(response: ServerResponse): void {
  if (!response.headersSent) response.shouldKeepAlive = false;
}

/**
 * End an open event stream. Deferred one turn so a destroy never lands inside
 * the adapter's own `writeHead` call.
 */
function endEventStream(response: ServerResponse): void {
  setImmediate(() => response.destroy());
}

const EVENT_STREAM = /^\s*text\/event-stream\s*(?:;|$)/i;

/**
 * Call `onEventStream` once this response's head declares
 * `text/event-stream`. The Hono adapter passes its headers straight to
 * `writeHead`, where `getHeader` never sees them, so the head is inspected at
 * that call.
 */
function watchForEventStream(response: ServerResponse, onEventStream: () => void): void {
  const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse;
  const watched = (...args: unknown[]): ServerResponse => {
    const result = writeHead(...args);
    const declared = response.getHeader('content-type') ?? headContentType(args);
    if (EVENT_STREAM.test(String(declared ?? ''))) onEventStream();
    return result;
  };
  response.writeHead = watched;
}

/** The content type in a `writeHead(status, [message], headers)` call, if any. */
function headContentType(args: readonly unknown[]): unknown {
  const headers = args.findLast((arg) => typeof arg === 'object' && arg !== null);
  if (headers === undefined) return undefined;
  const entries: unknown[][] = Array.isArray(headers)
    ? Array.isArray(headers[0])
      ? (headers as unknown[][])
      : pairUp(headers as unknown[])
    : Object.entries(headers);
  const match = entries.find(([name]) => String(name).toLowerCase() === 'content-type');
  const value = match?.[1];
  return Array.isArray(value) ? value[0] : value;
}

/** `[k1, v1, k2, v2]` (Node's flat raw-header form) to `[[k1, v1], [k2, v2]]`. */
function pairUp(flat: readonly unknown[]): unknown[][] {
  const pairs: unknown[][] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([flat[index], flat[index + 1]]);
  }
  return pairs;
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
