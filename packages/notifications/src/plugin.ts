/**
 * The `notifications` plugin: exposes a multi-channel
 * {@link NotificationsService} under a typed service token.
 *
 * `notificationsPlugin({ channels?, mail?, database?, broadcast? })` defines a
 * {@link JsailsPlugin} named `notifications` whose `setup` provides the
 * service under {@link notificationsToken}:
 *
 * - `channels` is a map of named {@link NotificationChannel}s, keyed by
 *   non-empty, unique names and used verbatim (identity preserved, never
 *   closed);
 * - `mail: true` adds a channel named `mail` that adapts the first-party mail
 *   service, and declares `requires: [mailToken]` so the mail plugin must be
 *   declared earlier or assembly fails with a value-free missing-requirement
 *   error. The mailer is resolved from the registry lazily at send time, so no
 *   mail transport or connection is touched at import, construction, or setup.
 *   `mail: 'queue'` is the same channel, but each message is validated and
 *   dispatched as the mail plugin's `mail.send` job instead of sent inline.
 * - `database: store` adds a channel named `database` writing to that
 *   {@link NotificationStore}, provides the store under
 *   {@link notificationStoreToken} so the app can list records and mark them
 *   read, and declares {@link notificationEntities} as the plugin's schema so
 *   `db:push` creates the table.
 * - `broadcast: true` (or an options object) adds a channel named `broadcast`.
 *   Without an explicit `publisher` it publishes through the `jsails/broadcast`
 *   service of the same application, looked up at delivery time: the
 *   broadcast plugin may be declared in any order, and its absence fails the
 *   delivery (`missing_broadcast`) rather than assembly. `jsails/broadcast` is
 *   loaded only then, so an app without realtime never loads Socket.IO.
 *
 * Channel names are validated eagerly at plugin construction; a configured
 * channel named `mail`, `database`, or `broadcast` alongside the matching
 * option is a conflict. Each `setup` builds its own channel map and dispatcher
 * over that application's registry, so one plugin value assembled into two
 * applications (web and worker in one process, or tests reusing a config)
 * never delivers through the other's services. `notify` with a plain message
 * skips the `database` and `broadcast` channels unless they are named, so
 * adding them leaves existing `notify` calls delivering as before.
 *
 * The plugin is otherwise inert: nothing connects and no delivery happens
 * until `notify` or `send` is called. Cleanup is a no-op — a channel holds no
 * open handles the plugin owns.
 */

import { mailToken, queueMailThrough } from '@jsails/mail';
import {
  createServiceToken,
  definePlugin,
  type JsailsPlugin,
  type ServiceRegistry,
  type ServiceToken,
} from 'jsails/extensions';
import { isRecord } from 'jsails/plugin-sdk';
import {
  BroadcastNotificationChannel,
  type BroadcastNotificationChannelOptions,
  type BroadcastPublisher,
} from './broadcast-channel.js';
import { MailNotificationChannel } from './channels.js';
import {
  NotificationError,
  type NotificationChannel,
  type NotificationsService,
} from './contract.js';
import { DatabaseNotificationChannel } from './database-channel.js';
import { NotificationDispatcher } from './dispatcher.js';
import { notificationEntities } from './entities.js';
import { isNotificationStore, type NotificationStore } from './store.js';

/** The reserved channel name the `mail: true` option installs. */
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
 * Opaque token for the {@link NotificationStore} behind the `database`
 * channel; provided only when the plugin is given a `database` store.
 */
export const notificationStoreToken: ServiceToken<NotificationStore> =
  createServiceToken<NotificationStore>('notifications.store');

/** The `broadcast` option's object form: the channel's options, publisher optional. */
export type NotificationsBroadcastOptions = Omit<
  BroadcastNotificationChannelOptions,
  'publisher'
> & {
  /** Publish through this instead of the application's `jsails/broadcast` service. */
  readonly publisher?: BroadcastNotificationChannelOptions['publisher'];
};

/** Options accepted by {@link notificationsPlugin}. */
export interface NotificationsPluginOptions {
  /** Named channels, keyed by non-empty, unique names. */
  readonly channels?: Readonly<Record<string, NotificationChannel>>;
  /**
   * Add a `mail` channel adapting the first-party mail service: `true` sends
   * inline, `'queue'` dispatches each message as the mail plugin's `mail.send`
   * job (which needs the jobs plugin and a worker running `mailSendJob`).
   */
  readonly mail?: boolean | 'queue';
  /** Add a `database` channel writing to this store, and own its table. */
  readonly database?: NotificationStore;
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

/** Whether `value` has the {@link NotificationChannel} surface. */
function isChannel(value: unknown): value is NotificationChannel {
  return isRecord(value) && typeof value.send === 'function';
}

/**
 * Define the `notifications` plugin. Validation is eager and throws
 * `TypeError` for malformed options; the returned plugin is otherwise inert.
 */
export function notificationsPlugin(options: NotificationsPluginOptions = {}): JsailsPlugin {
  const raw: unknown = options;
  if (!isRecord(raw)) {
    throw new TypeError('notificationsPlugin requires an options object');
  }
  if (options.mail !== undefined && typeof options.mail !== 'boolean' && options.mail !== 'queue') {
    throw new TypeError("mail must be a boolean or 'queue'");
  }
  const mailMode = options.mail === true || options.mail === 'queue' ? options.mail : undefined;
  if (
    options.channelTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.channelTimeoutMs) || options.channelTimeoutMs <= 0)
  ) {
    throw new TypeError('channelTimeoutMs must be a positive integer');
  }
  if (
    options.concurrency !== undefined &&
    (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0)
  ) {
    throw new TypeError('concurrency must be a positive integer');
  }
  if (options.channels !== undefined && !isRecord(options.channels)) {
    throw new TypeError('channels must be a map of named channels');
  }
  if (options.database !== undefined && !isNotificationStore(options.database)) {
    throw new TypeError('database must be a notification store');
  }
  if (
    options.broadcast !== undefined &&
    options.broadcast !== true &&
    !isRecord(options.broadcast)
  ) {
    throw new TypeError('broadcast must be true or a broadcast channel options object');
  }

  const custom: Record<string, NotificationChannel> = {};
  for (const [name, channel] of Object.entries(options.channels ?? {})) {
    if (name.trim() === '') {
      throw new TypeError('channel names must be non-empty strings');
    }
    if (!isChannel(channel)) {
      throw new TypeError(`channel "${name}" must implement the NotificationChannel contract`);
    }
    custom[name] = channel;
  }
  const reserve = (name: string, option: string): void => {
    if (name in custom) {
      throw new TypeError(`channel name "${name}" is reserved when ${option} is set`);
    }
  };
  if (mailMode !== undefined) {
    reserve(MAIL_CHANNEL_NAME, 'mail');
  }
  const store = options.database;
  if (store !== undefined) {
    reserve(DATABASE_CHANNEL_NAME, 'database');
  }
  const broadcastOptions: NotificationsBroadcastOptions | undefined =
    options.broadcast === undefined
      ? undefined
      : Object.freeze(options.broadcast === true ? {} : { ...options.broadcast });
  if (broadcastOptions !== undefined) {
    reserve(BROADCAST_CHANNEL_NAME, 'broadcast');
    // Construct once now so a malformed broadcast option fails at plugin
    // construction, not at setup.
    new BroadcastNotificationChannel({
      ...broadcastOptions,
      publisher: broadcastOptions.publisher ?? (() => applicationPublisher(undefined)),
    });
  }
  if (
    mailMode === undefined &&
    store === undefined &&
    broadcastOptions === undefined &&
    Object.keys(custom).length === 0
  ) {
    throw new TypeError('notificationsPlugin requires at least one channel or mail: true');
  }
  const configured = Object.freeze(custom);
  // A plain `notify` message reaches the plugin's inbox and realtime channels
  // only when named: those are addressed by notifiable id, not by `to`.
  const optInChannels = Object.freeze(
    [
      store === undefined ? undefined : DATABASE_CHANNEL_NAME,
      broadcastOptions === undefined ? undefined : BROADCAST_CHANNEL_NAME,
    ].filter((name) => name !== undefined),
  );

  return definePlugin({
    name: 'notifications',
    requires: mailMode === undefined ? [] : [mailToken],
    ...(store === undefined ? {} : { schema: { entities: notificationEntities } }),
    setup({ services }) {
      // Every setup builds its own channel map over its own registry, so one
      // plugin value assembled into two applications never crosses them.
      const channels: Record<string, NotificationChannel> = { ...configured };
      if (store !== undefined) {
        services.provide(notificationStoreToken, store);
        channels[DATABASE_CHANNEL_NAME] = new DatabaseNotificationChannel({ store });
      }
      if (broadcastOptions !== undefined) {
        channels[BROADCAST_CHANNEL_NAME] = new BroadcastNotificationChannel({
          ...broadcastOptions,
          publisher: broadcastOptions.publisher ?? (() => applicationPublisher(services)),
        });
      }
      if (mailMode !== undefined) {
        channels[MAIL_CHANNEL_NAME] = new MailNotificationChannel({
          // Resolve the mailer (or the jobs service) lazily at send time.
          // `requires` guarantees the mail service is registered before this
          // setup runs, but its transport (and any connection) stays deferred
          // until a message is actually delivered.
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
          optInChannels,
        }),
      );
    },
  });
}

/**
 * The `jsails/broadcast` service of the application, loading that subpath (and
 * Socket.IO) only now, on the first broadcast delivery.
 */
async function applicationPublisher(
  services: ServiceRegistry | undefined,
): Promise<BroadcastPublisher> {
  const { broadcastToken } = await import('jsails/broadcast');
  const service = services?.tryGet(broadcastToken);
  if (service === undefined) {
    throw new NotificationError(
      'missing_broadcast',
      'the broadcast channel needs the broadcast plugin, or a publisher option',
    );
  }
  return service;
}
