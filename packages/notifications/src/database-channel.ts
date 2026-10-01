/**
 * The `database` channel: store each notification as an unread record for its
 * notifiable, through a {@link NotificationStore}.
 *
 * A defined notification's payload becomes the record's `data` and its name
 * the record's `type`. A plain message (`notify`) is stored with type
 * `message` and `{ subject, text }` as data, keyed by its `to`. The app reads
 * the records back, and marks them read, through the same store.
 */

import {
  notifiableKey,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationMessage,
} from './contract.js';
import { isNotificationStore, validateNotificationData, type NotificationStore } from './store.js';

/** The record type of a plain message stored by `notify`. */
export const PLAIN_MESSAGE_TYPE = 'message';

/** Options for {@link DatabaseNotificationChannel}. */
export interface DatabaseNotificationChannelOptions {
  /** Where records are kept. */
  readonly store: NotificationStore;
}

/** A {@link NotificationChannel} that writes to a {@link NotificationStore}. */
export class DatabaseNotificationChannel implements NotificationChannel {
  readonly #store: NotificationStore;

  constructor(options: DatabaseNotificationChannelOptions) {
    const raw: unknown = options;
    if (raw === null || typeof raw !== 'object' || !isNotificationStore(options.store)) {
      throw new TypeError('DatabaseNotificationChannel requires a notification store');
    }
    this.#store = options.store;
  }

  async send(message: NotificationMessage): Promise<void> {
    await this.#store.create({
      notifiable: notifiableKey({ id: message.to }),
      type: PLAIN_MESSAGE_TYPE,
      data: { subject: message.subject, text: message.text },
    });
  }

  async deliver(delivery: NotificationDelivery): Promise<void> {
    await this.#store.create({
      notifiable: notifiableKey(delivery.notifiable),
      type: delivery.notification,
      data: validateNotificationData(delivery.payload),
    });
  }
}
