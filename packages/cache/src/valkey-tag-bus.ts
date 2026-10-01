/**
 * The Valkey {@link CacheTagBus}: cache tag invalidations carried between the
 * processes of one app over Valkey pub/sub.
 *
 * Messages are published on the shared `command` connection and received on
 * the shared `subscriber` connection, on one channel under the app key prefix
 * (`<app key prefix>:cache:tags`), so two apps or environments sharing a
 * server never hear each other. The subscriber role reconnects and
 * resubscribes on its own, but a message sent while it was away is lost, so
 * every `ready` after the first is reported as a gap and the tag table marks
 * every tag cold. Errors are value-free `cache.unavailable`.
 *
 * Stopping a subscription removes its listeners and leaves the channel
 * subscribed on the shared connection until that connection closes: the
 * subscriber role has no reply deadline, so an `UNSUBSCRIBE` sent while the
 * server is unreachable would hold the app's shutdown until it came back.
 */

import { CacheErrors, type CacheTagBus, type CacheTagBusHandlers } from 'jsails/cache';
import {
  DEFAULT_VALKEY_TIMEOUTS,
  type ValkeyClient,
  type ValkeyConnections,
} from 'jsails/plugin-sdk';

import { assertConnections, backendError, commandClient, resolvePrefix } from './valkey-backend.js';

/** The bus's channel segment inside the app key prefix. */
const CHANNEL_SEGMENT = 'cache:tags';

/**
 * How long the `SUBSCRIBE` reply may take. The subscriber role has no reply
 * deadline of its own, and a cold tag read waits for the subscription.
 */
const SUBSCRIBE_TIMEOUT_MS = DEFAULT_VALKEY_TIMEOUTS.commandMs;

/**
 * `work`, or a value-free `cache.unavailable` once `ms` passed (or `work`
 * failed); `work` itself cannot be cancelled.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CacheErrors.Error('unavailable', { store: 'cache' }));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(backendError('cache', error));
      },
    );
  });
}

/**
 * Options for {@link ValkeyTagBus}.
 *
 * @public
 */
export interface ValkeyTagBusOptions {
  /** The app's Valkey connections; the bus never closes them. */
  readonly connections: ValkeyConnections;
  /** The channel. Defaults to `<app key prefix>:cache:tags`. */
  readonly channel?: string;
}

/**
 * Valkey pub/sub tag bus. Construction opens no connection.
 *
 * @public
 */
export class ValkeyTagBus implements CacheTagBus {
  readonly #connections: ValkeyConnections;
  readonly #channel: string;

  constructor(options: ValkeyTagBusOptions) {
    const connections = assertConnections(
      (options as Partial<ValkeyTagBusOptions> | null)?.connections,
    );
    this.#connections = connections;
    this.#channel = resolvePrefix(options.channel, `${connections.prefix}:${CHANNEL_SEGMENT}`);
  }

  async publish(message: string): Promise<void> {
    const client = await commandClient(this.#connections, 'cache');
    try {
      await client.publish(this.#channel, message);
    } catch (error) {
      throw backendError('cache', error);
    }
  }

  async subscribe(handlers: CacheTagBusHandlers): Promise<() => Promise<void>> {
    let client: ValkeyClient;
    try {
      client = await this.#connections.shared('subscriber');
    } catch (error) {
      throw backendError('cache', error);
    }
    const channel = this.#channel;
    const onMessage = (received: string, message: string): void => {
      if (received === channel) handlers.message(message);
    };
    // The client is connected and ready, so a later `ready` is a reconnect.
    const onReady = (): void => {
      handlers.gap();
    };
    client.on('message', onMessage);
    client.on('ready', onReady);
    const detach = (): void => {
      client.off('message', onMessage);
      client.off('ready', onReady);
    };
    try {
      await withDeadline(client.subscribe(channel), SUBSCRIBE_TIMEOUT_MS);
    } catch (error) {
      detach();
      throw error;
    }
    return async () => {
      detach();
    };
  }
}
