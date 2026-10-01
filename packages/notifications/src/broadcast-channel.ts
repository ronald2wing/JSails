/**
 * The `broadcast` channel: publish each notification as a realtime event.
 *
 * The channel publishes through a {@link BroadcastPublisher}, the one-method
 * shape of `jsails/broadcast`'s `BroadcastService`, so the first-party
 * broadcast plugin plugs in directly and any other realtime transport can be
 * adapted to it. The publisher may be given as a thunk, resolved on every
 * delivery, which lets the plugin find the broadcast service at send time.
 *
 * Each delivery publishes the event (`notification` by default) on the
 * notifiable's channel — its `broadcastChannel`, else the configured
 * `channelFor(notifiable)`, else `notifications.<id>` — with
 * `{ type, data }` as the payload. Broadcast is ephemeral: a client that is not
 * subscribed misses the event, so pair it with the database channel when the
 * notification must survive. The app's broadcast `authorizeChannel` decides
 * who may subscribe to each notifiable's channel; this channel publishes only.
 */

import { isPlainObject, type JsonValue } from 'jsails/plugin-sdk';
import {
  NotificationError,
  notifiableKey,
  type Notifiable,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationMessage,
} from './contract.js';
import { PLAIN_MESSAGE_TYPE } from './database-channel.js';

/** What the broadcast channel publishes through. */
export interface BroadcastPublisher {
  /** Publish one ephemeral event on `channel`. */
  publish(channel: string, event: string, data: JsonValue): void | Promise<void>;
}

/** The event name published by default. */
export const NOTIFICATION_EVENT = 'notification';

/** The broadcast channel prefix used when neither the notifiable nor `channelFor` names one. */
export const NOTIFICATION_CHANNEL_PREFIX = 'notifications.';

/** Options for {@link BroadcastNotificationChannel}. */
export interface BroadcastNotificationChannelOptions {
  /** The publisher, or a function resolving it at delivery time. */
  readonly publisher: BroadcastPublisher | (() => BroadcastPublisher | Promise<BroadcastPublisher>);
  /** The channel for a notifiable that names none. Defaults to `notifications.<id>`. */
  readonly channelFor?: (notifiable: Notifiable) => string;
  /** The event name. Defaults to `notification`. */
  readonly event?: string;
}

/** A {@link NotificationChannel} that publishes through a {@link BroadcastPublisher}. */
export class BroadcastNotificationChannel implements NotificationChannel {
  readonly #resolve: () => BroadcastPublisher | Promise<BroadcastPublisher>;
  readonly #channelFor: (notifiable: Notifiable) => string;
  readonly #event: string;

  constructor(options: BroadcastNotificationChannelOptions) {
    const raw: unknown = options;
    if (raw === null || typeof raw !== 'object') {
      throw new TypeError('BroadcastNotificationChannel requires an options object');
    }
    const { publisher, channelFor, event } = options;
    if (typeof publisher === 'function') {
      this.#resolve = publisher;
    } else if (isPublisher(publisher)) {
      this.#resolve = () => publisher;
    } else {
      throw new TypeError('publisher must have a publish method or be a function returning one');
    }
    if (channelFor !== undefined && typeof channelFor !== 'function') {
      throw new TypeError('channelFor must be a function');
    }
    if (event !== undefined && (typeof event !== 'string' || event.trim() === '')) {
      throw new TypeError('event must be a non-empty string');
    }
    this.#channelFor =
      channelFor ?? ((notifiable) => `${NOTIFICATION_CHANNEL_PREFIX}${notifiableKey(notifiable)}`);
    this.#event = event ?? NOTIFICATION_EVENT;
  }

  async send(message: NotificationMessage): Promise<void> {
    await this.#publish({ id: message.to }, PLAIN_MESSAGE_TYPE, {
      subject: message.subject,
      text: message.text,
    });
  }

  async deliver(delivery: NotificationDelivery): Promise<void> {
    await this.#publish(delivery.notifiable, delivery.notification, delivery.payload);
  }

  async #publish(notifiable: Notifiable, type: string, data: unknown): Promise<void> {
    if (!isJson(data)) {
      throw new NotificationError('invalid_payload', 'a broadcast notification must be JSON');
    }
    notifiableKey(notifiable);
    const channel = notifiable.broadcastChannel ?? this.#channelFor(notifiable);
    if (typeof channel !== 'string' || channel === '') {
      throw new NotificationError(
        'invalid_notifiable',
        'a broadcast channel must be a non-empty string',
      );
    }
    const publisher = await this.#resolve();
    if (!isPublisher(publisher)) {
      throw new NotificationError('missing_broadcast', 'no broadcast publisher is available');
    }
    await publisher.publish(channel, this.#event, { type, data });
  }
}

function isPublisher(value: unknown): value is BroadcastPublisher {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<BroadcastPublisher>).publish === 'function'
  );
}

/** How deep a broadcast payload may nest; also stops a cyclic value. */
const MAX_JSON_DEPTH = 64;

/** Whether `value` is plain JSON data (finite numbers, plain objects, arrays). */
function isJson(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (depth >= MAX_JSON_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJson(entry, depth + 1));
  }
  return isPlainObject(value) && Object.values(value).every((entry) => isJson(entry, depth + 1));
}
