/**
 * `notificationsPlugin` tests: the plugin provides the service under
 * `notificationsToken` with no connection or delivery at
 * import/construction/setup, validates its options eagerly, and with
 * `mail: true` declares `requires: [mailToken]`, fails clearly when the mail
 * service is absent, and resolves the mailer lazily at send time.
 *
 * The mail service is an injected fake provided under the real `mailToken` by
 * a stub extension, so no SMTP server, nodemailer connection, network, or
 * database is ever opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mailToken, type Mailer } from '@jsails/mail';
import { runExtensions, type JsailsExtension } from 'jsails/extensions';
import {
  InMemoryNotificationChannel,
  NotificationError,
  notificationsPlugin,
  notificationsToken,
  type NotificationChannel,
  type NotificationsService,
} from '../src/index.js';
import { createFakeMailer, MESSAGE } from './fixtures.js';

/** A stub extension that provides `mailer` under the real `mailToken`. */
function mailExtension(mailer: Mailer): JsailsExtension {
  return {
    name: 'mail',
    setup({ services }) {
      services.provide(mailToken, mailer);
    },
  };
}

describe('notificationsPlugin', () => {
  it('has name "notifications" and a stable token', () => {
    assert.equal(notificationsToken.name, 'notifications');
    assert.equal(
      notificationsPlugin({ channels: { memory: new InMemoryNotificationChannel() } }).name,
      'notifications',
    );
  });

  it('declares requires: [mailToken] only when mail is true', () => {
    const memory = new InMemoryNotificationChannel();
    assert.equal(notificationsPlugin({ channels: { memory } }).requires?.length, 0);
    assert.equal(
      notificationsPlugin({ channels: { memory }, mail: true }).requires?.[0],
      mailToken,
    );
  });

  it('provides a NotificationsService under the token without delivering', async () => {
    const memory = new InMemoryNotificationChannel();
    const runtime = await runExtensions([notificationsPlugin({ channels: { memory } })]);
    try {
      const service: NotificationsService = runtime.services.get(notificationsToken);
      assert.equal(typeof service.notify, 'function');
      assert.deepEqual(memory.messages(), []);
      await service.notify(MESSAGE);
      assert.deepEqual(memory.messages(), [MESSAGE]);
    } finally {
      await runtime.close();
    }
  });

  it('fails clearly when mail: true but the mail service is absent', async () => {
    await assert.rejects(
      runExtensions([notificationsPlugin({ mail: true })]),
      /requires service "mail"/,
    );
  });

  it('resolves the mailer lazily at send time and delivers through it', async () => {
    const { mailer, sent } = createFakeMailer();
    const runtime = await runExtensions([
      mailExtension(mailer),
      notificationsPlugin({ mail: true }),
    ]);
    try {
      assert.equal(sent.length, 0, 'no delivery happens at setup');
      await runtime.services.get(notificationsToken).notify(MESSAGE);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], { to: 'ada@example.com', subject: 'hello', text: 'plain body' });
    } finally {
      await runtime.close();
    }
  });

  it('combines an explicit channel with the mail channel', async () => {
    const { mailer, sent } = createFakeMailer();
    const memory = new InMemoryNotificationChannel();
    const runtime = await runExtensions([
      mailExtension(mailer),
      notificationsPlugin({ channels: { memory }, mail: true }),
    ]);
    try {
      await runtime.services.get(notificationsToken).notify(MESSAGE);
      assert.deepEqual(memory.messages(), [MESSAGE]);
      assert.equal(sent.length, 1);
    } finally {
      await runtime.close();
    }
  });

  it('aggregates a failing mailer into a value-free NotificationError', async () => {
    const { mailer } = createFakeMailer({ failWith: new Error('SMTP_PASSWORD_LEAK') });
    const runtime = await runExtensions([
      mailExtension(mailer),
      notificationsPlugin({ mail: true }),
    ]);
    try {
      await assert.rejects(
        runtime.services.get(notificationsToken).notify(MESSAGE),
        (error: unknown) => {
          assert.ok(error instanceof NotificationError);
          assert.equal(error.code, 'delivery_failed');
          assert.deepEqual(error.channels, ['mail']);
          assert.ok(!error.message.includes('SMTP_PASSWORD_LEAK'));
          return true;
        },
      );
    } finally {
      await runtime.close();
    }
  });

  it('validates malformed options eagerly', () => {
    assert.throws(() => notificationsPlugin(null as never), TypeError);
    assert.throws(() => notificationsPlugin([] as never), TypeError);
    assert.throws(() => notificationsPlugin({ mail: 'yes' } as never), TypeError);
    assert.throws(() => notificationsPlugin({ channels: 'not-a-map' } as never), TypeError);
    assert.throws(
      () => notificationsPlugin({ channels: { bad: {} as unknown as NotificationChannel } }),
      TypeError,
    );
    assert.throws(
      () => notificationsPlugin({ channels: { ' ': new InMemoryNotificationChannel() } }),
      TypeError,
      'blank channel name',
    );
    assert.throws(() => notificationsPlugin({}), TypeError, 'no channels and mail unset');
    assert.throws(
      () =>
        notificationsPlugin({ channels: { mail: new InMemoryNotificationChannel() }, mail: true }),
      TypeError,
      'reserved mail channel name',
    );
  });

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions([
      notificationsPlugin({ channels: { memory: new InMemoryNotificationChannel() } }),
    ]);
    await runtime.close();
    await runtime.close();
  });
});
