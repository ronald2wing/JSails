/**
 * Database channel tests: a defined notification becomes an unread record of
 * its notifiable, a plain message is stored under the `message` type, and the
 * payload is validated before it reaches the store.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DatabaseNotificationChannel, PLAIN_MESSAGE_TYPE } from '../src/database-channel.js';
import { InMemoryNotificationStore } from '../src/store.js';
import { code, MESSAGE } from './fixtures.js';

describe('DatabaseNotificationChannel', () => {
  it('stores a defined notification for its notifiable', async () => {
    const store = new InMemoryNotificationStore();
    const channel = new DatabaseNotificationChannel({ store });
    await channel.deliver({
      notification: 'invoice.paid',
      notifiable: { id: 42 },
      payload: { invoice: 'INV-1' },
    });
    const [record] = await store.list('42');
    assert.equal(record?.type, 'invoice.paid');
    assert.deepEqual(record?.data, { invoice: 'INV-1' });
    assert.equal(record?.readAt, null);
  });

  it('stores a plain message under its recipient', async () => {
    const store = new InMemoryNotificationStore();
    await new DatabaseNotificationChannel({ store }).send(MESSAGE);
    const [record] = await store.list(MESSAGE.to);
    assert.equal(record?.type, PLAIN_MESSAGE_TYPE);
    assert.deepEqual(record?.data, { subject: 'hello', text: 'plain body' });
  });

  it('refuses a payload that is not a JSON object, or a bad notifiable', async () => {
    const store = new InMemoryNotificationStore();
    const channel = new DatabaseNotificationChannel({ store });
    await assert.rejects(
      channel.deliver({ notification: 'n', notifiable: { id: 1 }, payload: 'text' }),
      code('invalid_payload'),
    );
    await assert.rejects(
      channel.deliver({ notification: 'n', notifiable: { id: '' }, payload: {} }),
      code('invalid_notifiable'),
    );
    await assert.rejects(
      channel.deliver({ notification: 'n', notifiable: { id: 1.5 }, payload: {} }),
      code('invalid_notifiable'),
    );
    assert.equal(await store.unreadCount('1'), 0);
  });

  it('requires a store', () => {
    assert.throws(() => new DatabaseNotificationChannel({ store: {} } as never), TypeError);
    assert.throws(() => new DatabaseNotificationChannel(null as never), TypeError);
  });
});
