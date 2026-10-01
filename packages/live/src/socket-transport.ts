/**
 * Socket.IO transport for the live layer (`@jsails/live`).
 *
 * {@link attachLiveSocket} mounts a Socket.IO server onto the application's
 * existing `node:http.Server` under a dedicated path (`/_jsails/live`) — there
 * is no second listener and no alternate public port, exactly as the broadcast
 * adapter does (`core/src/broadcast/socketio-adapter.ts`). Each mount owns one
 * Socket.IO `Server` so the live namespace and the broadcast namespace never
 * share a connection or a room.
 *
 * Security posture is reused from the broadcast adapter (docs/design/live.md §13.1),
 * not re-invented:
 * - The `Origin` header is checked against an exact-match allowlist; a missing
 *   or non-matching origin is rejected (mirrors the broadcast adapter's
 *   `authorizeConnection`, which is not on a public subpath). The check runs
 *   in Engine.IO's `allowRequest`, before the WebSocket upgrade, and again in
 *   the namespace middleware.
 * - The identity is derived once per connection by the application's
 *   `resolveUser` from the handshake's cookie or authorization header — the
 *   same session seam HTTP requests use — and never from anything the client
 *   names in a subscribe payload. Every subscription on the socket carries
 *   that user and the connection's request info into `authorize` and `query`.
 *   A resolver that throws rejects the connection; one that returns `null`
 *   makes the socket anonymous. When `revalidateIntervalMs` is set the
 *   resolver re-runs against the original handshake: a socket whose user
 *   changed in any claim (a logout, an expired or revoked session, a new
 *   role) is disconnected, and otherwise every open subscription's
 *   `authorize` runs again with the fresh user and a subscription it no
 *   longer admits with exactly `true` is revoked, so no grant outlives the
 *   state it was decided on by more than one interval.
 * - `DEFAULT_MAX_SUBSCRIPTIONS = 100` caps the open subscriptions a single
 *   socket may hold, plus a sliding-window subscribe rate limit of 10/s.
 * - Params are capped at 8 KB (oversized → rejected) and each change payload at
 *   64 KB (oversized → a snapshot replaces the subscription's state).
 * - An inbound frame is capped at 16 KiB (Engine.IO closes the connection on a
 *   larger one), and every inbound event passes a per-socket rate limit; an
 *   event over it is dropped, and a socket that keeps exceeding it is
 *   disconnected.
 *
 * Writes are server-authoritative: the client can only `subscribe`/`unsubscribe`;
 * there is no client-to-server mutation event and no client-named collection.
 * The transport translates the transport-agnostic {@link LiveServerMessage} union
 * onto the socket, mapping the service's internal subscription id to a
 * client-visible id it owns.
 */

import type { IncomingHttpHeaders, Server as NodeHttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { DefaultEventsMap, Socket } from 'socket.io';

import type { LiveRequestInfo, LiveServerMessage, LiveUser } from 'jsails/live';
import { isPositiveInteger, isRecord } from 'jsails/plugin-sdk';

import { userFingerprint } from './canonical-params.js';
import type { LiveService, LiveSubscribeRequest, LiveSubscriptionHandle } from './live-service.js';
import { LIVE_EVENTS, LIVE_PATH } from './wire.js';
import { detach, escalate } from 'jsails/support';

/** Upper bound on a socket's open live subscriptions (broadcast parity). */
const DEFAULT_MAX_SUBSCRIPTIONS = 100;
/** Subscribe attempts permitted per socket in any one-second window. */
const DEFAULT_SUBSCRIBE_RATE = 10;
/** Maximum serialized params payload size in bytes. */
const DEFAULT_MAX_PARAMS_BYTES = 8 * 1024;
/** Maximum serialized change payload size in bytes; oversized forces a snapshot. */
const DEFAULT_MAX_CHANGE_BYTES = 64 * 1024;
/** How often a resolved identity is re-checked against its handshake. */
const DEFAULT_REVALIDATE_INTERVAL_MS = 60_000;
/**
 * Largest inbound Engine.IO message. A subscribe carries at most the params
 * cap plus a small envelope, so anything larger is not a client this
 * transport serves; Engine.IO's own default (1 MB) would let every socket make
 * the server buffer and parse a megabyte per frame.
 */
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;
/**
 * Longest accepted publication name, in UTF-16 units. It bounds the subscribe
 * envelope: even fully escaped (`\u00XX`, six bytes a unit) the name stays
 * well inside {@link SUBSCRIBE_ENVELOPE_BYTES}.
 */
const MAX_PUBLICATION_NAME_LENGTH = 128;
/**
 * Bytes a subscribe frame carries besides its params: the packet type, ack
 * id, event name, publication name, `resumeFrom`, and JSON punctuation. The
 * frame cap must leave this much above the params cap, or a subscribe whose
 * params pass their own check would close the connection instead of being
 * answered with `params_too_large`.
 */
const SUBSCRIBE_ENVELOPE_BYTES = 1024;
/** Inbound events of any kind permitted per socket in any one-second window. */
const DEFAULT_INBOUND_RATE = 20;
/** Dropped events tolerated within {@link STRIKE_WINDOW_MS} before the socket is cut. */
const MAX_RATE_STRIKES = 10;
const STRIKE_WINDOW_MS = 10_000;

/**
 * The connection handshake handed to `resolveUser`. Socket.IO's client-supplied
 * `auth` object is deliberately absent: it is whatever the client chose to send
 * and must never become an identity.
 */
export interface LiveHandshake {
  /** Raw request headers, including `cookie` and `authorization`. */
  readonly headers: IncomingHttpHeaders;
  /** Parsed query string from the request URL. */
  readonly query: NodeJS.Dict<string | string[]>;
  /**
   * The handshake as a fetch `Request` (its URL and headers), so a session
   * resolver written for HTTP — `AuthSessionService.resolveSession` — accepts
   * it unchanged.
   */
  readonly request: Request;
}

/** Derive the user a connection acts as, or `null` for an anonymous connection. */
export type LiveUserResolver = (
  handshake: LiveHandshake,
) => LiveUser | null | undefined | Promise<LiveUser | null | undefined>;

/** Options for {@link attachLiveSocket}. */
export interface LiveSocketOptions {
  /**
   * Exact-match list of allowed `Origin` header values. A connection whose
   * origin is absent or not in this list is rejected. Required and non-empty.
   */
  readonly allowedOrigins: readonly string[];
  /** Maximum open subscriptions a single socket may hold. Defaults to 100. */
  readonly maxSubscriptions?: number;
  /** Subscribe attempts per socket per second. Defaults to 10. */
  readonly subscribeRate?: number;
  /** Maximum serialized params payload size in bytes. Defaults to 8 KB. */
  readonly maxParamsBytes?: number;
  /** Maximum serialized change payload size in bytes. Defaults to 64 KB. */
  readonly maxChangeBytes?: number;
  /**
   * Maximum inbound message size in bytes; a larger frame closes the
   * connection. It must exceed `maxParamsBytes` by at least 1 KiB, the room a
   * subscribe frame needs besides its params, so an oversized params payload is
   * answered with `params_too_large` rather than a closed socket. Defaults to
   * 16 KiB, or `maxParamsBytes` plus 1 KiB when that is larger.
   */
  readonly maxMessageBytes?: number;
  /**
   * Inbound events (of any kind) per socket per second. An event over the
   * rate is dropped, and a socket with more than 10 dropped events in 10
   * seconds is disconnected. Defaults to 20.
   */
  readonly inboundRate?: number;
  /** Engine.IO path. Defaults to `/_jsails/live`. */
  readonly path?: string;
  /**
   * Resolve the connection's user from its handshake — typically by reading
   * the session cookie through the same resolver HTTP routes use. Without it
   * every connection is anonymous, so only publications whose `authorize`
   * admits a `null` user can be subscribed. A resolver that throws rejects the
   * connection; a returned user must carry a non-empty string `id`.
   */
  readonly resolveUser?: LiveUserResolver;
  /**
   * Re-run `resolveUser` against every connection's original handshake at this
   * interval and disconnect a socket whose identity changed or no longer
   * resolves, and re-run `authorize` for each of its open subscriptions,
   * revoking any it no longer admits. Defaults to 60 000 ms when `resolveUser`
   * is set; `0` disables it.
   *
   * Every claim of the resolved user counts as identity, so return only the
   * claims `authorize` and `query` use: a claim that changes on every resolve
   * (a last-seen time) would disconnect the socket at every interval.
   */
  readonly revalidateIntervalMs?: number;
}

/** The handle returned by {@link attachLiveSocket}. */
export interface LiveSocketHandle {
  /**
   * Disconnect every subscriber and close what the transport owns, leaving the
   * HTTP server to its owner: it resolves once the transport's own clients
   * are gone, not when every connection of the server has ended. The
   * application's drain calls it. Idempotent.
   */
  drain(): Promise<void>;
  /**
   * Drain, then close the HTTP server too, as Socket.IO's own `close()` does.
   * Idempotent.
   */
  close(): Promise<void>;
}

/** Per-socket live subscription bookkeeping owned by the transport. */
interface LiveSocketData {
  subscriptions: Map<string, SubscriptionSlot>;
  /** Monotonic id source; allocated synchronously so concurrent subscribes never collide. */
  nextSubscriptionId: number;
  /** Set on disconnect so a late subscribe closes its handle instead of installing it. */
  closed: boolean;
  /** The user last resolved for the connection; `null` for an anonymous connection. */
  user: LiveUser | null;
  /** True while a revalidation is in flight, so a slow resolver never overlaps itself. */
  revalidating: boolean;
  /** The connection's request metadata, handed to every subscription. */
  requestInfo: LiveRequestInfo;
}

/** One client-visible subscription and the service-handle backing it. */
interface SubscriptionSlot {
  /** Client-visible id; stable across a forced-snapshot re-subscribe. */
  readonly id: string;
  /**
   * The request that opened the slot (params are replayed on a forced
   * snapshot); its user is replaced by each revalidation's fresh user.
   */
  request: LiveSubscribeRequest;
  /**
   * The open service subscription; `undefined` while the slot is a reservation
   * awaiting `service.subscribe`, and replaced when an oversized change re-snapshots.
   */
  handle: LiveSubscriptionHandle | undefined;
}

interface ResolvedOptions {
  readonly allowedOrigins: readonly string[];
  readonly maxSubscriptions: number;
  readonly subscribeRate: number;
  readonly maxParamsBytes: number;
  readonly maxChangeBytes: number;
  readonly maxMessageBytes: number;
  readonly inboundRate: number;
  readonly path: string;
  readonly resolveUser: LiveUserResolver | undefined;
  readonly revalidateIntervalMs: number;
}

type LiveServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, LiveSocketData>;
type LiveSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, LiveSocketData>;

/**
 * Mount the live transport onto `server` and return a handle whose `drain`
 * disconnects its subscribers and whose `close` also closes the server.
 */
export function attachLiveSocket(
  server: NodeHttpServer,
  service: LiveService,
  options: LiveSocketOptions,
): LiveSocketHandle {
  if (server === null || typeof server !== 'object') {
    throw new TypeError('attachLiveSocket requires an http.Server instance');
  }
  if (service === null || typeof service !== 'object') {
    throw new TypeError('attachLiveSocket requires a LiveService');
  }
  const opts = resolveOptions(options);

  const io: LiveServer = new Server(server, {
    path: opts.path,
    serveClient: false,
    transports: ['websocket'],
    maxHttpBufferSize: opts.maxMessageBytes,
    // Refuse a foreign origin before the upgrade, so it never holds a
    // WebSocket or an Engine.IO session, let alone reaches the middleware.
    allowRequest: (request, callback) => {
      callback(null, originAllowed(request.headers.origin, opts));
    },
  });

  io.use((socket, next) => {
    authorizeConnection(socket, opts).then(
      () => next(),
      () => next(new Error('unauthorized')),
    );
  });

  io.on('connection', (socket) => {
    registerSubscriptionHandlers(socket, service, opts);
  });

  let revalidateTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.resolveUser !== undefined && opts.revalidateIntervalMs > 0) {
    const resolveUser = opts.resolveUser;
    revalidateTimer = setInterval(() => {
      for (const socket of io.sockets.sockets.values()) {
        detach(revalidateSocket(socket, service, resolveUser), escalate);
      }
    }, opts.revalidateIntervalMs);
    revalidateTimer.unref();
  }

  let drainPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const drain = (): Promise<void> => {
    if (revalidateTimer !== undefined) {
      clearInterval(revalidateTimer);
      revalidateTimer = undefined;
    }
    drainPromise ??= closeSocketServer(io);
    return drainPromise;
  };
  return {
    drain,
    close(): Promise<void> {
      closePromise ??= drain().finally(() => closeHttpServer(server));
      return closePromise;
    },
  };
}

/**
 * Close everything the Socket.IO server owns and nothing else: every client's
 * transport (each socket disconnects as under Socket.IO's own `close()`, so
 * its client reconnects, to another instance during a deploy) and every
 * namespace's adapter. Socket.IO's `close()` then awaits
 * `httpServer.close()`, which resolves only once every connection of that
 * server has ended, its HTTP requests included: a drain participant awaiting
 * it would finish with the whole server, not with its own clients.
 */
async function closeSocketServer(io: LiveServer): Promise<void> {
  io.engine.close();
  // Settled, not raced, as in Socket.IO's own close: a namespace whose adapter
  // fails to close still has no client left, and the others close regardless.
  await Promise.allSettled([...io._nsps.values()].map(async (nsp) => nsp.adapter.close()));
}

/**
 * Close the HTTP server the way Socket.IO's own `close()` does: resolved once
 * every connection has ended, and a server that is not running counts as
 * closed (its owner may have closed it first).
 */
function closeHttpServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function resolveOptions(options: LiveSocketOptions): ResolvedOptions {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('attachLiveSocket requires an options object');
  }
  const { allowedOrigins } = options;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError('allowedOrigins must be a non-empty array of exact origin strings');
  }
  for (const origin of allowedOrigins) {
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new TypeError('allowedOrigins must contain only non-empty strings');
    }
  }
  const maxParamsBytes = positiveIntegerOption(options.maxParamsBytes, DEFAULT_MAX_PARAMS_BYTES);
  const minMessageBytes = maxParamsBytes + SUBSCRIBE_ENVELOPE_BYTES;
  const maxMessageBytes = positiveIntegerOption(
    options.maxMessageBytes,
    Math.max(DEFAULT_MAX_MESSAGE_BYTES, minMessageBytes),
  );
  if (maxMessageBytes < minMessageBytes) {
    throw new TypeError('maxMessageBytes must exceed maxParamsBytes by at least 1024');
  }
  return {
    allowedOrigins,
    maxSubscriptions: positiveIntegerOption(options.maxSubscriptions, DEFAULT_MAX_SUBSCRIPTIONS),
    subscribeRate: positiveIntegerOption(options.subscribeRate, DEFAULT_SUBSCRIBE_RATE),
    maxParamsBytes,
    maxChangeBytes: positiveIntegerOption(options.maxChangeBytes, DEFAULT_MAX_CHANGE_BYTES),
    maxMessageBytes,
    inboundRate: positiveIntegerOption(options.inboundRate, DEFAULT_INBOUND_RATE),
    path: options.path ?? LIVE_PATH,
    resolveUser: resolverOption(options.resolveUser),
    revalidateIntervalMs:
      options.revalidateIntervalMs === undefined
        ? DEFAULT_REVALIDATE_INTERVAL_MS
        : nonNegativeIntegerOption(options.revalidateIntervalMs),
  };
}

function resolverOption(value: unknown): LiveUserResolver | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'function') {
    throw new TypeError('resolveUser must be a function');
  }
  return value as LiveUserResolver;
}

function nonNegativeIntegerOption(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('option must be a non-negative integer');
  }
  return value;
}

function positiveIntegerOption(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!isPositiveInteger(value)) {
    throw new TypeError('option must be a positive integer');
  }
  return value;
}

/**
 * Reject a connection whose origin is not in the allowlist (broadcast parity),
 * then resolve its user once. Nothing the client sends later can change it.
 */
async function authorizeConnection(socket: LiveSocket, opts: ResolvedOptions): Promise<void> {
  const origin = socket.handshake.headers.origin;
  if (!originAllowed(origin, opts)) {
    throw new Error('origin not allowed');
  }
  const user =
    opts.resolveUser === undefined ? null : await resolveUserFor(socket, opts.resolveUser);
  socket.data.subscriptions = new Map();
  socket.data.nextSubscriptionId = 1;
  socket.data.closed = false;
  socket.data.user = user;
  socket.data.revalidating = false;
  socket.data.requestInfo = requestInfoOf(socket, origin);
}

function originAllowed(origin: unknown, opts: ResolvedOptions): origin is string {
  return typeof origin === 'string' && opts.allowedOrigins.includes(origin);
}

/**
 * Run the resolver against the socket's handshake. A throw propagates (the
 * caller denies the connection without surfacing the error text); a result
 * that is not a user with a non-empty string id is treated as anonymous rather
 * than trusted as an identity.
 */
async function resolveUserFor(
  socket: LiveSocket,
  resolveUser: LiveUserResolver,
): Promise<LiveUser | null> {
  const resolved: unknown = await resolveUser(handshakeOf(socket));
  if (!isRecord(resolved)) {
    return null;
  }
  const id = resolved['id'];
  return typeof id === 'string' && id.length > 0 ? (resolved as LiveUser) : null;
}

function handshakeOf(socket: LiveSocket): LiveHandshake {
  const { headers, query } = socket.handshake;
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      requestHeaders.set(name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        requestHeaders.append(name, item);
      }
    }
  }
  // The URL only frames the headers for a fetch-style resolver; its host is a
  // placeholder because the handshake's Host header is client-controlled.
  const request = new Request(new URL(socket.handshake.url, 'http://live.invalid'), {
    headers: requestHeaders,
  });
  return { headers, query, request };
}

function requestInfoOf(socket: LiveSocket, origin: string): LiveRequestInfo {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(socket.handshake.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const address = socket.handshake.address;
  return Object.freeze({
    ip: typeof address === 'string' && address.length > 0 ? address : null,
    origin,
    headers: Object.freeze(headers),
  });
}

/**
 * Re-resolve a connected socket's user from its original handshake, then
 * re-decide every open subscription.
 *
 * A user that differs in any claim, or a resolver that now throws, disconnects
 * the socket: each subscription's query and fan-out key were built from the
 * old claims, so none of them can be carried over, and the client reconnects
 * and subscribes again under whatever its session now carries. A user that is
 * unchanged becomes the socket's user and every subscription's `authorize`
 * runs again with it, because the grant may rest on state outside the
 * session (a membership, a publication's own data); a subscription it no
 * longer admits with exactly `true` is closed and the client told so.
 */
async function revalidateSocket(
  socket: LiveSocket,
  service: LiveService,
  resolveUser: LiveUserResolver,
): Promise<void> {
  if (!socket.connected || socket.data.closed || socket.data.revalidating) {
    return;
  }
  socket.data.revalidating = true;
  try {
    let user: LiveUser | null;
    try {
      user = await resolveUserFor(socket, resolveUser);
    } catch {
      socket.disconnect(true);
      return;
    }
    const fresh = userFingerprint(user);
    if (fresh === undefined || fresh !== userFingerprint(socket.data.user)) {
      socket.disconnect(true);
      return;
    }
    if (socket.data.closed) {
      return;
    }
    socket.data.user = user;
    await Promise.all(
      [...socket.data.subscriptions.values()].map((slot) =>
        reauthorizeSlot(socket, service, slot, user),
      ),
    );
  } finally {
    socket.data.revalidating = false;
  }
}

/** Re-run one subscription's `authorize` with the fresh user; revoke it unless admitted. */
async function reauthorizeSlot(
  socket: LiveSocket,
  service: LiveService,
  slot: SubscriptionSlot,
  user: LiveUser | null,
): Promise<void> {
  const request: LiveSubscribeRequest = { ...slot.request, user };
  slot.request = request;
  let allowed: boolean;
  try {
    allowed = (await service.authorize(request)) === true;
  } catch {
    allowed = false;
  }
  if (allowed || socket.data.subscriptions.get(slot.id) !== slot) {
    return;
  }
  socket.data.subscriptions.delete(slot.id);
  if (slot.handle !== undefined) {
    detach(slot.handle.close(), escalate);
  }
  // A reservation still awaiting the service is closed by `handleSubscribe`
  // when it finds its slot gone.
  emit(socket, slot, { type: 'error', subscriptionId: slot.id, code: 'unauthorized' });
}

function registerSubscriptionHandlers(
  socket: LiveSocket,
  service: LiveService,
  opts: ResolvedOptions,
): void {
  const rateLimiter = createRateLimiter(opts.subscribeRate, 1000);
  const inboundLimiter = createRateLimiter(opts.inboundRate, 1000);
  const strikes = createRateLimiter(MAX_RATE_STRIKES, STRIKE_WINDOW_MS);

  // Packet middleware, not `onAny`: an `onAny` listener sees an event but
  // cannot stop it from reaching the handlers.
  socket.use((event, next) => {
    if (inboundLimiter.allow()) {
      next();
      return;
    }
    if (!strikes.allow()) {
      socket.disconnect(true);
      return;
    }
    const ack = event[event.length - 1];
    if (typeof ack === 'function') {
      (ack as (response: SubscribeAck) => void)({ ok: false, error: 'rate_limited' });
    }
  });

  socket.on(LIVE_EVENTS.subscribe, (payload: unknown, ack?: (response: SubscribeAck) => void) => {
    detach(handleSubscribe(socket, service, opts, rateLimiter, payload, ack), escalate);
  });
  socket.on(LIVE_EVENTS.unsubscribe, (payload: unknown) => {
    handleUnsubscribe(socket, payload);
  });
  socket.on('disconnect', () => {
    socket.data.closed = true;
    for (const slot of socket.data.subscriptions.values()) {
      if (slot.handle !== undefined) {
        detach(slot.handle.close(), escalate);
      }
    }
    socket.data.subscriptions.clear();
  });
}

interface SubscribeAck {
  ok: boolean;
  error?: string;
}

/**
 * Parse and validate a subscribe payload, then open a client-visible
 * subscription. Params are rejected above the byte cap; the service then runs
 * Zod parsing, authorization, and the shape guard (docs/design/live.md §4.2a).
 */
async function handleSubscribe(
  socket: LiveSocket,
  service: LiveService,
  opts: ResolvedOptions,
  rateLimiter: RateLimiter,
  payload: unknown,
  ack: ((response: SubscribeAck) => void) | undefined,
): Promise<void> {
  const respond = ackOnce(ack);
  if (!rateLimiter.allow()) {
    respond({ ok: false, error: 'rate_limited' });
    return;
  }
  const request = parseSubscribeRequest(payload);
  if (request === null) {
    respond({ ok: false, error: 'invalid_request' });
    return;
  }
  const params = request.params;
  if (params !== undefined && measureParams(params) > opts.maxParamsBytes) {
    respond({ ok: false, error: 'params_too_large' });
    return;
  }
  if (socket.data.subscriptions.size >= opts.maxSubscriptions) {
    respond({ ok: false, error: 'too_many_subscriptions' });
    return;
  }

  // Reserve the slot before awaiting the service: the cap check above and the
  // id allocation below are synchronous, so a concurrent subscribe sees this
  // reservation and cannot both pass the cap or reuse the id.
  const id = String(socket.data.nextSubscriptionId);
  socket.data.nextSubscriptionId += 1;
  const slot: SubscriptionSlot = {
    id,
    request: { ...request, user: socket.data.user, request: socket.data.requestInfo },
    handle: undefined,
  };
  socket.data.subscriptions.set(id, slot);

  const sink = createSink(socket, service, opts, slot);
  let handle: LiveSubscriptionHandle;
  try {
    handle = await service.subscribe(slot.request, sink);
  } catch {
    if (socket.data.subscriptions.get(id) === slot) {
      socket.data.subscriptions.delete(id);
    }
    respond({ ok: false, error: 'internal_error' });
    return;
  }
  if (socket.data.closed || socket.data.subscriptions.get(id) !== slot) {
    // The socket disconnected or the client unsubscribed while the service was
    // opening the subscription; close the late handle rather than leak it.
    await handle.close();
    respond({ ok: false, error: 'canceled' });
    return;
  }
  slot.handle = handle;
  respond({ ok: true });
}

/** Close the named subscription (a missing id is a no-op, like unsubscribe broadcast). */
function handleUnsubscribe(socket: LiveSocket, payload: unknown): void {
  const id = parseSubscriptionId(payload);
  if (id === null) {
    return;
  }
  const slot = socket.data.subscriptions.get(id);
  if (slot !== undefined) {
    socket.data.subscriptions.delete(id);
    if (slot.handle !== undefined) {
      detach(slot.handle.close(), escalate);
    }
  }
}

/**
 * Build the sink that translates a service's {@link LiveServerMessage} onto the
 * socket under the client-visible subscription id. An oversized change payload
 * is replaced by a fresh snapshot of the same subscription (docs/design/live.md §10):
 * the current handle is closed and the request replayed without a resume offset.
 */
function createSink(
  socket: LiveSocket,
  service: LiveService,
  opts: ResolvedOptions,
  slot: SubscriptionSlot,
): (message: LiveServerMessage) => void {
  return (message) => {
    if (message.type === 'change' && measureChange(message) > opts.maxChangeBytes) {
      detach(resnapshot(socket, service, opts, slot), escalate);
      return;
    }
    emit(socket, slot, message);
  };
}

/** Replace a subscription whose change outgrew the cap with a fresh snapshot. */
async function resnapshot(
  socket: LiveSocket,
  service: LiveService,
  opts: ResolvedOptions,
  slot: SubscriptionSlot,
): Promise<void> {
  const previous = slot.handle;
  if (previous === undefined) {
    // The initial subscribe has not installed its handle yet; its snapshot is
    // already the current state, so there is nothing to re-snapshot.
    return;
  }
  const sink = createSink(socket, service, opts, slot);
  let next: LiveSubscriptionHandle;
  try {
    next = await service.subscribe({ ...slot.request, resumeFrom: undefined }, sink);
  } catch {
    // The re-subscribe failed; the previous handle stays installed and the
    // client keeps its last state (no snapshot and no change were sent).
    return;
  }
  // A disconnect, unsubscribe, or competing resnapshot may have removed or
  // replaced this slot while the re-subscribe was in flight; installing over
  // that state would leak the new handle.
  if (
    socket.data.closed ||
    socket.data.subscriptions.get(slot.id) !== slot ||
    slot.handle !== previous
  ) {
    await next.close();
    return;
  }
  slot.handle = next;
  await previous.close();
}

/** Emit one message, rewiring the service id to the client-visible id. */
function emit(socket: LiveSocket, slot: SubscriptionSlot, message: LiveServerMessage): void {
  socket.emit(LIVE_EVENTS.message, { ...message, subscriptionId: slot.id });
}

function parseSubscribeRequest(payload: unknown): LiveSubscribeRequest | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { publication, params, resumeFrom } = payload;
  if (
    typeof publication !== 'string' ||
    publication.length === 0 ||
    publication.length > MAX_PUBLICATION_NAME_LENGTH
  ) {
    return null;
  }
  // A resume cursor is a change-log sequence: a positive integer. Zero or a
  // negative value would replay the entire retained window on every subscribe.
  if (resumeFrom === undefined) {
    return { publication, params, resumeFrom: undefined };
  }
  if (!isPositiveInteger(resumeFrom) || !Number.isSafeInteger(resumeFrom)) {
    return null;
  }
  return { publication, params, resumeFrom };
}

function parseSubscriptionId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = payload.subscriptionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function measureParams(params: unknown): number {
  return Buffer.byteLength(JSON.stringify(params) ?? '', 'utf8');
}

/**
 * Serialized row sizes, keyed by the row object. The service hands every member
 * of a driver the same row object, so the row — the bulk of a change — is
 * stringified once per change rather than once per subscriber.
 */
const rowBytes = new WeakMap<object, number>();

function measureChange(message: Extract<LiveServerMessage, { type: 'change' }>): number {
  const envelope = Buffer.byteLength(JSON.stringify({ ...message, row: null }), 'utf8');
  const row = message.row;
  if (row === null) {
    return envelope;
  }
  let bytes = rowBytes.get(row);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    rowBytes.set(row, bytes);
  }
  // `null` (4 bytes) stood in for the row in the envelope.
  return envelope - 4 + bytes;
}

function ackOnce(ack: ((response: SubscribeAck) => void) | undefined): (r: SubscribeAck) => void {
  if (ack === undefined) {
    return () => {};
  }
  let called = false;
  return (response) => {
    if (!called) {
      called = true;
      ack(response);
    }
  };
}

interface RateLimiter {
  allow(): boolean;
}

/**
 * A sliding-log limiter: the timestamps of the last `limit` attempts are
 * kept, and an attempt is allowed only when fewer than `limit` fall within
 * the trailing `windowMs`, so a burst is permitted but a sustained rate above
 * the limit is not.
 */
function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const timestamps: number[] = [];
  return {
    allow(): boolean {
      const now = Date.now();
      while (timestamps.length > 0 && now - (timestamps[0] ?? now) >= windowMs) {
        timestamps.shift();
      }
      if (timestamps.length >= limit) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}
