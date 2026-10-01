/**
 * Browser-safe Socket.IO client for the JSails broadcast channel.
 *
 * This module imports `socket.io-client` only — it must never import Redis,
 * `node:crypto`, or anything Node-specific, so it stays bundleable for the
 * browser. It connects to the same origin/path the server was mounted on,
 * uses the websocket transport only, and re-subscribes to its channels whenever
 * the connection is (re)established so the server re-runs authorization on every
 * reconnect.
 *
 * Protocol (must match `src/broadcast/socketio-adapter.ts`):
 * - client -> server: `jsails:subscribe`   `{ channels: string[] }`
 * - client -> server: `jsails:unsubscribe` `{ channels: string[] }`
 * - server -> client: `jsails:event`       `{ channel, event, data }`
 * - server -> client: `jsails:revoked`     `{ channels: string[] }`
 *
 * Subscribes made in the same microtask are coalesced into one request,
 * requests are chunked to the server's per-frame channel limit, every request
 * settles within `ackTimeoutMs`, a partially denied subscribe drops only the
 * denied channels (the ack names them), and a transient failure (a timeout or
 * the server's `rate_limited`) is retried with capped backoff while the socket
 * stays connected.
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import type { JsonValue } from '../json/shape.js';

import { BROADCAST_MAX_CHANNELS_PER_REQUEST, BROADCAST_PATH } from './contracts.js';
import { detach, escalate } from '../support/detach.js';

export { BROADCAST_PATH };

const SUBSCRIBE_EVENT = 'jsails:subscribe';
const UNSUBSCRIBE_EVENT = 'jsails:unsubscribe';
const BROADCAST_EVENT = 'jsails:event';
const REVOKED_EVENT = 'jsails:revoked';
const MAX_CHANNEL_NAME_LENGTH = 128;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const REJOIN_RETRY_BASE_MS = 1000;
const REJOIN_RETRY_MAX_MS = 30_000;
const DISCONNECTED_MESSAGE = 'disconnected before subscription was confirmed';
/** Ack codes that retrying cannot fix: the request itself is refused. */
const PERMANENT_FAILURES: ReadonlySet<string> = new Set([
  'invalid_request',
  'too_many_subscriptions',
]);

/** A server-delivered broadcast payload. */
export interface BroadcastEvent {
  readonly channel: string;
  readonly event: string;
  readonly data: JsonValue;
}

/**
 * Extra properties attached to an error to signal whether a failed operation
 * can be retried. A {@link BroadcastClient} sets `retryable` on transient
 * rejoin failures so callers can distinguish them from permanent denials.
 */
export interface BroadcastClientError extends Error {
  readonly retryable?: true;
}

interface BroadcastClientOptions {
  /** Server origin. Defaults to the browser's `window.location.origin`. */
  readonly url?: string;
  /** Engine.IO path; must match the server. Defaults to `/_jsails/broadcast`. */
  readonly path?: string;
  /** Transports. Defaults to `['websocket']`. */
  readonly transports?: readonly string[];
  /**
   * Forwarded to Socket.IO's `auth`. Untrusted by the server (identity comes
   * from its own `authenticate` callback); a function form is re-invoked on
   * reconnect and can be used to attach a fresh token.
   */
  readonly auth?: Record<string, unknown> | ((cb: (data: Record<string, unknown>) => void) => void);
  /** Extra headers (e.g. `Authorization`) for header-based authentication. */
  readonly extraHeaders?: Record<string, string>;
  /** Connect immediately. Defaults to `true`. */
  readonly autoConnect?: boolean;
  /**
   * Milliseconds a subscribe/unsubscribe waits for the server's acknowledgment
   * before rejecting with a retryable `timeout` error. Defaults to `10000`.
   */
  readonly ackTimeoutMs?: number;

  // --- Reconnection (explicitly configured — no reliance on implicit defaults) ---

  /** Enable automatic reconnection. Defaults to `true`. */
  readonly reconnection?: boolean;
  /** Maximum reconnection attempts before giving up. Defaults to `Infinity`. */
  readonly reconnectionAttempts?: number;
  /** Initial delay in milliseconds before the first reconnection attempt. Defaults to `1000`. */
  readonly reconnectionDelay?: number;
  /** Maximum delay in milliseconds between reconnection attempts. Defaults to `30000`. */
  readonly reconnectionDelayMax?: number;

  // --- Lifecycle hooks ---

  /** Fired on the first successful connection or after a manual disconnect + connect. */
  readonly onConnect?: () => void;
  /** Fired after an automatic reconnection (not on the first connect). */
  readonly onReconnect?: () => void;
  /** Fired when the socket disconnects, with the Socket.IO reason string. */
  readonly onDisconnect?: (reason?: string) => void;

  /** Invoked when an asynchronous operation fails. Rejoin denials carry a
   * `retryable` property to distinguish transient from permanent failures. */
  readonly onError?: (error: Error) => void;

  // --- Testing seam ---

  /** Injectable Socket.IO factory for tests. Defaults to the real `io`. */
  readonly ioFactory?: (url: string, options: Record<string, unknown>) => Socket;
}

export interface BroadcastClient {
  /** Join one or more channels. Resolves once the server confirms membership. */
  subscribe(channels: string | string[]): Promise<void>;
  /** Leave one or more channels. Resolves once the server confirms the leave. */
  unsubscribe(channels: string | string[]): Promise<void>;
  /** Register a listener for broadcast events; returns an unregister function. */
  onEvent(listener: (event: BroadcastEvent) => void): () => void;
  /** (Re)connect. Re-subscribes to all desired channels on connect. */
  connect(): void;
  /** Disconnect; the client does not auto-reconnect after this call. */
  disconnect(): void;
  /** Alias of {@link disconnect}. */
  close(): void;
  /** Whether the underlying socket is currently connected. */
  connected(): boolean;
}

interface SubscribeResponse {
  ok: boolean;
  error?: string;
  /** Channels the server denied when it joined the rest of the request. */
  denied?: unknown;
}

/** Split a channel list into server-sized request chunks. */
function chunkChannels(channels: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < channels.length; index += BROADCAST_MAX_CHANNELS_PER_REQUEST) {
    chunks.push(channels.slice(index, index + BROADCAST_MAX_CHANNELS_PER_REQUEST));
  }
  return chunks;
}

/**
 * The denied subset of an `unauthorized` ack. An ack that names no denied
 * channels (an older or custom server) denies the whole request.
 */
function deniedChannels(response: SubscribeResponse, requested: string[]): Set<string> {
  const denied = response.denied;
  if (!Array.isArray(denied)) {
    return new Set(requested);
  }
  return new Set(
    denied.filter((name): name is string => typeof name === 'string' && requested.includes(name)),
  );
}

/** Let a Node timer not hold the process open; browsers return a number. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

function retryableError(message: string): BroadcastClientError {
  return Object.assign(new Error(message), { retryable: true as const });
}

/** Resolve the server origin, defaulting to the browser's own origin. */
function defaultOrigin(): string {
  const scope = globalThis as { location?: { origin?: string } };
  const origin = scope.location?.origin;
  if (origin !== undefined && origin !== '') {
    return origin;
  }
  throw new TypeError('BroadcastClient requires a `url` option outside of a browser');
}

/** Validate and deduplicate a channel list into unique non-empty names. */
function normalizeChannels(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : [input];
  const channels = [...new Set(list)];
  for (const channel of channels) {
    if (
      typeof channel !== 'string' ||
      channel.length === 0 ||
      channel.length > MAX_CHANNEL_NAME_LENGTH
    ) {
      throw new TypeError('channel must be a non-empty string within the configured length');
    }
  }
  return channels;
}

type PendingEntry = { resolve: () => void; reject: (error: Error) => void };

/** Subscribe calls made in one microtask, sent together as one chunked request. */
interface SubscribeBatch {
  readonly channels: Set<string>;
  readonly waiters: { readonly channels: string[]; resolve(): void; reject(error: Error): void }[];
}

export class SocketIOBroadcastClient implements BroadcastClient {
  #socket: Socket;
  #desired: Set<string>;
  #confirmed: Set<string>;
  #subscribeSeq: number;
  #pending: Map<number, PendingEntry>;
  #batch: SubscribeBatch | undefined;

  #wasEverConnected: boolean;
  #manualDisconnect: boolean;
  #ackTimeoutMs: number;
  #rejoinTimer: ReturnType<typeof setTimeout> | undefined;
  #rejoinAttempt: number;

  #onConnect: (() => void) | undefined;
  #onReconnect: (() => void) | undefined;
  #onDisconnect: ((reason?: string) => void) | undefined;
  #onError: ((error: Error) => void) | undefined;

  constructor(options: BroadcastClientOptions = {}) {
    const url = options.url ?? defaultOrigin();
    const path = options.path ?? BROADCAST_PATH;

    const realIo = options.ioFactory ?? io;

    this.#onConnect = options.onConnect;
    this.#onReconnect = options.onReconnect;
    this.#onDisconnect = options.onDisconnect;
    this.#onError = options.onError;
    const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs <= 0) {
      throw new TypeError('ackTimeoutMs must be a positive number');
    }
    this.#ackTimeoutMs = ackTimeoutMs;
    this.#rejoinTimer = undefined;
    this.#rejoinAttempt = 0;

    this.#socket = realIo(url, {
      path,
      transports: [...(options.transports ?? ['websocket'])],
      autoConnect: options.autoConnect ?? true,
      auth: options.auth,
      extraHeaders: options.extraHeaders,
      reconnection: options.reconnection ?? true,
      reconnectionAttempts: options.reconnectionAttempts ?? Infinity,
      reconnectionDelay: options.reconnectionDelay ?? 1000,
      reconnectionDelayMax: options.reconnectionDelayMax ?? 30000,
    });

    this.#desired = new Set<string>();
    this.#confirmed = new Set<string>();
    this.#subscribeSeq = 0;
    this.#pending = new Map<number, PendingEntry>();
    this.#batch = undefined;
    this.#wasEverConnected = false;
    this.#manualDisconnect = false;

    this.#socket.on('connect', () => {
      if (this.#manualDisconnect) {
        this.#manualDisconnect = false;
        this.#onConnect?.();
      } else if (this.#wasEverConnected) {
        this.#onReconnect?.();
      } else {
        this.#wasEverConnected = true;
        this.#onConnect?.();
      }
      this.#rejoinAttempt = 0;
      this.#rejoin();
    });

    this.#socket.on(REVOKED_EVENT, (payload: unknown) => {
      const channels = (payload as { channels?: unknown } | null)?.channels;
      if (!Array.isArray(channels)) {
        return;
      }
      for (const channel of channels) {
        if (typeof channel === 'string') {
          this.#desired.delete(channel);
          this.#confirmed.delete(channel);
        }
      }
      this.#reportError(new Error('unauthorized'));
    });

    this.#socket.on('disconnect', (reason: string) => {
      this.#cancelRejoinRetry();
      this.#confirmed.clear();
      for (const entry of [...this.#pending.values()]) {
        entry.reject(new Error(DISCONNECTED_MESSAGE));
      }
      this.#pending.clear();

      if (reason === 'io client disconnect') {
        this.#manualDisconnect = true;
      }

      this.#onDisconnect?.(reason);
    });

    this.#socket.on('connect_error', (error: Error) => {
      this.#reportError(error);
    });
  }

  #reportError(error: Error): void {
    this.#onError?.(error);
  }

  /**
   * Send one frame and settle with the server's ack, a synthetic `timeout`
   * after `ackTimeoutMs`, or a synthetic `disconnected` when the socket drops
   * first, so no caller waits forever on an ack that will never come.
   */
  #request(event: string, channels: string[]): Promise<SubscribeResponse> {
    return new Promise((resolve) => {
      const seq = this.#subscribeSeq;
      this.#subscribeSeq += 1;
      const settle = (response: SubscribeResponse): void => {
        if (!this.#pending.has(seq)) {
          return;
        }
        this.#pending.delete(seq);
        clearTimeout(timer);
        resolve(response);
      };
      const timer = setTimeout(() => settle({ ok: false, error: 'timeout' }), this.#ackTimeoutMs);
      unrefTimer(timer);
      this.#pending.set(seq, {
        resolve: () => settle({ ok: false, error: 'disconnected' }),
        reject: () => settle({ ok: false, error: 'disconnected' }),
      });
      this.#socket.emit(event, { channels }, (response: SubscribeResponse) => {
        settle(response ?? { ok: false, error: 'server error' });
      });
    });
  }

  /**
   * Apply one subscribe ack to the desired/confirmed sets. Returns the error to
   * surface, or `undefined` when every channel joined. An `unauthorized` ack
   * that names its denied channels drops only those; one that names none, or a
   * malformed or over-cap request, drops the whole request. Any other failure
   * is transient: the channels stay
   * desired so a later rejoin retries them.
   */
  #applySubscribeAck(
    channels: string[],
    response: SubscribeResponse,
  ): BroadcastClientError | undefined {
    if (response.ok === true) {
      for (const channel of channels) {
        this.#confirmed.add(channel);
      }
      return undefined;
    }
    const message = typeof response.error === 'string' ? response.error : 'server error';
    if (message !== 'unauthorized' && !PERMANENT_FAILURES.has(message)) {
      return retryableError(message === 'disconnected' ? DISCONNECTED_MESSAGE : message);
    }
    const denied =
      message === 'unauthorized' ? deniedChannels(response, channels) : new Set(channels);
    for (const channel of channels) {
      if (denied.has(channel)) {
        this.#desired.delete(channel);
        this.#confirmed.delete(channel);
      } else {
        this.#confirmed.add(channel);
      }
    }
    return new Error(message);
  }

  /**
   * Send every subscribe queued in the current microtask as one chunked
   * request, so a page whose components each subscribe in the same tick costs
   * a frame per 50 channels instead of a frame per call (the server caps the
   * frames a socket may have pending). Each caller settles on its own
   * channels' outcome; a transient failure keeps the channels desired and
   * schedules a rejoin retry while the socket stays connected.
   */
  async #flushSubscribes(): Promise<void> {
    const batch = this.#batch;
    this.#batch = undefined;
    if (batch === undefined) {
      return;
    }
    const channels = [...batch.channels].filter(
      (channel) => this.#desired.has(channel) && !this.#confirmed.has(channel),
    );
    const failures = new Map<string, BroadcastClientError>();
    let transient = false;
    for (const chunk of chunkChannels(channels)) {
      const error = this.#applySubscribeAck(chunk, await this.#request(SUBSCRIBE_EVENT, chunk));
      if (error === undefined) {
        continue;
      }
      this.#reportError(error);
      transient ||= error.retryable === true;
      for (const channel of chunk) {
        if (!this.#confirmed.has(channel)) {
          failures.set(channel, error);
        }
      }
    }
    if (transient) {
      this.#scheduleRejoinRetry();
    }
    for (const waiter of batch.waiters) {
      const failure = waiter.channels
        .map((channel) => failures.get(channel))
        .find((error) => error !== undefined);
      if (failure === undefined) {
        waiter.resolve();
      } else {
        waiter.reject(failure);
      }
    }
  }

  /**
   * Re-join every desired channel not yet confirmed (fires on connect/reconnect),
   * chunked to the server's per-frame limit. A permanent denial drops only the
   * denied channels; a transient failure keeps them desired and schedules a
   * retry with capped exponential backoff while the socket stays connected.
   */
  #rejoin(): void {
    const channels = [...this.#desired].filter((channel) => !this.#confirmed.has(channel));
    if (channels.length === 0) {
      return;
    }
    detach(
      (async () => {
        let transient = false;
        for (const chunk of chunkChannels(channels)) {
          const pending = chunk.filter((channel) => this.#desired.has(channel));
          if (pending.length === 0) {
            continue;
          }
          const error = this.#applySubscribeAck(
            pending,
            await this.#request(SUBSCRIBE_EVENT, pending),
          );
          if (error !== undefined) {
            transient ||= error.retryable === true;
            this.#reportError(error);
          }
        }
        if (transient) {
          this.#scheduleRejoinRetry();
        } else {
          this.#rejoinAttempt = 0;
        }
      })(),
      escalate,
    );
  }

  #scheduleRejoinRetry(): void {
    if (!this.#socket.connected || this.#rejoinTimer !== undefined) {
      return;
    }
    const delay = Math.min(REJOIN_RETRY_MAX_MS, REJOIN_RETRY_BASE_MS * 2 ** this.#rejoinAttempt);
    this.#rejoinAttempt += 1;
    this.#rejoinTimer = setTimeout(() => {
      this.#rejoinTimer = undefined;
      if (this.#socket.connected) {
        this.#rejoin();
      }
    }, delay);
    unrefTimer(this.#rejoinTimer);
  }

  #cancelRejoinRetry(): void {
    if (this.#rejoinTimer !== undefined) {
      clearTimeout(this.#rejoinTimer);
      this.#rejoinTimer = undefined;
    }
  }

  subscribe(channels: string | string[]): Promise<void> {
    const list = normalizeChannels(channels);
    for (const channel of list) {
      this.#desired.add(channel);
    }
    const toRequest = list.filter((channel) => !this.#confirmed.has(channel));
    if (toRequest.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let batch = this.#batch;
      if (batch === undefined) {
        batch = { channels: new Set<string>(), waiters: [] };
        this.#batch = batch;
        queueMicrotask(() => {
          detach(this.#flushSubscribes(), escalate);
        });
      }
      for (const channel of toRequest) {
        batch.channels.add(channel);
      }
      batch.waiters.push({ channels: toRequest, resolve, reject });
    });
  }

  async unsubscribe(channels: string | string[]): Promise<void> {
    const list = normalizeChannels(channels);
    for (const channel of list) {
      this.#desired.delete(channel);
      this.#confirmed.delete(channel);
    }
    // A disconnected socket holds no server-side membership, and the channels
    // are no longer desired, so the next connect never rejoins them.
    if (list.length === 0 || !this.#socket.connected) {
      return;
    }
    for (const chunk of chunkChannels(list)) {
      const response = await this.#request(UNSUBSCRIBE_EVENT, chunk);
      if (response.ok !== true) {
        const message = typeof response.error === 'string' ? response.error : 'invalid_request';
        throw message === 'invalid_request' ? new Error(message) : retryableError(message);
      }
    }
  }

  onEvent(listener: (event: BroadcastEvent) => void): () => void {
    const handler = (payload: BroadcastEvent): void => {
      listener(payload);
    };
    this.#socket.on(BROADCAST_EVENT, handler);
    return () => {
      this.#socket.off(BROADCAST_EVENT, handler);
    };
  }

  connect(): void {
    this.#socket.connect();
  }

  disconnect(): void {
    this.#cancelRejoinRetry();
    this.#socket.disconnect();
  }

  close(): void {
    this.disconnect();
  }

  connected(): boolean {
    return this.#socket.connected;
  }
}
