/**
 * The delivery core: a {@link NotificationsService} that fans one message out
 * to a map of named channels.
 *
 * The dispatcher selects channels by name, sends through every selected
 * channel (each attempt normalized into a promise so a synchronous throw is
 * still aggregated), waits for all of them, and collapses failures into one
 * value-free {@link NotificationError} that lists only the failed channel
 * names. Each attempt is bounded by a timeout (30 s by default): a channel
 * whose backend hangs counts as failed instead of holding the caller — often
 * a request handler — for as long as the backend's own timeouts allow. The
 * slow attempt is not cancelled (the channel contract has no cancellation),
 * only no longer awaited. The plugin wires one up from its options; an
 * application can also construct one directly around its own channel map.
 */

import {
  NotificationError,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationsService,
  type NotifyOptions,
} from './contract.js';

/** Default per-channel delivery timeout, in milliseconds. */
export const DEFAULT_CHANNEL_TIMEOUT_MS = 30_000;

/** Options for {@link NotificationDispatcher}. */
export interface NotificationDispatcherOptions {
  /** Milliseconds one channel may take before it counts as failed. Defaults to 30 000. */
  readonly channelTimeoutMs?: number;
}

/** A channel paired with its configuration name. */
interface NamedChannel {
  readonly name: string;
  readonly channel: NotificationChannel;
}

export class NotificationDispatcher implements NotificationsService {
  readonly #named: readonly NamedChannel[];
  readonly #timeoutMs: number;

  constructor(
    channels: Readonly<Record<string, NotificationChannel>>,
    options: NotificationDispatcherOptions = {},
  ) {
    const timeoutMs = options.channelTimeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('channelTimeoutMs must be a positive integer');
    }
    this.#named = Object.entries(channels).map(([name, channel]) => ({ name, channel }));
    this.#timeoutMs = timeoutMs;
  }

  async notify(message: NotificationMessage, options?: NotifyOptions): Promise<void> {
    const selected = this.#selectChannels(options?.channels);
    if (selected.length === 0) {
      return;
    }

    // Normalize each send into an async boundary so a synchronous throw from
    // a misbehaving channel is captured by `allSettled` like any rejection.
    const results = await Promise.allSettled(
      selected.map(({ channel }) => this.#bounded(async () => channel.send(message))),
    );
    const failed = selected
      .filter((_, index) => results[index]?.status === 'rejected')
      .map(({ name }) => name);
    if (failed.length > 0) {
      throw new NotificationError('delivery_failed', 'notification delivery failed', {
        channels: failed,
      });
    }
  }

  /** Run one attempt, rejecting once the timeout passes. */
  async #bounded(attempt: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new NotificationError('delivery_failed', 'notification channel timed out'));
      }, this.#timeoutMs);
    });
    try {
      await Promise.race([attempt(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve the requested channel subset, rejecting an unknown name first. */
  #selectChannels(names: readonly string[] | undefined): readonly NamedChannel[] {
    if (names === undefined) {
      return this.#named;
    }
    const byName = new Map(this.#named.map((entry) => [entry.name, entry]));
    return names.map((name) => {
      const entry = byName.get(name);
      if (entry === undefined) {
        throw new NotificationError('unknown_channel', 'notify requested an unknown channel');
      }
      return entry;
    });
  }
}
