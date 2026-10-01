/**
 * The delivery core: a {@link NotificationsService} that fans one message out
 * to a map of named channels.
 *
 * The dispatcher selects channels by name, sends through every selected
 * channel (each attempt normalized into a promise so a synchronous throw is
 * still aggregated), waits for all of them, and collapses failures into one
 * value-free {@link NotificationError} that lists only the failed channel
 * names. The plugin wires one up from its options; an application can also
 * construct one directly around its own channel map.
 */

import {
  NotificationError,
  type NotificationChannel,
  type NotificationMessage,
  type NotificationsService,
  type NotifyOptions,
} from './contract.js';

/** A channel paired with its configuration name. */
interface NamedChannel {
  readonly name: string;
  readonly channel: NotificationChannel;
}

export class NotificationDispatcher implements NotificationsService {
  readonly #named: readonly NamedChannel[];

  constructor(channels: Readonly<Record<string, NotificationChannel>>) {
    this.#named = Object.entries(channels).map(([name, channel]) => ({ name, channel }));
  }

  async notify(message: NotificationMessage, options?: NotifyOptions): Promise<void> {
    const selected = this.#selectChannels(options?.channels);
    if (selected.length === 0) {
      return;
    }

    // Normalize each send into an async boundary so a synchronous throw from
    // a misbehaving channel is captured by `allSettled` like any rejection.
    const results = await Promise.allSettled(
      selected.map(async ({ channel }) => channel.send(message)),
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
