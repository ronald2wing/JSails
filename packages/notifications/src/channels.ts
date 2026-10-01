/**
 * The two channels that ship with the package: in-memory capture for tests and
 * demos, and an adapter over the `@jsails/mail` {@link Mailer}.
 *
 * Neither channel is selected implicitly. The mail channel depends on the mail
 * surface through `import type` only, so this module gains no nodemailer or
 * mail-transport runtime.
 */

import type { Mailer } from '@jsails/mail';
import { isRecord } from 'jsails/plugin-sdk';
import type { NotificationChannel, NotificationMessage } from './contract.js';

/** A channel that captures every message in memory. */
export interface MemoryNotificationChannel extends NotificationChannel {
  /** The messages captured so far, in order (a copy; the store is not mutable). */
  messages(): readonly NotificationMessage[];
}

/**
 * An in-memory {@link NotificationChannel}. Messages are captured (copied) and
 * nothing leaves the process.
 */
export class InMemoryNotificationChannel implements MemoryNotificationChannel {
  readonly #captured: NotificationMessage[] = [];

  async send(message: NotificationMessage): Promise<void> {
    this.#captured.push({ to: message.to, subject: message.subject, text: message.text });
  }

  messages(): readonly NotificationMessage[] {
    return [...this.#captured];
  }
}

/** Options for {@link MailNotificationChannel}. */
export interface MailNotificationChannelOptions {
  /** The mailer to deliver through. */
  readonly mailer: Mailer;
}

/**
 * A {@link NotificationChannel} that adapts the mail service's {@link Mailer}.
 * The `text` body is forwarded as the mail text body; `html`/`from` are left to
 * the mailer's own defaults. Message validation is the mailer's (value-free
 * `MailError`), never this adapter's.
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
}

/** Whether `value` has the {@link Mailer} surface. */
function isMailer(value: unknown): value is Mailer {
  return isRecord(value) && typeof value.send === 'function';
}
