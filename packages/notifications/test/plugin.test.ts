/**
 * `notificationsPlugin` tests: the plugin provides the service under
 * `notificationsToken` with no connection or delivery at
 * construction/setup, refuses invalid options (options that add no channel
 * included) before any setup without echoing them, and with `mail: true`
 * requires `mailToken`, fails clearly when
 * the mail service is absent, and resolves the mailer at send time.
 *
 * With `database` it writes to the store another plugin provides under the
 * token it names; with `broadcast` it publishes through the application's
 * broadcast service, looked up at delivery time.
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
import {
  checkOptionSchema,
  ConfigErrors,
  definePlugin,
  PluginErrors,
  type PluginInstance,
  type ServiceToken,
} from 'jsails/kernel';
import type { JsonValue } from 'jsails/plugin-sdk';
import { createFakeJobs, testPlugin } from 'jsails/testing';

import {
  defineNotification,
  InMemoryNotificationChannel,
  InMemoryNotificationStore,
  NotificationError,
  notificationsPlugin,
  notificationStoreToken,
  notificationsToken,
  type NotificationStore,
  type NotificationsService,
} from '../src/index.js';
import { createFakeMailer, MESSAGE } from './fixtures.js';

const rootDir = import.meta.dirname;

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

/** A plugin of the app that provides `store` under `token`, as an app keeping an inbox would. */
function storeProvider(
  store: NotificationStore,
  token: ServiceToken<NotificationStore> = notificationStoreToken,
): PluginInstance {
  return definePlugin({
    name: 'test-notification-store',
    provides: [token],
    setup({ services }) {
      services.provide(token, store);
    },
  })();
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
    assert.equal(notificationStoreToken.name, 'notifications.store');
    const memory = new InMemoryNotificationChannel();
    assert.equal(notificationsPlugin({ channels: { memory } }).name, 'notifications');
  });

  it('declares its options and the services they name', () => {
    assert.deepEqual(checkOptionSchema(notificationsPlugin.definition.options!), []);
    const memory = new InMemoryNotificationChannel();
    assert.deepEqual(notificationsPlugin({ channels: { memory } }).requires, []);
    assert.deepEqual(notificationsPlugin({ mail: true }).requires, [mailToken]);
    assert.deepEqual(notificationsPlugin({ mail: 'queue' }).requires, [mailToken]);
    assert.deepEqual(notificationsPlugin({ database: notificationStoreToken }).requires, [
      notificationStoreToken,
    ]);
    assert.deepEqual(notificationsPlugin({ channels: { memory } }).optional, [
      jobsToken,
      broadcastToken,
    ]);
    assert.deepEqual(notificationsPlugin({ channels: { memory } }).provides, [notificationsToken]);
  });

  it('refuses options that add no channel, so no notify can resolve undelivered', () => {
    const factory = notificationsPlugin as unknown as (input?: unknown) => unknown;
    const noChannel: readonly unknown[] = [
      undefined,
      {},
      { channels: {} },
      { mail: false },
      { channelTimeoutMs: 5, concurrency: 2 },
    ];
    for (const input of noChannel) {
      assert.throws(
        () => factory(input),
        (error: unknown) => ConfigErrors.is(error, 'invalid_options'),
      );
    }
  });

  it('rejects a plain notify when only opt-in channels are configured', async () => {
    const store = new InMemoryNotificationStore();
    const runtime = await runExtensions(
      [storeProvider(store), notificationsPlugin({ database: notificationStoreToken })],
      { rootDir },
    );
    try {
      await assert.rejects(
        runtime.services.get(notificationsToken).notify(MESSAGE),
        (error: unknown) => error instanceof NotificationError && error.code === 'no_channel',
      );
      assert.deepEqual(await store.list(MESSAGE.to), []);
    } finally {
      await runtime.close();
    }
  });

  it('sets up inertly with every channel, delivering nothing', async () => {
    const { mailer, sent } = createFakeMailer();
    const store = new InMemoryNotificationStore();
    const memory = new InMemoryNotificationChannel();
    const run = await testPlugin(
      notificationsPlugin({
        channels: { memory },
        mail: true,
        database: notificationStoreToken,
        broadcast: true,
      }),
      {
        services: [
          [mailToken, mailer],
          [notificationStoreToken, store],
        ],
      },
    );
    try {
      assert.deepEqual(run.provided, [notificationsToken]);
      assert.equal(sent.length, 0);
      assert.deepEqual(memory.messages(), []);
      assert.equal(await store.unreadCount('1'), 0);
    } finally {
      await run.close();
    }
  });

  it('provides a NotificationsService under the token without delivering', async () => {
    const memory = new InMemoryNotificationChannel();
    const runtime = await runExtensions([notificationsPlugin({ channels: { memory } })], {
      rootDir,
    });
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

  it('reads a channel object through its bound methods, keeping its private state', async () => {
    const memory = new InMemoryNotificationChannel();
    const run = await testPlugin(notificationsPlugin({ channels: { memory } }));
    try {
      await run.services.get(notificationsToken).notify(MESSAGE);
      assert.deepEqual(memory.messages(), [MESSAGE]);
    } finally {
      await run.close();
    }
  });

  it('fails clearly when mail: true but the mail service is absent', async () => {
    await assert.rejects(
      runExtensions([notificationsPlugin({ mail: true })], { rootDir }),
      (error: unknown) =>
        PluginErrors.is(error, 'missing_service') && error.context['token'] === 'mail',
    );
  });

  it('resolves the mailer at send time and delivers through it', async () => {
    const { mailer, sent } = createFakeMailer();
    const runtime = await runExtensions(
      [mailExtension(mailer), notificationsPlugin({ mail: true })],
      { rootDir },
    );
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
    const runtime = await runExtensions(
      [mailExtension(mailer), notificationsPlugin({ channels: { memory }, mail: true })],
      { rootDir },
    );
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
    const runtime = await runExtensions(
      [mailExtension(mailer), notificationsPlugin({ mail: true })],
      { rootDir },
    );
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

  const SECRET = 'zz-secret-input';
  const memory = new InMemoryNotificationChannel();
  const invalidOptions: readonly { readonly name: string; readonly input: unknown }[] = [
    { name: 'null', input: null },
    { name: 'an array', input: [] },
    { name: 'an unknown option', input: { [SECRET]: true } },
    { name: 'an invalid mail mode', input: { mail: SECRET } },
    { name: 'a negative channel timeout', input: { mail: true, channelTimeoutMs: -1 } },
    { name: 'a fractional channel timeout', input: { mail: true, channelTimeoutMs: 1.5 } },
    { name: 'no concurrency', input: { mail: true, concurrency: 0 } },
    { name: 'a channel map that is not a map', input: { channels: SECRET } },
    { name: 'a channel without send', input: { channels: { [SECRET]: {} } } },
    { name: 'a blank channel name', input: { channels: { ' ': memory } } },
    { name: 'a store instance', input: { database: new InMemoryNotificationStore() } },
    { name: 'a token of another family', input: { database: notificationsToken } },
    { name: 'a false broadcast', input: { broadcast: false } },
    { name: 'a publisher object', input: { broadcast: { publisher: { publish() {} } } } },
    { name: 'a blank broadcast event', input: { broadcast: { event: ' ' } } },
    { name: 'an unknown broadcast field', input: { broadcast: { [SECRET]: 1 } } },
    { name: 'a channel named mail beside mail', input: { channels: { mail: memory }, mail: true } },
    {
      name: 'a channel named database beside database',
      input: { channels: { database: memory }, database: notificationStoreToken },
    },
    {
      name: 'a channel named broadcast beside broadcast',
      input: { channels: { broadcast: memory }, broadcast: true },
    },
  ];
  for (const { name, input } of invalidOptions) {
    it(`refuses ${name} with config.invalid_options before any setup, echoing no input`, () => {
      const factory = notificationsPlugin as unknown as (input: unknown) => unknown;
      assert.throws(
        () => factory(input),
        (error: unknown) => {
          assert.ok(ConfigErrors.is(error, 'invalid_options'));
          assert.equal(`${String(error)}${JSON.stringify(error.payload)}`.includes(SECRET), false);
          return true;
        },
      );
    });
  }

  it('closes idempotently with no handles held', async () => {
    const runtime = await runExtensions(
      [notificationsPlugin({ channels: { memory: new InMemoryNotificationChannel() } })],
      { rootDir },
    );
    await runtime.close();
    await runtime.close();
  });

  it('sends a defined notification through mail, database, and broadcast', async () => {
    const { mailer, sent } = createFakeMailer();
    const store = new InMemoryNotificationStore();
    const published: [string, string, JsonValue][] = [];
    // The broadcast plugin is declared after notifications: it is looked up at delivery.
    const runtime = await runExtensions(
      [
        mailExtension(mailer),
        storeProvider(store),
        notificationsPlugin({ mail: true, database: notificationStoreToken, broadcast: true }),
        broadcastExtension(published),
      ],
      { rootDir },
    );
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

  it('writes to a keyed store member', async () => {
    const store = new InMemoryNotificationStore();
    const inbox = notificationStoreToken.named('inbox');
    const runtime = await runExtensions(
      [storeProvider(store, inbox), notificationsPlugin({ database: inbox })],
      { rootDir },
    );
    try {
      await runtime.services
        .get(notificationsToken)
        .send(ADA, welcome, { name: 'Ada' }, { channels: ['database'] });
      assert.equal(await store.unreadCount('1'), 1);
    } finally {
      await runtime.close();
    }
  });

  it('needs the plugin that provides the store it names', async () => {
    await assert.rejects(
      runExtensions([notificationsPlugin({ database: notificationStoreToken })], { rootDir }),
      (error: unknown) => PluginErrors.is(error, 'missing_service'),
    );
  });

  it('provides no store', async () => {
    const runtime = await runExtensions(
      [notificationsPlugin({ channels: { memory: new InMemoryNotificationChannel() } })],
      { rootDir },
    );
    try {
      assert.equal(runtime.services.has(notificationStoreToken), false);
    } finally {
      await runtime.close();
    }
  });

  it('fails the broadcast delivery when no broadcast service is registered', async () => {
    const store = new InMemoryNotificationStore();
    const runtime = await runExtensions(
      [
        storeProvider(store),
        notificationsPlugin({ database: notificationStoreToken, broadcast: true }),
      ],
      { rootDir },
    );
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
    const runtime = await runExtensions(
      [
        notificationsPlugin({
          broadcast: {
            publisher: () => ({
              publish(channel) {
                published.push(channel);
              },
            }),
            channelFor: (notifiable) => `user.${String(notifiable.id)}`,
          },
        }),
      ],
      { rootDir },
    );
    try {
      await runtime.services
        .get(notificationsToken)
        .send(ADA, welcome, { name: 'Ada' }, { channels: ['broadcast'] });
      assert.deepEqual(published, ['user.1']);
    } finally {
      await runtime.close();
    }
  });

  it('keeps notify on mail and custom channels when database and broadcast are added', async () => {
    const { mailer, sent } = createFakeMailer();
    const memory = new InMemoryNotificationChannel();
    const store = new InMemoryNotificationStore();
    const published: [string, string, JsonValue][] = [];
    const runtime = await runExtensions(
      [
        mailExtension(mailer),
        broadcastExtension(published),
        storeProvider(store),
        notificationsPlugin({
          channels: { memory },
          mail: true,
          database: notificationStoreToken,
          broadcast: true,
        }),
      ],
      { rootDir },
    );
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

  it('builds channels per application, so a shared instance never crosses runtimes', async () => {
    const plugin = notificationsPlugin({ broadcast: true });
    const publishedA: [string, string, JsonValue][] = [];
    const publishedB: [string, string, JsonValue][] = [];
    const runtimeA = await runExtensions([plugin, broadcastExtension(publishedA)], { rootDir });
    const runtimeB = await runExtensions([plugin, broadcastExtension(publishedB)], { rootDir });
    try {
      await runtimeA.services
        .get(notificationsToken)
        .send(ADA, welcome, { name: 'A' }, { channels: ['broadcast'] });
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
    const runtime = await runExtensions(
      [
        mailExtension(mailer),
        {
          name: 'jobs',
          setup({ services }) {
            services.provide(jobsToken, jobs);
          },
        },
        notificationsPlugin({ mail: 'queue' }),
      ],
      { rootDir },
    );
    try {
      await runtime.services
        .get(notificationsToken)
        .send(ADA, welcome, { name: 'Ada' }, { channels: ['mail'] });
      assert.equal(sent.length, 0, 'nothing is sent inline');
      jobs.assertDispatched(
        MAIL_SEND_JOB,
        (payload) => (payload as { to: unknown }).to === 'ada@example.com',
      );
    } finally {
      await runtime.close();
    }
  });
});
