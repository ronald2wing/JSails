/**
 * Channel tests: the in-memory channel captures copies of each message and
 * delivery, and the mail channel forwards `to`/`subject`/`text` (or a defined
 * notification's mail payload, addressed to the notifiable) to an injected
 * `Mailer`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryNotificationChannel, MailNotificationChannel } from '../src/channels.js';
import { code, createFakeMailer, MESSAGE } from './fixtures.js';

describe('InMemoryNotificationChannel', () => {
  it('captures each message in order, copied', async () => {
    const channel = new InMemoryNotificationChannel();
    await channel.send(MESSAGE);
    await channel.send({ to: 'grace@example.com', subject: 'again', text: 'second' });

    const messages = channel.messages();
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], MESSAGE);
    assert.deepEqual(messages[1], {
      to: 'grace@example.com',
      subject: 'again',
      text: 'second',
    });

    const snapshot = channel.messages();
    await channel.send({ to: 'linus@example.com', subject: 'third', text: 'more' });
    assert.equal(snapshot.length, 2, 'a previously returned snapshot is unchanged');
  });

  it('captures defined notification deliveries', async () => {
    const channel = new InMemoryNotificationChannel();
    const delivery = { notification: 'n', notifiable: { id: 1 }, payload: { a: 1 } };
    await channel.deliver(delivery);
    assert.deepEqual(channel.deliveries(), [delivery]);
    assert.notEqual(channel.deliveries()[0], delivery);
  });
});

describe('MailNotificationChannel', () => {
  it('forwards to/subject/text to the mailer', async () => {
    const { mailer, sent } = createFakeMailer();
    const channel = new MailNotificationChannel({ mailer });
    await channel.send(MESSAGE);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { to: 'ada@example.com', subject: 'hello', text: 'plain body' });
  });

  it('delivers a defined notification to the notifiable email by default', async () => {
    const { mailer, sent } = createFakeMailer();
    const channel = new MailNotificationChannel({ mailer });
    await channel.deliver({
      notification: 'welcome',
      notifiable: { id: 1, email: { name: 'Ada', address: 'ada@example.com' } },
      payload: { subject: 'Hi', text: 't', html: '<p>t</p>' },
    });
    await channel.deliver({
      notification: 'welcome',
      notifiable: { id: 1, email: 'ada@example.com' },
      payload: { to: 'ops@example.com', subject: 'Copy', text: 't' },
    });
    assert.deepEqual(sent, [
      {
        subject: 'Hi',
        text: 't',
        html: '<p>t</p>',
        to: { name: 'Ada', address: 'ada@example.com' },
      },
      { to: 'ops@example.com', subject: 'Copy', text: 't' },
    ]);
  });

  it('refuses a delivery with no address or a non-object payload', async () => {
    const { mailer, sent } = createFakeMailer();
    const channel = new MailNotificationChannel({ mailer });
    await assert.rejects(
      channel.deliver({ notification: 'n', notifiable: { id: 1 }, payload: { subject: 's' } }),
      code('missing_address'),
    );
    await assert.rejects(
      channel.deliver({ notification: 'n', notifiable: { id: 1 }, payload: 'text' }),
      code('invalid_payload'),
    );
    assert.equal(sent.length, 0);
  });

  it('propagates a mailer failure', async () => {
    const { mailer } = createFakeMailer({ failWith: new Error('backend down') });
    const channel = new MailNotificationChannel({ mailer });
    await assert.rejects(channel.send(MESSAGE), /backend down/);
  });

  it('rejects a non-mailer at construction', () => {
    assert.throws(() => new MailNotificationChannel({} as never), TypeError);
    assert.throws(() => new MailNotificationChannel({ mailer: {} } as never), TypeError);
    assert.throws(() => new MailNotificationChannel(null as never), TypeError);
  });
});
