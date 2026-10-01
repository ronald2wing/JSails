/**
 * The HTTP listener behind `Application.serve`, `Application.standby` and
 * `Application.close`: one `node:http` server, its serve hooks, and its drain.
 *
 * `openServer` creates the server over the assembled Hono app with
 * proxy-friendly timeouts (`DEFAULT_SERVER_TIMEOUTS` in `server-timeouts.ts`:
 * keep-alive above the 60 s idle timeout common to load balancers, so the
 * proxy never reuses a socket Node just closed), tracks every socket and
 * in-flight request it will accept, and runs each extension serve hook
 * against it. Nothing listens yet: the listener is ready, and
 * {@link HttpListener.accept} binds it, to the configured host and port or to
 * a listening handle another process passed (a supervisor's shared socket,
 * whose connections wait in its backlog until then; see {@link ListenHandle}). A serve hook that
 * attaches something the drain cannot see returns a drain participant
 * (`ServeAttachment`); one that listens for upgrades and returns none fails
 * the serve (`serve.missing_attachment`). A failed start releases only what
 * it created, so the application can still build or serve again.
 *
 * The drain ({@link HttpListener.drain}, {@link closeServers}) runs under one
 * deadline, in three phases:
 *
 * 1. the health route answers 503, the server stops accepting connections,
 *    idle keep-alive sockets close, and every in-flight answer closes its
 *    connection (`Connection: close`);
 * 2. every drain participant's `drain(deadline)` runs, concurrently, and the
 *    server's drain signal aborts: a live answer (`Respond.eventStream`,
 *    `Respond.stream` with `live`, any `text/event-stream`) ends cleanly and
 *    its client reconnects elsewhere, now or as soon as its head is written
 *    (`server/served-frames.ts`, `server/output.ts`);
 * 3. everything else finishes: the in-flight requests, finite streams
 *    included, and each participant's own sockets.
 *
 * At the deadline whatever is still open is stopped: each remaining request's
 * frame signal aborts (`serve.stopped`), a stream still open is reported
 * through its request (`serve.unfinished_stream`: a stream that never ends
 * must declare itself live), every socket the server accepted is destroyed,
 * upgraded ones included, and the drain rejects with `serve.shutdown_timeout`,
 * counting what was open and naming the participants still draining. Only
 * sockets the server accepted are ever touched. A response with no frame (a
 * 421, an adapter error, a bare Hono app) is finite.
 */

import { setMaxListeners } from 'node:events';
import { mkdirSync } from 'node:fs';
import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { Hono } from 'hono';

import { isProductionNodeEnv } from '../environment/names.js';
import { isIdentifier } from '../errors/context-schema.js';
import type {
  ExtensionRuntime,
  ServeAttachment,
  ServeContext,
  ServeHookRegistration,
} from '../extensions/extension.js';
import type { AppEnv } from '../server/env.js';
import { createHttpServer } from '../server/http-server.js';
import { answerOf } from '../server/output.js';
import { markDraining } from '../server/readiness.js';
import { frameInternals } from '../server/request-frame.js';
import { serveRequest, servedFrameOf } from '../server/served-frames.js';
import { AppConfigError, type ResolvedAppConfig } from './config/index.js';
import { ServeErrors } from './serve-errors.js';
import { resolveServerTimeouts, type ServerTimeouts } from './server-timeouts.js';

/**
 * A listening socket another process bound and passed to this one: the
 * native handle a supervisor sends over IPC (`child.send(message,
 * server._handle)`, as `node:cluster` does), or a listening file descriptor
 * (`{ fd }`). Either is idle in this process until the server accepts on it,
 * so connections wait in the socket's backlog meanwhile. A `net.Server` sent
 * over IPC is not one: Node starts it listening on arrival, and it would take
 * connections nothing answers. Windows, a development platform, refuses
 * every handle (`serve.unsupported_platform`): it has no listening descriptor
 * to pass.
 *
 * @public
 */
export interface ListenHandle {
  readonly fd: number;
}

/** Where {@link HttpListener.accept} listens. */
export type ListenTarget =
  { readonly host: string; readonly port: number } | { readonly handle: ListenHandle };

/** Where a listener accepts connections. */
export interface ServeAddress {
  /** The bound port (resolved when `config.port` is `0`). */
  readonly port: number;
  /** The server's origin URL, e.g. `http://127.0.0.1:3000/`. */
  readonly url: string;
}

/** One HTTP server, its serve hooks' drain participants, and its drain. */
export interface HttpListener {
  readonly server: NodeHttpServer;
  /** Sockets the server accepted, so a stuck drain can destroy only these. */
  readonly sockets: ReadonlySet<Socket>;
  /** The drain participants the serve hooks returned, in hook order. */
  readonly attachments: readonly ServeAttachment[];
  /** Where it accepts connections, once {@link accept} resolved. */
  readonly address: ServeAddress | undefined;
  /**
   * Start accepting connections; resolves once listening. Called again it
   * returns the same promise; a failed attempt may be retried. Refused once
   * the drain started (`serve.draining`).
   */
  accept(): Promise<ServeAddress>;
  /**
   * Drain the server (see the module comment); `deadline` aborts at the
   * shutdown deadline. Runs once: a later call returns the first one's
   * promise, whatever signal it passes.
   */
  drain(deadline: AbortSignal): Promise<void>;
}

/** Inputs to {@link openServer}. */
export interface OpenServerOptions {
  /** The assembled Hono pipeline the server dispatches to. */
  readonly app: Hono<AppEnv>;
  readonly config: ResolvedAppConfig;
  /** The extension runtime whose serve hooks run before the server accepts. */
  readonly runtime: Pick<ExtensionRuntime, 'serveHooks' | 'services'>;
  /** Overrides for `DEFAULT_SERVER_TIMEOUTS`. */
  readonly timeouts?: Partial<ServerTimeouts>;
  /** Where to listen; defaults to `config.host` and `config.port`. */
  readonly listen?: ListenTarget;
  /** The platform a passed handle is checked against; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

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
  if (!isProductionNodeEnv(nodeEnv)) return;
  throw new AppConfigError(
    'config.server.origin is required to serve outside the development and test environments',
  );
}

/**
 * Create the server and run every serve hook against it; nothing listens
 * until {@link HttpListener.accept}. A failure releases what was created,
 * draining the participants earlier hooks returned.
 */
export async function openServer(options: OpenServerOptions): Promise<HttpListener> {
  const { app, config, runtime } = options;
  assertServableOrigin(config, process.env.NODE_ENV);
  const target = options.listen ?? { host: config.host, port: config.port };
  if ('handle' in target) assertListenHandle(target.handle, options.platform ?? process.platform);

  // Serving is the only operation that creates the storage directory: build
  // and fetch never materialize the folder.
  mkdirSync(config.storageDir, { recursive: true });

  const server = createHttpServer(app);
  applyTimeouts(server, resolveServerTimeouts(options.timeouts));
  const listener = new Listener(server, app, target);
  try {
    await listener.runHooks(runtime.serveHooks, { config, services: runtime.services });
  } catch (error) {
    try {
      await closeServers([listener], config.shutdownTimeoutMs);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'serve failed', { cause: error });
    }
    throw error;
  }
  return listener;
}

/**
 * Drain every listener concurrently under one deadline of `timeoutMs`. Each
 * listener drains once, so closing one again settles as its first drain did.
 */
export async function closeServers(
  listeners: readonly HttpListener[],
  timeoutMs: number,
): Promise<void> {
  if (listeners.length === 0) return;
  const deadline = new AbortController();
  // Each listener and each of its participants may watch the deadline.
  setMaxListeners(0, deadline.signal);
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let results: PromiseSettledResult<void>[];
  try {
    results = await Promise.allSettled(
      listeners.map((listener) => listener.drain(deadline.signal)),
    );
  } finally {
    clearTimeout(timer);
  }
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'server close failed');
}

class Listener implements HttpListener {
  readonly server: NodeHttpServer;
  readonly sockets: ReadonlySet<Socket>;
  readonly attachments: ServeAttachment[] = [];
  readonly #app: object;
  readonly #target: ListenTarget;
  /** In-flight responses: a drain lets them finish. */
  readonly #active = new Set<ServerResponse>();
  /** Upgraded sockets, recorded once a participant listens for upgrades. */
  readonly #upgraded = new Set<Duplex>();
  /** Aborted when the drain starts: every live answer of this server ends. */
  readonly #draining = new AbortController();
  #address: ServeAddress | undefined;
  #accepting: Promise<ServeAddress> | undefined;
  #drained: Promise<void> | undefined;

  constructor(server: NodeHttpServer, app: object, target: ListenTarget) {
    this.server = server;
    this.#app = app;
    this.#target = target;
    this.sockets = trackConnections(server);
    // Every open live answer watches the drain signal: any number is normal.
    setMaxListeners(0, this.#draining.signal);
    // Prepended, and before any serve hook: a transport that wraps the
    // request listeners (Engine.IO) keeps this one in front of the app's.
    server.prependListener('request', (request: IncomingMessage, response: ServerResponse) => {
      this.#track(request, response);
    });
  }

  get address(): ServeAddress | undefined {
    return this.#address;
  }

  /** Run every serve hook in order, keeping the drain participants they return. */
  async runHooks(hooks: readonly ServeHookRegistration[], context: ServeContext): Promise<void> {
    for (const { hook, owner } of hooks) {
      const upgrades = this.server.listenerCount('upgrade');
      const returned: unknown = await hook(this.server, context);
      if (returned === undefined) {
        if (this.server.listenerCount('upgrade') > upgrades) {
          throw new ServeErrors.Error('missing_attachment', { owner });
        }
        continue;
      }
      if (!isAttachment(returned)) throw new ServeErrors.Error('invalid_attachment', { owner });
      this.attachments.push(returned);
    }
    // Only with a participant listening: an `upgrade` listener of its own
    // would change how Node treats an upgrade request nobody else accepts.
    if (this.server.listenerCount('upgrade') > 0) {
      this.server.prependListener('upgrade', (_request: IncomingMessage, socket: Duplex) => {
        this.#upgraded.add(socket);
        socket.once('close', () => this.#upgraded.delete(socket));
      });
    }
  }

  accept(): Promise<ServeAddress> {
    if (this.#drained !== undefined) return Promise.reject(new ServeErrors.Error('draining'));
    this.#accepting ??= this.#listen().then(
      (address) => {
        this.#address = address;
        return address;
      },
      (error: unknown) => {
        this.#accepting = undefined;
        throw error;
      },
    );
    return this.#accepting;
  }

  drain(deadline: AbortSignal): Promise<void> {
    this.#drained ??= this.#drain(deadline);
    return this.#drained;
  }

  #track(request: IncomingMessage, response: ServerResponse): void {
    this.#active.add(response);
    serveRequest(request, this.#draining.signal);
    if (this.#drained !== undefined) closeAfterResponse(response);
    response.once('close', () => {
      this.#active.delete(response);
      // A socket released by its last answer goes at once, not after the
      // keep-alive timeout.
      if (this.#drained !== undefined) setImmediate(() => this.server.closeIdleConnections());
    });
  }

  async #listen(): Promise<ServeAddress> {
    const target = this.#target;
    await listen(this.server, target);
    const bound = this.server.address();
    if (bound === null || typeof bound !== 'object') {
      // A pipe or another non-TCP handle: no port to report or probe.
      this.server.close();
      this.server.closeAllConnections();
      throw new ServeErrors.Error('invalid_handle');
    }
    const host = 'handle' in target ? bound.address : target.host;
    return Object.freeze({ port: bound.port, url: `http://${formatHost(host)}:${bound.port}/` });
  }

  async #drain(deadline: AbortSignal): Promise<void> {
    if (this.#accepting !== undefined) {
      // A listen still in flight settles first, so a server it binds is
      // closed below; one that failed bound nothing.
      await this.#accepting.then(
        () => undefined,
        () => undefined,
      );
    }
    const failures: unknown[] = [];

    // Phase 1: unready, stop accepting, close connections after their answers.
    // A server that never accepted leaves the app's readiness alone: the
    // pipeline it shares with `fetch` and a later serve stays ready.
    let closed: Promise<void> = Promise.resolve();
    if (this.server.listening) {
      markDraining(this.#app);
      closed = closeHttpServer(this.server).catch((error: unknown) => {
        failures.push(error);
      });
    }
    for (const response of this.#active) closeAfterResponse(response);
    this.server.closeIdleConnections();

    // Phase 2: every participant drains while live answers end. Whoever has
    // not finished when the deadline aborts is noted at that instant, before
    // a participant's own abort listener lets it finish.
    this.#draining.abort(new ServeErrors.Error('draining'));
    const pending = new Set<ServeAttachment>(this.attachments);
    let onDeadline: (() => void) | undefined;
    const expired = new Promise<ReadonlySet<ServeAttachment>>((resolve) => {
      onDeadline = () => resolve(new Set(pending));
      if (deadline.aborted) onDeadline();
      else deadline.addEventListener('abort', onDeadline, { once: true });
    });
    const participants = this.attachments.map(async (attachment) => {
      try {
        await attachment.drain(deadline);
      } catch (error) {
        failures.push(error);
      } finally {
        pending.delete(attachment);
      }
    });

    // Phase 3: the rest finishes, or the deadline stops it.
    try {
      const stuck = await Promise.race([
        Promise.all([closed, ...participants]).then(() => undefined),
        expired,
      ]);
      if (stuck !== undefined) {
        const timeout = this.#stop(stuck);
        if (timeout !== undefined) failures.push(timeout);
      }
    } finally {
      if (onDeadline !== undefined) deadline.removeEventListener('abort', onDeadline);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'server drain failed');
  }

  /**
   * Stop whatever is still open at the deadline: abort each remaining frame,
   * report each unfinished stream through its request, destroy every socket.
   * The timeout error, or `undefined` when nothing was left open.
   */
  #stop(pending: ReadonlySet<ServeAttachment>): Error | undefined {
    const stopped = new ServeErrors.Error('stopped');
    let streams = 0;
    let requests = 0;
    for (const response of this.#active) {
      const frame = servedFrameOf(response.req);
      const answer = frame === undefined ? undefined : answerOf(frame);
      if (answer === 'stream' || answer === 'live') streams += 1;
      else requests += 1;
      if (frame === undefined) continue;
      if (answer === 'stream') frame.report(new ServeErrors.Error('unfinished_stream'), 'timeout');
      frameInternals(frame)?.abort(stopped);
    }
    const connections = this.sockets.size;
    const upgraded = this.#upgraded.size;
    this.server.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    for (const socket of this.#upgraded) socket.destroy();
    if (pending.size === 0 && connections === 0 && requests === 0 && streams === 0) {
      return undefined;
    }
    return new ServeErrors.Error(
      'shutdown_timeout',
      { attachments: pending.size, streams, requests, connections, upgraded },
      { payload: { attachments: [...pending].map((attachment) => attachment.name) } },
    );
  }
}

/** Whether `value` is a drain participant: an identifier name and a `drain` function. */
function isAttachment(value: unknown): value is ServeAttachment {
  if (value === null || typeof value !== 'object') return false;
  const { name, drain } = value as { name?: unknown; drain?: unknown };
  return isIdentifier(name) && typeof drain === 'function';
}

/**
 * Refuse anything that is not a handle `server.listen` takes over idle: an
 * object with a descriptor (a native handle exposes its own `fd`). The shape
 * is checked first, on every platform. Windows then refuses any handle: libuv
 * reports no descriptor for a Windows socket (a native handle's `fd` is
 * negative there) and Node cannot listen on `{ fd }`, and Windows is a
 * development platform, which never runs the supervisor that passes one.
 */
function assertListenHandle(handle: unknown, platform: NodeJS.Platform): void {
  const fd = handle !== null && typeof handle === 'object' ? (handle as { fd?: unknown }).fd : null;
  if (typeof fd !== 'number' || !Number.isSafeInteger(fd)) {
    throw new ServeErrors.Error('invalid_handle');
  }
  if (platform === 'win32') throw new ServeErrors.Error('unsupported_platform', { platform });
  if (fd < 0) throw new ServeErrors.Error('invalid_handle');
}

function applyTimeouts(server: NodeHttpServer, timeouts: ServerTimeouts): void {
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
}

/** Ask Node to send `Connection: close` and end the socket after this response. */
function closeAfterResponse(response: ServerResponse): void {
  if (!response.headersSent) response.shouldKeepAlive = false;
}

/** Track every socket the server accepts so a stuck drain can destroy only them. */
function trackConnections(server: NodeHttpServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

/** Bind the server, resolving on `listening` and rejecting on `error`. */
function listen(server: NodeHttpServer, target: ListenTarget): Promise<void> {
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
    if ('handle' in target) server.listen(target.handle);
    else server.listen(target.port, target.host);
  });
}

/** Close a listening server, resolving once all its connections have ended. */
function closeHttpServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

/** Wrap a bare IPv6 host in brackets so it forms a valid URL authority. */
function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
