/**
 * `notificationsPlugin` tests: the plugin provides the service under
 * `notificationsToken` with no connection or delivery at
 * import/construction/setup, validates its options eagerly, and with
 * `mail: true` declares `requires: [mailToken]`, fails clearly when the mail
 * service is absent, and resolves the mailer lazily at send time.
 *
 * With `database` it owns the notifications table and provides the store;
 * with `broadcast` it publishes through the application's broadcast service,
 * looked up at delivery time.
 *
 * The mail and broadcast services are injected fakes provided under the real
 * tokens by stub extensions, so no SMTP server, nodemailer connection,
 * Socket.IO server, network, or database is ever opened.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAIL_SEND_JOB, mailSendJob, mailToken, type Mailer } from '@jsails/mail';
import { broadcastToken, type BroadcastService } from 'jsails/broadcast';
import { runExtensions, type JsailsExtension } from 'jsails/extensions';
import { createJobRegistry, jobsToken } from 'jsails/jobs';
import type { JsonValue } from 'jsails/plugin-sdk';
import { createFakeJobs } from 'jsails/testing';
import {
  defineNotification,
  InMemoryNotificationChannel,
  InMemoryNotificationStore,
  JsailsNotification,
  NotificationError,
  notificationsPlugin,
  notificationStoreToken,
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

/** A stub extension that provides a recording broadcast service. */
function broadcastExtension(published: [string, string, JsonValue][]): JsailsExtension {
  const service: BroadcastService = {
    publish(channel, event, data) {
      published.push([channel, event, data]);
    },
    revalidate: async () => undefined,
  };
  return {
    name: 'broadcast',
    setup({ services }) {
      services.provide(broadcastToken, service);
    },
  };
}

const welcome = defineNotification<{ readonly name: string }>('welcome', {
  channels: {
    mail: (props) => ({ subject: `Welcome ${props.name}`, text: 'hi' }),
    database: (props) => ({ name: props.name }),
    broadcast: (props) => ({ name: props.name }),
  },
});

const ADA = { id: 1, email: 'ada@example.com' };

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
    assert.throws(() => notificationsPlugin({ mail: true, channelTimeoutMs: -1 }), TypeError);
    assert.throws(() => notificationsPlugin({ mail: true, concurrency: 0 }), TypeError);
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

  it('sends a defined notification through mail, database, and broadcast', async () => {
    const { mailer, sent } = createFakeMailer();
    const store = new InMemoryNotificationStore();
    const published: [string, string, JsonValue][] = [];
    const plugin = notificationsPlugin({ mail: true, database: store, broadcast: true });
    assert.deepEqual(plugin.schema?.entities, [JsailsNotification]);
    // The broadcast plugin is declared after notifications: it is looked up at delivery.
    const runtime = await runExtensions([
      mailExtension(mailer),
      plugin,
      broadcastExtension(published),
    ]);
    try {
      await runtime.services.get(notificationsToken).send(ADA, welcome, { name: 'Ada' });
      assert.deepEqual(sent, [{ subject: 'Welcome Ada', text: 'hi', to: 'ada@example.com' }]);
      assert.equal(runtime.services.get(notificationStoreToken), store);
      assert.deepEqual((await store.list('1'))[0]?.data, { name: 'Ada' });
      assert.deepEqual(published, [
        ['notifications.1', 'notification', { type: 'welcome', data: { name: 'Ada' } }],
      ]);
    } finally {
      await runtime.close();
    }
  });

  it('declares no schema and provides no store without database', async () => {
    const plugin = notificationsPlugin({ channels: { memory: new InMemoryNotificationChannel() } });
    assert.equal(plugin.schema, undefined);
    const runtime = await runExtensions([plugin]);
    try {
      assert.equal(runtime.services.has(notificationStoreToken), false);
    } finally {
      await runtime.close();
    }
  });

  it('fails the broadcast delivery when no broadcast service is registered', async () => {
    const store = new InMemoryNotificationStore();
    const runtime = await runExtensions([
      notificationsPlugin({ database: store, broadcast: true }),
    ]);
    try {
      await assert.rejects(
        runtime.services
          .get(notificationsToken)
          .send(ADA, welcome, { name: 'Ada' }, { channels: ['database', 'broadcast'] }),
        (error: unknown) =>
          error instanceof NotificationError &&
          error.code === 'delivery_failed' &&
          error.channels.join() === 'broadcast',
      );
      assert.equal(await store.unreadCount('1'), 1, 'the database channel still delivered');
    } finally {
      await runtime.close();
    }
  });

  it('publishes through an explicit broadcast publisher', async () => {
    const published: string[] = [];
    const runtime = await runExtensions([
      notificationsPlugin({
        broadcast: {
          publisher: {
            publish(channel) {
              published.push(channel);
            },
          },
          channelFor: (notifiable) => `user.${String(notifiable.id)}`,
        },
      }),
    ]);
    try {
      await runtime.services
        .get(notificationsToken)
        .send(ADA, welcome, { name: 'Ada' }, { channels: ['broadcast'] });
      assert.deepEqual(published, ['user.1']);
    } finally {
      await runtime.close();
    }
  });

  it('validates the database and broadcast options', () => {
    const memory = new InMemoryNotificationChannel();
    assert.throws(() => notificationsPlugin({ database: {} as never }), TypeError);
    assert.throws(() => notificationsPlugin({ broadcast: false as never }), TypeError);
    assert.throws(
      () =>
        notificationsPlugin({
          channels: { database: memory },
          database: new InMemoryNotificationStore(),
        }),
      TypeError,
    );
    assert.throws(
      () => notificationsPlugin({ channels: { broadcast: memory }, broadcast: true }),
      TypeError,
    );
  });

  it('keeps notify on mail and custom channels when database and broadcast are added', async () => {
    const { mailer, sent } = createFakeMailer();
    const memory = new InMemoryNotificationChannel();
    const store = new InMemoryNotificationStore();
    const published: [string, string, JsonValue][] = [];
    const runtime = await runExtensions([
      mailExtension(mailer),
      broadcastExtension(published),
      notificationsPlugin({ channels: { memory }, mail: true, database: store, broadcast: true }),
    ]);
    try {
      await runtime.services.get(notificationsToken).notify(MESSAGE);
      assert.equal(sent.length, 1);
      assert.deepEqual(memory.messages(), [MESSAGE]);
      assert.equal(await store.unreadCount(MESSAGE.to), 0, 'no inbox row keyed by the address');
      assert.deepEqual(published, []);
    } finally {
      await runtime.close();
    }
  });

  it('builds channels per application, so a shared plugin never crosses runtimes', async () => {
    const plugin = notificationsPlugin({ broadcast: true });
    const publishedA: [string, string, JsonValue][] = [];
    const publishedB: [string, string, JsonValue][] = [];
    const runtimeA = await runExtensions([plugin, broadcastExtension(publishedA)]);
    const runtimeB = await runExtensions([plugin, broadcastExtension(publishedB)]);
    try {
      await runtimeA.services.get(notificationsToken).send(
        ADA,
        welcome,
        { name: 'A' },
        {
          channels: ['broadcast'],
        },
      );
      await runtimeB.services
        .get(notificationsToken)
        .send({ id: 2 }, welcome, { name: 'B' }, { channels: ['broadcast'] });
      assert.deepEqual(
        publishedA.map(([channel]) => channel),
        ['notifications.1'],
      );
      assert.deepEqual(
        publishedB.map(([channel]) => channel),
        ['notifications.2'],
      );
      assert.notEqual(
        runtimeA.services.get(notificationsToken),
        runtimeB.services.get(notificationsToken),
      );
    } finally {
      await runtimeA.close();
      await runtimeB.close();
    }
  });

  it("queues mail as the mail.send job with mail: 'queue'", async () => {
    const { mailer, sent } = createFakeMailer();
    const jobs = createFakeJobs({
      registry: createJobRegistry({ [MAIL_SEND_JOB]: mailSendJob }),
    });
    const runtime = await runExtensions([
      mailExtension(mailer),
      {
        name: 'jobs',
        setup({ services }) {
          services.provide(jobsToken, jobs);
        },
      },
      notificationsPlugin({ mail: 'queue' }),
    ]);
    try {
      await runtime.services.get(notificationsToken).send(
        ADA,
        welcome,
        { name: 'Ada' },
        {
          channels: ['mail'],
        },
      );
      assert.equal(sent.length, 0, 'nothing is sent inline');
      jobs.assertDispatched(
        MAIL_SEND_JOB,
        (payload) => (payload as { to: unknown }).to === 'ada@example.com',
      );
    } finally {
      await runtime.close();
    }
    assert.throws(() => notificationsPlugin({ mail: 'later' as never }), TypeError);
  });
});
