/**
 * Shared notification test fixtures: a sample message, a channel that always
 * fails with a payload no error may echo, a recording fake `Mailer`, and the
 * read/unread contract every notification store must meet.
 */

import assert from 'node:assert/strict';

import type { Mailer, MailMessage } from '@jsails/mail';
import {
  NotificationError,
  type NotificationChannel,
  type NotificationMessage,
} from '../src/contract.js';
import { MAX_NOTIFICATION_DATA_BYTES, type NotificationStore } from '../src/store.js';

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

/** Match a `NotificationError` carrying `expected`. */
export function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof NotificationError && error.code === expected;
}

/** The read/unread contract every store meets; reused by the database store tests. */
export async function exerciseStore(store: NotificationStore): Promise<void> {
  const first = await store.create({ notifiable: '1', type: 'a', data: { n: 1 } });
  const second = await store.create({ notifiable: '1', type: 'b', data: { n: 2 } });
  const other = await store.create({ notifiable: '2', type: 'a', data: { n: 3 } });
  assert.equal(first.readAt, null);
  assert.ok(first.createdAt instanceof Date);

  assert.deepEqual(
    (await store.list('1')).map((record) => record.type),
    ['b', 'a'],
    'newest first, only the notifiable rows',
  );
  assert.deepEqual(
    (await store.list('1', { limit: 1 })).map((record) => record.id),
    [second.id],
  );
  assert.equal(await store.unreadCount('1'), 2);

  assert.equal(await store.markRead('1', first.id), true);
  assert.equal(await store.markRead('2', first.id), false, 'another notifiable id never matches');
  assert.equal(await store.unreadCount('1'), 1);
  assert.deepEqual(
    (await store.list('1', { unread: true })).map((record) => record.id),
    [second.id],
  );
  const [, read] = await store.list('1');
  assert.ok(read?.readAt instanceof Date);

  assert.equal(await store.markUnread('1', first.id), true);
  assert.equal(await store.unreadCount('1'), 2);

  assert.equal(await store.markAllRead('1'), 2);
  assert.equal(await store.markAllRead('1'), 0);
  assert.equal(await store.unreadCount('1'), 0);
  assert.equal(await store.unreadCount('2'), 1, 'another notifiable is untouched');

  assert.equal(await store.delete('2', first.id), false);
  assert.equal(await store.delete('1', first.id), true);
  assert.deepEqual(
    (await store.list('1')).map((record) => record.id),
    [second.id],
  );
  assert.deepEqual((await store.list('2'))[0]?.data, { n: 3 });
  assert.equal(other.notifiable, '2');

  await assert.rejects(store.list('1', { limit: 0 }), code('invalid_payload'));
  await assert.rejects(store.list('1', { limit: 501 }), code('invalid_payload'));
  await assert.rejects(
    store.create({ notifiable: '1', type: 'a', data: [] as never }),
    code('invalid_payload'),
  );
  await assert.rejects(
    store.create({
      notifiable: '1',
      type: 'a',
      data: { big: 'x'.repeat(MAX_NOTIFICATION_DATA_BYTES) },
    }),
    code('too_large'),
  );
}
