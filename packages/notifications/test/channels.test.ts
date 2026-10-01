/**
 * Channel tests: the in-memory channel captures copies of each message, and
 * the mail channel forwards `to`/`subject`/`text` to an injected `Mailer`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryNotificationChannel, MailNotificationChannel } from '../src/channels.js';
import { createFakeMailer, MESSAGE } from './fixtures.js';

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
});

describe('MailNotificationChannel', () => {
  it('forwards to/subject/text to the mailer', async () => {
    const { mailer, sent } = createFakeMailer();
    const channel = new MailNotificationChannel({ mailer });
    await channel.send(MESSAGE);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { to: 'ada@example.com', subject: 'hello', text: 'plain body' });
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
