/**
 * Valkey pub/sub wiring for multi-process broadcast.
 *
 * The adapter is optional: it is only constructed when the caller passes a
 * `valkeyUrl` to `attachBroadcast`. Importing this module has no side effects —
 * `ioredis` and `@socket.io/redis-adapter` (both speak the Redis protocol
 * Valkey implements) are loaded lazily inside
 * {@link createValkeyPubSub}, so a single-process deployment never
 * pays for them and a failed connection never leaves a half-attached server.
 *
 * Two dedicated clients are created (a publisher and a subscriber) as the
 * adapter requires; both are private to the broadcast module and are closed by
 * {@link closeValkeyPubSub} when the server shuts down.
 *
 * Error handling is non-silent by design. Connection failures reject the
 * factory promise with a sanitized error, while post-connect failures (a
 * dropped connection, a failed reconnect) are routed to the caller's `onError`
 * callback or, when absent, to `process.emitWarning`. No error path ever
 * echoes the URL: it may embed credentials.
 */

import type { Adapter } from 'socket.io-adapter';
import type { Redis } from 'ioredis';
import {
  disconnectQuietly,
  reportBackendError,
  sanitizeBackendError,
} from '../valkey/backend-errors.js';

export interface ValkeyPubSub {
  /** Adapter factory suitable for `io.adapter(...)`. */
  readonly adapter: (nsp: unknown) => Adapter;
  /** Owned publisher client. */
  readonly pub: Redis;
  /** Owned subscriber client. */
  readonly sub: Redis;
}

/** Options controlling adapter error surfacing. */
interface ValkeyPubSubOptions {
  /** Invoked with a sanitized error when a client fails after connecting. */
  onError?: (error: Error) => void;
}

/** The slice of an ioredis client the adapter depends on. */
interface RedisClientLike {
  duplicate(): RedisClientLike;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): void;
}

/**
 * Test seam: the ioredis constructor and the Socket.IO Redis adapter factory.
 * Injectable so tests can exercise lifecycle faults without a live Valkey. This
 * is a module-internal export (not re-exported from the public package), used
 * only to mock the backend for the failure paths that a real connection cannot
 * reach deterministically.
 */
export interface ValkeyPubSubDependencies {
  readonly RedisClient: new (url: string, options: object) => RedisClientLike;
  readonly createAdapter: (pub: Redis, sub: Redis) => (nsp: unknown) => Adapter;
}

/** Load the real ioredis class and Socket.IO adapter factory lazily. */
async function loadDependencies(): Promise<ValkeyPubSubDependencies> {
  const [{ Redis: RedisClient }, { createAdapter }] = await Promise.all([
    import('ioredis'),
    import('@socket.io/redis-adapter'),
  ]);
  return {
    RedisClient: RedisClient as unknown as ValkeyPubSubDependencies['RedisClient'],
    createAdapter: createAdapter as unknown as ValkeyPubSubDependencies['createAdapter'],
  };
}

/**
 * Create a Valkey-backed Socket.IO adapter bound to `url`.
 *
 * Client construction, duplication, and connection are all performed inside a
 * single failure boundary so any failure — including a constructor/duplicate
 * throw before `connect()` — leaves no half-initialized clients behind and is
 * rethrown with a generic message (the URL may contain credentials and is never
 * echoed). On failure, any clients created so far are disconnected before the
 * error is rethrown.
 */
export async function createValkeyPubSub(
  url: string,
  options: ValkeyPubSubOptions = {},
  dependencies?: ValkeyPubSubDependencies,
): Promise<ValkeyPubSub> {
  const { RedisClient, createAdapter } = dependencies ?? (await loadDependencies());

  let connected = false;
  // Post-connect failures (drops, failed reconnects) are observable. Connect
  // failures are instead reported through the rejected promise, so this handler
  // stays silent until both clients are up.
  const reportError = (error: unknown): void => {
    if (connected) {
      reportBackendFailure(error, options.onError);
    }
  };

  let pub: RedisClientLike | undefined;
  let sub: RedisClientLike | undefined;
  try {
    pub = new RedisClient(url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    sub = pub.duplicate();
    pub.on('error', reportError);
    sub.on('error', reportError);
    await Promise.all([pub.connect(), sub.connect()]);
    connected = true;
  } catch (error) {
    disconnectQuietly(sub);
    disconnectQuietly(pub);
    throw new Error('failed to connect to the Valkey broadcast adapter', {
      cause: sanitizeBackendFailure(error),
    });
  }

  return {
    adapter: createAdapter(pub as unknown as Redis, sub as unknown as Redis),
    pub: pub as unknown as Redis,
    sub: sub as unknown as Redis,
  };
}

/**
 * Close the owned clients. Errors during teardown are ignored: shutdown must
 * complete even if Valkey is already unreachable.
 */
export async function closeValkeyPubSub(adapter: ValkeyPubSub): Promise<void> {
  await Promise.all(
    [adapter.pub, adapter.sub].map(async (client) => {
      try {
        await Promise.resolve(client.disconnect());
      } catch {
        // Teardown must complete even when Valkey is already unreachable.
      }
    }),
  );
}

/** Reduce a backend error to a payload-free `Error` that cannot echo the URL. */
function sanitizeBackendFailure(error: unknown): Error {
  return sanitizeBackendError(error, 'Valkey broadcast adapter', (message) => new Error(message));
}

/** Surface a post-connect backend error to `onError`, falling back to a warning. */
function reportBackendFailure(error: unknown, onError: ((error: Error) => void) | undefined): void {
  reportBackendError(error, onError, 'Valkey broadcast adapter', (message) => new Error(message));
}
