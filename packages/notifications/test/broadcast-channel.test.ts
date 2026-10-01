/**
 * Broadcast channel tests: a delivery publishes `{ type, data }` on the
 * notifiable's channel through the publisher (given directly or resolved at
 * delivery time), and refuses a non-JSON payload or a missing publisher.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from 'jsails/plugin-sdk';

import {
  BroadcastNotificationChannel,
  NOTIFICATION_EVENT,
  type BroadcastPublisher,
} from '../src/broadcast-channel.js';
import { code, MESSAGE } from './fixtures.js';

interface Published {
  readonly channel: string;
  readonly event: string;
  readonly data: JsonValue;
}

function recorder(): { publisher: BroadcastPublisher; published: Published[] } {
  const published: Published[] = [];
  return {
    published,
    publisher: {
      publish(channel, event, data) {
        published.push({ channel, event, data });
      },
    },
  };
}

describe('BroadcastNotificationChannel', () => {
  it('publishes on notifications.<id> by default', async () => {
    const { publisher, published } = recorder();
    const channel = new BroadcastNotificationChannel({ publisher });
    await channel.deliver({ notification: 'ping', notifiable: { id: 7 }, payload: { n: [1] } });
    assert.deepEqual(published, [
      {
        channel: 'notifications.7',
        event: NOTIFICATION_EVENT,
        data: { type: 'ping', data: { n: [1] } },
      },
    ]);
  });

  it('honors the notifiable channel, channelFor, and event', async () => {
    const { publisher, published } = recorder();
    const channel = new BroadcastNotificationChannel({
      publisher: async () => publisher,
      channelFor: (notifiable) => `private-user.${String(notifiable.id)}`,
      event: 'notice',
    });
    await channel.deliver({ notification: 'a', notifiable: { id: 1 }, payload: null });
    await channel.deliver({
      notification: 'b',
      notifiable: { id: 1, broadcastChannel: 'team.9' },
      payload: 'x',
    });
    await channel.send(MESSAGE);
    assert.deepEqual(
      published.map(({ channel: name, event }) => [name, event]),
      [
        ['private-user.1', 'notice'],
        ['team.9', 'notice'],
        [`private-user.${MESSAGE.to}`, 'notice'],
      ],
    );
    assert.deepEqual(published[2]?.data, {
      type: 'message',
      data: { subject: 'hello', text: 'plain body' },
    });
  });

  it('refuses a payload that is not plain JSON', async () => {
    const { publisher, published } = recorder();
    const channel = new BroadcastNotificationChannel({ publisher });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const payload of [new Date(), Number.NaN, undefined, cyclic, { f: () => 1 }]) {
      await assert.rejects(
        channel.deliver({ notification: 'n', notifiable: { id: 1 }, payload }),
        code('invalid_payload'),
      );
    }
    assert.equal(published.length, 0);
  });

  it('fails a delivery when the resolver yields no publisher', async () => {
    const channel = new BroadcastNotificationChannel({ publisher: () => ({}) as never });
    await assert.rejects(
      channel.deliver({ notification: 'n', notifiable: { id: 1 }, payload: {} }),
      code('missing_broadcast'),
    );
  });

  it('validates its options', () => {
    assert.throws(() => new BroadcastNotificationChannel({ publisher: {} } as never), TypeError);
    assert.throws(
      () => new BroadcastNotificationChannel({ publisher: recorder().publisher, event: '' }),
      TypeError,
    );
    assert.throws(
      () =>
        new BroadcastNotificationChannel({
          publisher: recorder().publisher,
          channelFor: 'x' as never,
        }),
      TypeError,
    );
  });
});
