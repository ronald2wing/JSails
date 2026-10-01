/**
 * In-memory capture for tests and demos, and an adapter over the
 * `@jsails/mail` {@link Mailer}. The database and broadcast channels live in
 * their own modules.
 *
 * Neither channel is selected implicitly. The mail channel depends on the mail
 * surface through `import type` only, so this module gains no nodemailer or
 * mail-transport runtime.
 */

import type { Mailer, MailMessage } from '@jsails/mail';
import { isRecord } from 'jsails/plugin-sdk';
import {
  NotificationError,
  type NotificationChannel,
  type NotificationDelivery,
  type NotificationMessage,
} from './contract.js';

/** A channel that captures every message in memory. */
export interface MemoryNotificationChannel extends NotificationChannel {
  /** The messages captured so far, in order (a copy; the store is not mutable). */
  messages(): readonly NotificationMessage[];
  /** The defined notifications captured so far, in order. */
  deliveries(): readonly NotificationDelivery[];
}

/**
 * An in-memory {@link NotificationChannel}. Messages and defined notifications
 * are captured (copied) and nothing leaves the process.
 */
export class InMemoryNotificationChannel implements MemoryNotificationChannel {
  readonly #captured: NotificationMessage[] = [];
  readonly #deliveries: NotificationDelivery[] = [];

  async send(message: NotificationMessage): Promise<void> {
    this.#captured.push({ to: message.to, subject: message.subject, text: message.text });
  }

  async deliver(delivery: NotificationDelivery): Promise<void> {
    this.#deliveries.push({
      notification: delivery.notification,
      notifiable: delivery.notifiable,
      payload: delivery.payload,
    });
  }

  messages(): readonly NotificationMessage[] {
    return [...this.#captured];
  }

  deliveries(): readonly NotificationDelivery[] {
    return [...this.#deliveries];
  }
}

/** Options for {@link MailNotificationChannel}. */
export interface MailNotificationChannelOptions {
  /** The mailer to deliver through. */
  readonly mailer: Mailer;
}

/**
 * A {@link NotificationChannel} that adapts the mail service's {@link Mailer}.
 * For a plain message the `text` body is forwarded as the mail text body;
 * `html`/`from` are left to the mailer's own defaults. A defined notification's
 * payload is a mail message whose `to` defaults to the notifiable's `email`.
 * Message validation is the mailer's (value-free `MailError`), never this
 * adapter's.
 */
export class MailNotificationChannel implements NotificationChannel {
  readonly #mailer: Mailer;

  constructor(options: MailNotificationChannelOptions) {
    const raw: unknown = options;
    if (!isRecord(raw)) {
      throw new TypeError('MailNotificationChannel requires an options object');
    }
    if (!isMailer(raw.mailer)) {
      throw new TypeError('mailer must implement the Mailer contract');
    }
    this.#mailer = raw.mailer;
  }

  async send(message: NotificationMessage): Promise<void> {
    await this.#mailer.send({ to: message.to, subject: message.subject, text: message.text });
  }

  async deliver(delivery: NotificationDelivery): Promise<void> {
    const { payload } = delivery;
    if (!isRecord(payload)) {
      throw new NotificationError('invalid_payload', 'a mail notification must be a mail message');
    }
    const to = payload.to ?? delivery.notifiable.email;
    if (to === undefined) {
      throw new NotificationError(
        'missing_address',
        'a mail notification needs a to address or a notifiable email',
      );
    }
    await this.#mailer.send({ ...(payload as Omit<MailMessage, 'to'>), to } as MailMessage);
  }
}

/** Whether `value` has the {@link Mailer} surface. */
function isMailer(value: unknown): value is Mailer {
  return isRecord(value) && typeof value.send === 'function';
}
