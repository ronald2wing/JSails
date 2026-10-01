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
 * Security posture is reused from the broadcast adapter (LIVE-PLAN.md Phase 6),
 * not re-invented:
 * - The `Origin` header is checked against an exact-match allowlist; a missing
 *   or non-matching origin is rejected (mirrors `authorizeConnection` at
 *   `socketio-adapter.ts:335-346`, which is not on a public subpath).
 * - `DEFAULT_MAX_SUBSCRIPTIONS = 100` caps the open subscriptions a single
 *   socket may hold, plus a token-bucket subscribe rate limit of 10/s.
 * - Params are capped at 8 KB (oversized → rejected) and each change payload at
 *   64 KB (oversized → a snapshot replaces the subscription's state).
 *
 * Writes are server-authoritative: the client can only `subscribe`/`unsubscribe`;
 * there is no client-to-server mutation event and no client-named collection.
 * The adapter translates the transport-agnostic {@link LiveServerMessage} union
 * onto the socket, mapping the service's internal subscription id to a
 * client-visible id it owns.
 */

import type { Server as NodeHttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { DefaultEventsMap, Socket } from 'socket.io';

import type {
  LiveServerMessage,
  LiveService,
  LiveSubscribeRequest,
  LiveSubscriptionHandle,
} from 'jsails/live';

/** Client -> server: request a live subscription for a publication. */
const SUBSCRIBE_EVENT = 'jsails:live:subscribe';
/** Client -> server: close one subscription. */
const UNSUBSCRIBE_EVENT = 'jsails:live:unsubscribe';
/** Server -> client: one {@link LiveServerMessage}. */
const MESSAGE_EVENT = 'jsails:live:message';

/** Engine.IO path the live namespace mounts on. */
export const LIVE_PATH = '/_jsails/live';

/** Upper bound on a socket's open live subscriptions (broadcast parity). */
const DEFAULT_MAX_SUBSCRIPTIONS = 100;
/** Subscribe attempts permitted per socket per second (token bucket). */
const DEFAULT_SUBSCRIBE_RATE = 10;
/** Maximum serialized params payload size in bytes. */
const DEFAULT_MAX_PARAMS_BYTES = 8 * 1024;
/** Maximum serialized change payload size in bytes; oversized forces a snapshot. */
const DEFAULT_MAX_CHANGE_BYTES = 64 * 1024;

/** Options for {@link attachLiveSocket}. */
export interface LiveSocketOptions {
  /**
   * Exact-match list of allowed `Origin` header values. A connection whose
   * origin is absent or not in this list is rejected. Required and non-empty.
   */
  allowedOrigins: string[];
  /** Maximum open subscriptions a single socket may hold. Defaults to 100. */
  maxSubscriptions?: number;
  /** Subscribe attempts per socket per second. Defaults to 10. */
  subscribeRate?: number;
  /** Maximum serialized params payload size in bytes. Defaults to 8 KB. */
  maxParamsBytes?: number;
  /** Maximum serialized change payload size in bytes. Defaults to 64 KB. */
  maxChangeBytes?: number;
  /** Engine.IO path. Defaults to `/_jsails/live`. */
  path?: string;
}

/** The handle returned by {@link attachLiveSocket}. */
export interface LiveSocketHandle {
  close(): Promise<void>;
}

/** Per-socket live subscription bookkeeping owned by the adapter. */
interface LiveSocketData {
  subscriptions: Map<string, SubscriptionSlot>;
  /** Monotonic id source; allocated synchronously so concurrent subscribes never collide. */
  nextSubscriptionId: number;
  /** Set on disconnect so a late subscribe closes its handle instead of installing it. */
  closed: boolean;
}

/** One client-visible subscription and the service-handle backing it. */
interface SubscriptionSlot {
  /** Client-visible id; stable across a forced-snapshot re-subscribe. */
  readonly id: string;
  /** The request that opened the slot (params are replayed on a forced snapshot). */
  readonly request: LiveSubscribeRequest;
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
  readonly path: string;
}

type LiveServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, LiveSocketData>;
type LiveSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, LiveSocketData>;

/**
 * Mount the live transport onto `server` and return a handle whose `close`
 * shuts the Socket.IO server down.
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
  });

  io.use((socket, next) => {
    void authorizeConnection(socket, opts).then(
      () => next(),
      () => next(new Error('unauthorized')),
    );
  });

  io.on('connection', (socket) => {
    registerSubscriptionHandlers(socket, service, opts);
  });

  let closePromise: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      closePromise ??= io.close();
      return closePromise;
    },
  };
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
  return {
    allowedOrigins,
    maxSubscriptions: positiveInt(options.maxSubscriptions, DEFAULT_MAX_SUBSCRIPTIONS),
    subscribeRate: positiveInt(options.subscribeRate, DEFAULT_SUBSCRIBE_RATE),
    maxParamsBytes: positiveInt(options.maxParamsBytes, DEFAULT_MAX_PARAMS_BYTES),
    maxChangeBytes: positiveInt(options.maxChangeBytes, DEFAULT_MAX_CHANGE_BYTES),
    path: options.path ?? LIVE_PATH,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError('option must be a positive integer');
  }
  return value;
}

/** Reject a connection whose origin is not in the allowlist (broadcast parity). */
async function authorizeConnection(socket: LiveSocket, opts: ResolvedOptions): Promise<void> {
  const origin = socket.handshake.headers.origin;
  if (typeof origin !== 'string' || !opts.allowedOrigins.includes(origin)) {
    throw new Error('origin not allowed');
  }
  socket.data.subscriptions = new Map();
  socket.data.nextSubscriptionId = 1;
  socket.data.closed = false;
}

function registerSubscriptionHandlers(
  socket: LiveSocket,
  service: LiveService,
  opts: ResolvedOptions,
): void {
  const rateLimiter = createRateLimiter(opts.subscribeRate);

  socket.on(SUBSCRIBE_EVENT, (payload: unknown, ack?: (response: SubscribeAck) => void) => {
    void handleSubscribe(socket, service, opts, rateLimiter, payload, ack);
  });
  socket.on(UNSUBSCRIBE_EVENT, (payload: unknown) => {
    handleUnsubscribe(socket, payload);
  });
  socket.on('disconnect', () => {
    socket.data.closed = true;
    for (const slot of socket.data.subscriptions.values()) {
      if (slot.handle !== undefined) {
        void slot.handle.close();
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
 * Zod parsing, authorization, and the shape guard (LIVE-PLAN.md §4.2a).
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
    respond({ ok: false, error: 'rate-limited' });
    return;
  }
  const request = parseSubscribeRequest(payload);
  if (request === null) {
    respond({ ok: false, error: 'invalid-request' });
    return;
  }
  const params = request.params;
  if (params !== undefined && measureParams(params) > opts.maxParamsBytes) {
    respond({ ok: false, error: 'params-too-large' });
    return;
  }
  if (socket.data.subscriptions.size >= opts.maxSubscriptions) {
    respond({ ok: false, error: 'too-many-subscriptions' });
    return;
  }

  // Reserve the slot before awaiting the service: the cap check above and the
  // id allocation below are synchronous, so a concurrent subscribe sees this
  // reservation and cannot both pass the cap or reuse the id.
  const id = String(socket.data.nextSubscriptionId);
  socket.data.nextSubscriptionId += 1;
  const slot: SubscriptionSlot = { id, request, handle: undefined };
  socket.data.subscriptions.set(id, slot);

  const sink = createSink(socket, service, opts, slot);
  let handle: LiveSubscriptionHandle;
  try {
    handle = await service.subscribe(request, sink);
  } catch {
    if (socket.data.subscriptions.get(id) === slot) {
      socket.data.subscriptions.delete(id);
    }
    respond({ ok: false, error: 'internal-error' });
    return;
  }
  if (socket.data.closed || socket.data.subscriptions.get(id) !== slot) {
    // The socket disconnected or the client unsubscribed while the service was
    // opening the subscription; close the late handle rather than leak it.
    await handle.close();
    respond({ ok: false, error: 'cancelled' });
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
      void slot.handle.close();
    }
  }
}

/**
 * Build the sink that translates a service's {@link LiveServerMessage} onto the
 * socket under the client-visible subscription id. An oversized change payload
 * is replaced by a fresh snapshot of the same subscription (LIVE-PLAN.md §10):
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
      void resnapshot(socket, service, opts, slot);
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
  socket.emit(MESSAGE_EVENT, { ...message, subscriptionId: slot.id });
}

function parseSubscribeRequest(payload: unknown): LiveSubscribeRequest | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.publication !== 'string' || record.publication.length === 0) {
    return null;
  }
  if (record.resumeFrom !== undefined && typeof record.resumeFrom !== 'number') {
    return null;
  }
  return {
    publication: record.publication,
    params: record.params,
    resumeFrom: record.resumeFrom,
  };
}

function parseSubscriptionId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  const id = (payload as Record<string, unknown>).subscriptionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function measureParams(params: unknown): number {
  return Buffer.byteLength(JSON.stringify(params) ?? '', 'utf8');
}

function measureChange(message: Extract<LiveServerMessage, { type: 'change' }>): number {
  return Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8');
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
 * A fixed-window-per-token bucket: at most `perSecond` tokens in a sliding
 * window, so a burst is permitted but a sustained rate above the limit is not.
 */
function createRateLimiter(perSecond: number): RateLimiter {
  const timestamps: number[] = [];
  return {
    allow(): boolean {
      const now = Date.now();
      while (timestamps.length > 0 && now - (timestamps[0] ?? now) >= 1000) {
        timestamps.shift();
      }
      if (timestamps.length >= perSecond) {
        return false;
      }
      timestamps.push(now);
      return true;
    },
  };
}
