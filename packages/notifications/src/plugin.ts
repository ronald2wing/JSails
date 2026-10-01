/**
 * The `notifications` plugin: exposes a multi-channel
 * {@link NotificationsService} under a typed service token.
 *
 * `notificationsPlugin({ channels?, mail?, database?, broadcast? })` is a
 * plugin on the `definePlugin` contract of `jsails/kernel` whose `setup`
 * provides the service under {@link notificationsToken}. Its options are data
 * and functions, checked before any setup:
 *
 * - `channels` is a map of named {@link NotificationChannel}s, keyed by
 *   non-empty names. Each is read as its `send` (and optional `deliver`),
 *   bound to the object given, so a class instance keeps its private state;
 * - `mail: true` adds a channel named `mail` that adapts the first-party mail
 *   service, and requires `mailToken`, so assembly fails with a value-free
 *   missing-requirement error without the mail plugin. The mailer is resolved
 *   at send time, so no mail transport or connection is touched at
 *   construction or setup. `mail: 'queue'` is the same channel, but each
 *   message is validated and dispatched as the mail plugin's `mail.send` job
 *   (through the jobs service, an optional service the plugin declares);
 * - `database: notificationStoreToken` (or a keyed member) adds a channel
 *   named `database` writing to the {@link NotificationStore} another plugin
 *   provides under that token, a service the plugin then requires. The
 *   TypeORM store and its table are on `@jsails/notifications/database`, so
 *   this entry loads no TypeORM; the app that keeps an inbox owns the table
 *   and the plugin that provides the store;
 * - `broadcast: true` (or an options object) adds a channel named `broadcast`.
 *   Without a `publisher` it publishes through the `jsails/broadcast` service,
 *   an optional service looked up at delivery time: the broadcast plugin may be
 *   declared in any order, and its absence fails the delivery
 *   (`missing_broadcast`) rather than assembly.
 *
 * A configured channel named `mail`, `database`, or `broadcast` alongside the
 * matching option is a conflict. Options that add no channel at all, none
 * given included, are refused with `config.invalid_options`, so an app that
 * forgot `mail: true` fails at config load instead of losing every message.
 * `notify` with a plain message skips the `database` and `broadcast` channels
 * unless they are named, so adding them leaves existing `notify` calls
 * delivering as before; a `notify` that selects no channel rejects
 * (`no_channel`).
 *
 * The plugin is otherwise inert: nothing connects and no delivery happens
 * until `notify` or `send` is called. A channel holds no open handles the
 * plugin owns, so it has no cleanup.
 */

import { mailToken, queueMailThrough } from '@jsails/mail';
import { broadcastToken, jobsToken } from 'jsails/internal';
import {
  boundObject,
  createServiceToken,
  definePlugin,
  fn,
  tokenRef,
  type PluginFactory,
  type PluginServices,
  type ServiceToken,
  type ServiceTokenFamily,
} from 'jsails/kernel';
import { z } from 'jsails/zod';

import {
  BroadcastNotificationChannel,
  type BroadcastNotificationChannelOptions,
  type BroadcastPublisher,
} from './broadcast-channel.js';
import { MailNotificationChannel } from './channels.js';
import {
  NotificationError,
  type Notifiable,
  type NotificationChannel,
  type NotificationsService,
} from './contract.js';
import { DatabaseNotificationChannel } from './database-channel.js';
import { NotificationDispatcher } from './dispatcher.js';
import type { NotificationStore } from './store.js';

/** The reserved channel name the `mail` option installs. */
const MAIL_CHANNEL_NAME = 'mail';

/** The reserved channel name the `database` option installs. */
const DATABASE_CHANNEL_NAME = 'database';

/** The reserved channel name the `broadcast` option installs. */
const BROADCAST_CHANNEL_NAME = 'broadcast';

/**
 * Opaque token for the application {@link NotificationsService}. Defined once
 * here and shared by the provider (`notificationsPlugin`) and any consumer.
 */
export const notificationsToken: ServiceToken<NotificationsService> =
  createServiceToken<NotificationsService>('notifications');

/**
 * The family of {@link NotificationStore} services. A plugin of the app
 * provides the store behind the `database` channel under this token (or a
 * keyed member), and the app names that token in
 * `notificationsPlugin({ database })` and reads records through it.
 */
export const notificationStoreToken: ServiceTokenFamily<NotificationStore> =
  createServiceToken<NotificationStore>('notifications.store');

/** The `broadcast` option's object form: the channel's options, publisher optional. */
export interface NotificationsBroadcastOptions {
  /** Resolve the publisher at delivery time instead of the application's `jsails/broadcast` service. */
  readonly publisher?: () => BroadcastPublisher | Promise<BroadcastPublisher>;
  /** The channel for a notifiable that names none. Defaults to `notifications.<id>`. */
  readonly channelFor?: (notifiable: Notifiable) => string;
  /** The event name. Defaults to `notification`. */
  readonly event?: string;
}

/** Options accepted by {@link notificationsPlugin}. */
export interface NotificationsPluginOptions {
  /** Named channels, keyed by non-empty names. */
  readonly channels?: Readonly<Record<string, NotificationChannel>>;
  /**
   * Add a `mail` channel adapting the first-party mail service: `true` sends
   * inline, `'queue'` dispatches each message as the mail plugin's `mail.send`
   * job (which needs the jobs plugin and a worker running `mailSendJob`).
   */
  readonly mail?: boolean | 'queue';
  /** Add a `database` channel writing to the store another plugin provides under this token. */
  readonly database?: ServiceToken<NotificationStore>;
  /** Add a `broadcast` channel; `true` publishes through `jsails/broadcast`. */
  readonly broadcast?: true | NotificationsBroadcastOptions;
  /**
   * Milliseconds one channel may take before it counts as failed. Defaults to
   * 30 000, so a hung mail server cannot hold a request indefinitely.
   */
  readonly channelTimeoutMs?: number;
  /**
   * Attempts one channel runs at the same time. Defaults to 10, so a batch
   * send never floods the SMTP or database connection pool.
   */
  readonly concurrency?: number;
}

const channel = boundObject({
  send: fn<NotificationChannel['send']>(),
  deliver: fn<NonNullable<NotificationChannel['deliver']>>().optional(),
});

const nonBlank = z.string().refine((value) => value.trim() !== '', {
  message: 'must not be blank',
});

const broadcastOptions = z
  .object({
    publisher: fn<NonNullable<NotificationsBroadcastOptions['publisher']>>().optional(),
    channelFor: fn<NonNullable<NotificationsBroadcastOptions['channelFor']>>().optional(),
    event: nonBlank.optional(),
  })
  .strict();

const notificationsOptions = z
  .object({
    channels: z.record(nonBlank, channel).optional(),
    mail: z.union([z.boolean(), z.literal('queue')]).optional(),
    database: tokenRef(notificationStoreToken).optional(),
    broadcast: z.union([z.literal(true), broadcastOptions]).optional(),
    channelTimeoutMs: z.int().positive().optional(),
    concurrency: z.int().positive().optional(),
  })
  .strict()
  .superRefine((options, context) => {
    const installs =
      options.mail === true ||
      options.mail === 'queue' ||
      options.database !== undefined ||
      options.broadcast !== undefined ||
      Object.keys(options.channels ?? {}).length > 0;
    if (!installs) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'must add at least one channel: channels, mail, database or broadcast',
      });
    }
    const reserved: readonly [string, boolean][] = [
      [MAIL_CHANNEL_NAME, options.mail === true || options.mail === 'queue'],
      [DATABASE_CHANNEL_NAME, options.database !== undefined],
      [BROADCAST_CHANNEL_NAME, options.broadcast !== undefined],
    ];
    for (const [name, installed] of reserved) {
      if (installed && Object.hasOwn(options.channels ?? {}, name)) {
        context.addIssue({
          code: 'custom',
          path: ['channels', name],
          message: 'is reserved by the option of the same name',
        });
      }
    }
  }) as unknown as z.ZodType<NotificationsPluginOptions>;

/**
 * The `notifications` plugin. Setup builds the channels its options name and
 * provides the dispatcher over them; nothing is delivered until `notify`.
 */
export const notificationsPlugin: PluginFactory<NotificationsPluginOptions> = definePlugin({
  name: 'notifications',
  options: notificationsOptions,
  requires: (options) => [
    options.mail === true || options.mail === 'queue' ? mailToken : undefined,
    options.database,
  ],
  optional: [jobsToken, broadcastToken],
  provides: [notificationsToken],
  setup({ options, services }) {
    const channels: Record<string, NotificationChannel> = { ...options.channels };
    const mailMode = options.mail === true || options.mail === 'queue' ? options.mail : undefined;
    const optIn: string[] = [];
    if (options.database !== undefined) {
      channels[DATABASE_CHANNEL_NAME] = new DatabaseNotificationChannel({
        store: services.get(options.database),
      });
      optIn.push(DATABASE_CHANNEL_NAME);
    }
    if (options.broadcast !== undefined) {
      const broadcast: Omit<BroadcastNotificationChannelOptions, 'publisher'> & {
        readonly publisher?: NotificationsBroadcastOptions['publisher'];
      } = options.broadcast === true ? {} : options.broadcast;
      channels[BROADCAST_CHANNEL_NAME] = new BroadcastNotificationChannel({
        ...broadcast,
        publisher: broadcast.publisher ?? (() => applicationPublisher(services)),
      });
      optIn.push(BROADCAST_CHANNEL_NAME);
    }
    if (mailMode !== undefined) {
      channels[MAIL_CHANNEL_NAME] = new MailNotificationChannel({
        // The mailer (or the jobs service) is resolved at send time, so the
        // mail transport and any connection stay deferred until a message
        // is actually delivered.
        mailer: {
          send(message) {
            return mailMode === 'queue'
              ? queueMailThrough(services, message)
              : services.get(mailToken).send(message);
          },
        },
      });
    }

    services.provide(
      notificationsToken,
      new NotificationDispatcher(channels, {
        channelTimeoutMs: options.channelTimeoutMs,
        concurrency: options.concurrency,
        // A plain `notify` message reaches the inbox and realtime channels
        // only when named: those are addressed by notifiable id, not by `to`.
        optInChannels: optIn,
      }),
    );
  },
});

/** The application's `jsails/broadcast` service, read at delivery time. */
function applicationPublisher(services: PluginServices): BroadcastPublisher {
  const service = services.tryGet(broadcastToken);
  if (service === undefined) {
    throw new NotificationError(
      'missing_broadcast',
      'the broadcast channel needs the broadcast plugin, or a publisher option',
    );
  }
  return service;
}
