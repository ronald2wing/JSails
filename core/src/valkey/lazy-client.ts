/**
 * A lazily connected Valkey client handle shared by the Valkey-backed stores
 * (`@jsails/cache`'s cache and mutex stores).
 *
 * Creating the handle loads no ioredis and opens no connection: the ioredis
 * class is imported, the URL resolved (`valkeyUrl`, then `VALKEY_URL`) and
 * validated, and the connection opened on the first `get()` only. A failed
 * connect is not memoized, so the next `get()` retries. Connect failures reject
 * `get()`; only post-connect failures (drops, failed reconnects) reach the
 * `onError` observer. `close()` disconnects the owned client exactly once,
 * shares one disconnect between concurrent callers, and makes every later
 * `get()` throw the caller's closed error.
 *
 * Every error leaving the handle is built by the caller's `makeError`, so each
 * store keeps its own error class; the connection URL is never echoed because
 * it may embed credentials.
 */

import { createCleanup } from '../extensions/cleanup.js';
import {
  disconnectQuietly,
  reportBackendError,
  sanitizeBackendError,
  type BackendErrorFactory,
} from './backend-errors.js';
import {
  assertConnectionUrl,
  loadIoredis,
  resolveValkeyUrl,
  VALKEY_MAX_RETRIES,
} from './connection.js';

/** The slice of an ioredis client the handle itself drives. */
export interface ConnectableValkeyClient {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/**
 * Test seam: the ioredis constructor. Injectable so a store's tests can
 * exercise lazy connect, close idempotency, and value-free error paths without
 * a live Valkey; the real ioredis class is loaded lazily when the seam is absent.
 */
export interface ValkeyClientDependencies<TClient> {
  readonly RedisClient: new (url: string, options: object) => TClient;
}

/** Options for {@link createLazyValkeyClient}. */
export interface LazyValkeyClientOptions<TClient extends ConnectableValkeyClient> {
  /** Valkey URL. Falls back to `VALKEY_URL`. */
  readonly valkeyUrl?: string;
  /** Invoked with a sanitized error when the client fails after connecting. */
  readonly onError?: (error: Error) => void;
  /** The injectable ioredis constructor. */
  readonly dependencies?: ValkeyClientDependencies<TClient>;
  /** Message prefix for backend errors (`cache backend`, `mutex backend`). */
  readonly label: string;
  /** Build the store's error from a sanitized message and an optional errno code. */
  readonly makeError: BackendErrorFactory;
  /** Build the error thrown by `get()` after `close()`. */
  readonly makeClosedError: () => Error;
}

/** A lazily connected client handle. */
export interface LazyValkeyClient<TClient> {
  /** The connected client, connecting on the first call. */
  get(): Promise<TClient>;
  /** Disconnect the owned client once; a no-op when none was ever created. */
  close(): Promise<void>;
}

/** Create a {@link LazyValkeyClient}; nothing connects until the first `get()`. */
export function createLazyValkeyClient<TClient extends ConnectableValkeyClient>(
  options: LazyValkeyClientOptions<TClient>,
): LazyValkeyClient<TClient> {
  const { label, makeError } = options;
  let client: TClient | undefined;
  let connecting: Promise<TClient> | undefined;
  let connected = false;
  let closed = false;

  async function connect(): Promise<TClient> {
    const RedisClient = options.dependencies?.RedisClient ?? (await loadIoredis<TClient>());
    const rawUrl = resolveValkeyUrl(options);
    if (rawUrl === undefined) {
      throw makeError('no Valkey URL configured: set valkeyUrl or VALKEY_URL', undefined);
    }
    const url = assertConnectionUrl(rawUrl, (message) => makeError(message, undefined));
    let instance: TClient | undefined;
    try {
      instance = new RedisClient(url, {
        lazyConnect: true,
        maxRetriesPerRequest: VALKEY_MAX_RETRIES,
        enableOfflineQueue: false,
      });
      // Connect failures reject `get()`; only post-connect failures are routed
      // to the observer.
      instance.on('error', (error) => {
        if (connected) {
          reportBackendError(error, options.onError, label, makeError);
        }
      });
      await instance.connect();
      connected = true;
      return instance;
    } catch (error) {
      disconnectQuietly(instance);
      throw sanitizeBackendError(error, label, makeError);
    }
  }

  const closeOnce = createCleanup(async () => {
    const current = client;
    client = undefined;
    connecting = undefined;
    if (current === undefined) {
      return;
    }
    try {
      await current.disconnect();
    } catch {
      // Teardown errors are ignored: shutdown must complete even if the
      // backend is already unreachable.
    }
  });

  return {
    async get(): Promise<TClient> {
      if (closed) {
        throw options.makeClosedError();
      }
      if (client !== undefined) {
        return client;
      }
      connecting ??= connect();
      let instance: TClient;
      try {
        instance = await connecting;
      } catch (error) {
        connecting = undefined;
        throw error;
      }
      if (closed) {
        // A close that raced the connect must not leave the finished client
        // behind as a leaked connection.
        disconnectQuietly(instance);
        throw options.makeClosedError();
      }
      client = instance;
      return instance;
    },
    close(): Promise<void> {
      // `closed` flips synchronously so an operation racing the close is
      // rejected before the client is torn down.
      closed = true;
      return closeOnce();
    },
  };
}
