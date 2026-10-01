/**
 * `useLive` — the browser hook for the live layer (`@jsails/live/client`).
 *
 * One hook call owns one subscription: it connects, subscribes, applies every
 * message to a {@link LiveClientStore}, and exposes the rows and connection
 * status as `@preact/signals` so a Preact island re-renders on change.
 *
 * **Reconnect resumes, it does not re-snapshot.** The client keeps the last
 * applied sequence and sends it as `resumeFrom`; the server replays the retained
 * suffix when the log still covers it, and otherwise sends a snapshot. A
 * successful resume emits replayed changes and no snapshot, so a snapshot on a
 * reconnect means continuity was lost — the hook reports `refreshed` rather than
 * silently claiming a complete history (LIVE-PLAN.md §8).
 *
 * **A silent connection is treated as dead.** A heartbeat every 15 s and a 45 s
 * silence budget force a resubscribe, because a half-open socket delivers
 * nothing and would otherwise leave the island showing stale rows forever.
 *
 * The hook is deliberately not a query language: it takes a publication name and
 * params, never a collection name or a predicate. The server decides membership.
 *
 * **The hook is inert without a browser.** A static export imports the island
 * module to render its markup, so the hook body runs on the server. Opening a
 * socket there would connect to nothing, fail, and schedule a reconnect timer
 * that keeps the build process alive forever. Outside a browser the hook returns
 * empty rows and a `connecting` status and never constructs a socket; the first
 * client render matches the server markup, and hydration opens the real one.
 */

import { signal, type ReadonlySignal } from '@preact/signals';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

import type { LiveRow, LiveServerMessage } from 'jsails/live';

import { createLiveClientStore, type LiveClientStore } from './client-store.js';

/** Connection state surfaced to the island. */
export type LiveStatus = 'connecting' | 'live' | 'refreshed' | 'error';

/** The reactive result of {@link useLive}. */
export interface UseLiveResult {
  /** The rows currently held, in insertion order. Sort by a position column. */
  readonly rows: ReadonlySignal<readonly LiveRow[]>;
  /** Connection state. `refreshed` means continuity was lost and a snapshot replaced the rows. */
  readonly status: ReadonlySignal<LiveStatus>;
  /** The last error code, or `null`. Value-free: the server never sends a message. */
  readonly error: ReadonlySignal<string | null>;
  /** Close the subscription and the socket. Idempotent. */
  dispose(): void;
}

/** Options for {@link useLive}. */
export interface UseLiveOptions {
  /** The publication to subscribe to. */
  readonly publication: string;
  /** Params validated by the publication's schema. Defaults to `{}`. */
  readonly params?: Record<string, unknown>;
  /** The collection the publication projects. Required: a snapshot carries no collection. */
  readonly collection: string;
  /** Socket.IO server URL. Defaults to the page origin. */
  readonly url?: string;
  /** Engine.IO path. Defaults to `/_jsails/live`. */
  readonly path?: string;
  /** Heartbeat interval in milliseconds. Defaults to 15 s. */
  readonly heartbeatMs?: number;
  /** Silence budget before a forced resubscribe. Defaults to 45 s. */
  readonly silenceMs?: number;
  /**
   * Extra handshake headers. Node-only: a browser ignores this and sends its own
   * `Origin`, which the server's allowlist checks. Tests and non-browser callers
   * use it to supply the `Origin` the adapter requires.
   */
  readonly extraHeaders?: Record<string, string>;
  /**
   * Socket factory. Defaults to `socket.io-client`'s `io`. Tests inject a
   * controllable socket; a custom transport can supply its own.
   *
   * Supplying this also opts out of the browser guard: an injected factory is
   * an explicit request to connect, so a Node test can drive the hook without a
   * `window`. The default factory is guarded because it is the one that would
   * otherwise run during a static export.
   */
  readonly createSocket?: (
    url: string | undefined,
    options: Partial<ManagerOptions & SocketOptions>,
  ) => Socket;
}

/** Client -> server: request a live subscription. */
const SUBSCRIBE_EVENT = 'jsails:live:subscribe';
/** Client -> server: close one subscription. */
const UNSUBSCRIBE_EVENT = 'jsails:live:unsubscribe';
/** Server -> client: one {@link LiveServerMessage}. */
const MESSAGE_EVENT = 'jsails:live:message';

const DEFAULT_PATH = '/_jsails/live';
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SILENCE_MS = 45_000;

/**
 * Subscribe to a publication and expose its rows reactively.
 *
 * Call it once per island. The returned `dispose` must be called on unmount;
 * a Preact `useEffect` cleanup is the usual place.
 */
export function useLive(options: UseLiveOptions): UseLiveResult {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('useLive requires an options object');
  }
  const { publication, collection } = options;
  if (typeof publication !== 'string' || publication.length === 0) {
    throw new TypeError('useLive requires a non-empty publication name');
  }
  if (typeof collection !== 'string' || collection.length === 0) {
    throw new TypeError('useLive requires a non-empty collection name');
  }

  // A static export imports this module to render the island's markup, so the
  // hook body runs on the server. `socket.io-client` would connect to nothing,
  // fail, and reschedule a reconnect timer forever — the build never exits.
  // An injected factory is an explicit request to connect, so it bypasses this.
  if (options.createSocket === undefined && typeof window === 'undefined') {
    return inertResult();
  }

  const params = options.params ?? {};
  const path = options.path ?? DEFAULT_PATH;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;

  const store: LiveClientStore = createLiveClientStore(collection);
  const rows = signal<readonly LiveRow[]>([]);
  const status = signal<LiveStatus>('connecting');
  const error = signal<string | null>(null);

  // The last sequence applied, kept across reconnects so a resume can ask for
  // exactly the suffix this client is missing.
  let sequence: number | undefined;
  let subscriptionId: string | undefined;
  let disposed = false;
  let lastMessageAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const socketOptions: Partial<ManagerOptions & SocketOptions> = {
    path,
    transports: ['websocket'],
    autoConnect: true,
    ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
  };
  const createSocket = options.createSocket ?? io;
  const socket: Socket = createSocket(options.url, socketOptions);

  function publishRows(): void {
    rows.value = [...store.rows().values()];
  }

  const unsubscribeStore = store.subscribe(publishRows);

  function clearHeartbeat(): void {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    lastMessageAt = Date.now();
    heartbeat = setInterval(() => {
      if (disposed) {
        return;
      }
      // A half-open socket delivers nothing. Silence past the budget is treated
      // as a dead connection: drop it and let the reconnect path resubscribe.
      // The heartbeat never re-subscribes on a live socket — every subscribe
      // allocates a new server-side subscription, so re-emitting would leak one
      // per tick instead of resuming.
      if (Date.now() - lastMessageAt > silenceMs) {
        socket.disconnect();
        socket.connect();
      }
    }, heartbeatMs);
  }

  function buildRequest(): Record<string, unknown> {
    return {
      publication,
      params,
      ...(sequence !== undefined ? { resumeFrom: sequence } : {}),
    };
  }

  function subscribe(): void {
    socket.emit(SUBSCRIBE_EVENT, buildRequest(), (ack: unknown) => {
      if (disposed) {
        return;
      }
      if (ack !== null && typeof ack === 'object' && (ack as { ok?: unknown }).ok === true) {
        status.value = 'live';
        error.value = null;
        return;
      }
      const reason = (ack as { error?: unknown } | null)?.error;
      error.value = typeof reason === 'string' ? reason : 'subscribe-failed';
      status.value = 'error';
    });
  }

  function handleMessage(message: LiveServerMessage): void {
    if (disposed) {
      return;
    }
    lastMessageAt = Date.now();
    if (message.type === 'error') {
      error.value = message.code;
      status.value = 'error';
      return;
    }
    subscriptionId = message.subscriptionId;
    if (message.type === 'snapshot') {
      // A snapshot is the server's complete answer. The service always sends
      // `resumed: false` on a snapshot — a successful resume emits replayed
      // changes and no snapshot at all — so the flag alone cannot distinguish a
      // first connect from a lost-continuity reconnect. What distinguishes them
      // is whether this client had a sequence to resume from: a first connect
      // has none and is simply `live`; a reconnect that fell back to a snapshot
      // lost the suffix and is `refreshed`.
      const hadSequence = sequence !== undefined;
      store.apply(message);
      sequence = message.sequence;
      status.value = hadSequence ? 'refreshed' : 'live';
      error.value = null;
      return;
    }
    // A change at or below the applied sequence is a replay of something this
    // client already has; applying it is harmless (rows are idempotent) but
    // advancing the watermark backwards would re-request the same suffix.
    if (sequence !== undefined && message.sequence <= sequence) {
      return;
    }
    store.apply(message);
    sequence = message.sequence;
    status.value = 'live';
  }

  socket.on('connect', () => {
    if (disposed) {
      return;
    }
    status.value = 'connecting';
    subscribe();
    startHeartbeat();
  });

  socket.on('disconnect', () => {
    if (disposed) {
      return;
    }
    clearHeartbeat();
    status.value = 'connecting';
  });

  socket.on('connect_error', () => {
    if (disposed) {
      return;
    }
    status.value = 'error';
    error.value = 'connect-failed';
  });

  socket.on(MESSAGE_EVENT, (message: unknown) => {
    if (isServerMessage(message)) {
      handleMessage(message);
    }
  });

  return {
    rows,
    status,
    error,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      clearHeartbeat();
      unsubscribeStore();
      if (subscriptionId !== undefined) {
        socket.emit(UNSUBSCRIBE_EVENT, { subscriptionId });
        subscriptionId = undefined;
      }
      socket.removeAllListeners();
      socket.disconnect();
      store.reset();
      // The store listener is already detached, so the reset above cannot
      // publish; clear the signal directly or the island keeps stale rows.
      rows.value = [];
    },
  };
}

/**
 * The result returned outside a browser: no socket, no subscription, no rows.
 *
 * `connecting` is the honest status — nothing has connected yet, and the client
 * render that follows hydration starts from the same state, so the markup
 * matches. `dispose` is a no-op because there is nothing to release.
 */
function inertResult(): UseLiveResult {
  return {
    rows: signal<readonly LiveRow[]>([]),
    status: signal<LiveStatus>('connecting'),
    error: signal<string | null>(null),
    dispose(): void {
      // Nothing was opened, so nothing needs closing.
    },
  };
}

/**
 * Structural guard for a server message.
 *
 * The socket is a trust boundary: a malformed payload must be dropped, not
 * applied. Only the fields the store reads are checked.
 */
function isServerMessage(value: unknown): value is LiveServerMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['subscriptionId'] !== 'string') {
    return false;
  }
  if (record['type'] === 'snapshot') {
    return Array.isArray(record['rows']) && typeof record['sequence'] === 'number';
  }
  if (record['type'] === 'change') {
    return (
      typeof record['collection'] === 'string' &&
      typeof record['id'] === 'string' &&
      typeof record['sequence'] === 'number' &&
      (record['row'] === null || (typeof record['row'] === 'object' && record['row'] !== null))
    );
  }
  if (record['type'] === 'error') {
    return typeof record['code'] === 'string';
  }
  return false;
}
