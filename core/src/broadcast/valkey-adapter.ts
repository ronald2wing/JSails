/**
 * Valkey pub/sub wiring for multi-process broadcast.
 *
 * The adapter is optional: it is only constructed when the caller passes the
 * app's Valkey connections to `attachBroadcast`. Importing this module has no
 * side effects — `@socket.io/redis-adapter` is loaded lazily inside
 * {@link createValkeyPubSub}, so a single-process deployment never pays for it
 * and a failed connection never leaves a half-attached server.
 *
 * Both clients come from the app's provider: the publisher is the shared
 * `command` connection, the subscriber the shared `subscriber` connection, so
 * broadcast adds no connections of its own and inherits their policies. The
 * `command` role has no offline queue, so while Valkey is unreachable a
 * publish fails at once instead of being held in memory for the whole outage
 * and flushed as a burst of stale events on reconnect. The adapter fires
 * publishes without awaiting them, so each publish is guarded here and its
 * failure reported once per outage rather than escaping as an unhandled
 * rejection. The subscriber resubscribes when its connection returns.
 *
 * The clients are shared, so {@link ValkeyPubSub.release} only removes this
 * module's listener; the Socket.IO adapter unsubscribes its channels when the
 * server closes, and the provider's owner disconnects the clients. No error
 * path echoes the URL: it may embed credentials.
 */

import type { Adapter } from 'socket.io-adapter';
import { reportBackendError, sanitizeBackendError } from '../valkey/backend-errors.js';
import type { ValkeyClient, ValkeyConnections } from '../valkey/connections.js';

export interface ValkeyPubSub {
  /** Adapter factory suitable for `io.adapter(...)`. */
  readonly adapter: (nsp: unknown) => Adapter;
  /** Stop observing the shared publisher; the clients stay open. */
  readonly release: () => void;
}

/** Options controlling adapter error surfacing. */
interface ValkeyPubSubOptions {
  /** Invoked with a sanitized error when a publish fails. */
  onError?: (error: Error) => void;
}

/** The slice of a client the publish guard depends on. */
interface PublisherLike {
  on(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
  publish?(...args: unknown[]): unknown;
}

/**
 * Test seam: the Socket.IO Redis adapter factory. This is a module-internal
 * export (not re-exported from the public package).
 */
export interface ValkeyPubSubDependencies {
  readonly createAdapter: (pub: ValkeyClient, sub: ValkeyClient) => (nsp: unknown) => Adapter;
}

/** Load the Socket.IO adapter factory lazily. */
async function loadDependencies(): Promise<ValkeyPubSubDependencies> {
  const { createAdapter } = await import('@socket.io/redis-adapter');
  return {
    createAdapter: createAdapter as unknown as ValkeyPubSubDependencies['createAdapter'],
  };
}

/**
 * Create a Valkey-backed Socket.IO adapter over the app's connections. A
 * connect failure rejects with a generic message whose `cause` is the
 * provider's value-free error.
 */
export async function createValkeyPubSub(
  connections: ValkeyConnections,
  options: ValkeyPubSubOptions = {},
  dependencies?: ValkeyPubSubDependencies,
): Promise<ValkeyPubSub> {
  const { createAdapter } = dependencies ?? (await loadDependencies());
  let pub: ValkeyClient;
  let sub: ValkeyClient;
  try {
    [pub, sub] = await Promise.all([
      connections.shared('command'),
      connections.shared('subscriber'),
    ]);
  } catch (error) {
    throw new Error('failed to connect to the Valkey broadcast adapter', {
      cause: sanitizeBackendFailure(error),
    });
  }
  const guard = guardPublishes(pub, (error) => {
    reportBackendFailure(error, options.onError);
  });
  return {
    adapter: createAdapter(guard.client, sub),
    release: guard.release,
  };
}

/**
 * Wrap the publisher so a publish that fails (Valkey unreachable, offline
 * queue disabled) is caught and reported instead of rejecting unobserved. Only
 * the first failure of an outage is reported; the next `ready` re-arms it, so a
 * steady broadcaster does not flood `onError` during an outage.
 */
function guardPublishes<T extends PublisherLike>(
  client: T,
  report: (error: unknown) => void,
): { readonly client: T; readonly release: () => void } {
  let reported = false;
  const onReady = (): void => {
    reported = false;
  };
  client.on('ready', onReady);
  const onFailure = (error: unknown): void => {
    if (reported) {
      return;
    }
    reported = true;
    report(error);
  };
  const proxy = new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const method = value as (...args: unknown[]) => unknown;
      if (property !== 'publish') {
        return method.bind(target);
      }
      return (...args: unknown[]): unknown => {
        let result: unknown;
        try {
          result = method.apply(target, args);
        } catch (error) {
          onFailure(error);
          return Promise.resolve(0);
        }
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            onFailure(error);
            return 0;
          });
        }
        return result;
      };
    },
  });
  return {
    client: proxy,
    release: () => {
      client.off('ready', onReady);
    },
  };
}

/** Reduce a backend error to a payload-free `Error` that cannot echo the URL. */
function sanitizeBackendFailure(error: unknown): Error {
  return sanitizeBackendError(error, 'Valkey broadcast adapter', (message) => new Error(message));
}

/** Surface a post-connect backend error to `onError`, falling back to a warning. */
function reportBackendFailure(error: unknown, onError: ((error: Error) => void) | undefined): void {
  reportBackendError(error, onError, 'Valkey broadcast adapter', (message) => new Error(message));
}
