/**
 * Shared notification test fixtures: a sample message, a channel that always
 * fails with a payload no error may echo, and a recording fake `Mailer`.
 */

import type { Mailer, MailMessage } from '@jsails/mail';
import type { NotificationChannel, NotificationMessage } from '../src/contract.js';

export const MESSAGE: NotificationMessage = {
  to: 'ada@example.com',
  subject: 'hello',
  text: 'plain body',
};

/** A channel that always rejects with a payload the error must never echo. */
export const failingChannel: NotificationChannel = {
  async send() {
    throw new Error('SECRET_BACKEND_CREDENTIAL');
  },
};

/** A fake `Mailer` recording sent messages, optionally failing on send. */
export function createFakeMailer(options?: { failWith?: Error }): {
  mailer: Mailer;
  sent: MailMessage[];
} {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      if (options?.failWith !== undefined) {
        throw options.failWith;
      }
      sent.push(message);
    },
  };
  return { mailer, sent };
}
