/**
 * The `@jsails/notifications` package: a narrow, multi-channel delivery seam.
 *
 * It exports the {@link NotificationMessage} and {@link NotificationChannel}
 * contracts, the value-free {@link NotificationError}, defined notifications
 * ({@link defineNotification}), the built-in channels (in-memory, a mail
 * adapter over the `@jsails/mail` `Mailer`, a database channel over a
 * {@link NotificationStore}, and a broadcast channel over a
 * {@link BroadcastPublisher}), the in-memory store, the
 * {@link NotificationDispatcher} that fans a message out to named channels,
 * and the {@link notificationsPlugin} that exposes a
 * {@link NotificationsService} under a typed service token. The
 * `jsails_notifications` entity and its database store are on the
 * `@jsails/notifications/database` subpath.
 *
 * Importing this barrel depends on the mail surface only through the
 * `mailToken` identity (plus the `Mailer` type) and never opens a connection,
 * enqueues work, or touches a database: it loads no TypeORM, Socket.IO or
 * BullMQ (the jobs and broadcast tokens come from `jsails/internal`), and
 * nodemailer stays a lazy `await import` inside the mail transports. Delivery
 * is in-process and synchronous per send; an
 * application needing retries or out-of-process delivery should enqueue
 * through the jobs plugin and send from the job handler.
 */

export {
  MAX_NOTIFIABLES,
  NOTIFIABLE_KEY_LENGTH,
  NotificationError,
  notifiableKey,
  type Notifiable,
  type NotificationChannel,
  type NotificationDefinition,
  type NotificationDelivery,
  type NotificationErrorCode,
  type NotificationMessage,
  type NotificationsService,
  type NotifyOptions,
  type SendNotificationOptions,
} from './contract.js';

export {
  defineNotification,
  type NotificationChannelBuilders,
  type NotificationMailContent,
  type NotificationPayloadBuilder,
  type NotificationTemplate,
} from './define-notification.js';

export {
  DatabaseNotificationChannel,
  PLAIN_MESSAGE_TYPE,
  type DatabaseNotificationChannelOptions,
} from './database-channel.js';

export {
  BroadcastNotificationChannel,
  NOTIFICATION_CHANNEL_PREFIX,
  NOTIFICATION_EVENT,
  type BroadcastNotificationChannelOptions,
  type BroadcastPublisher,
} from './broadcast-channel.js';

export {
  DEFAULT_NOTIFICATION_LIMIT,
  InMemoryNotificationStore,
  isNotificationStore,
  MAX_NOTIFICATION_DATA_BYTES,
  MAX_NOTIFICATION_LIMIT,
  type InMemoryNotificationStoreOptions,
  type ListNotificationsOptions,
  type NewNotificationRecord,
  type NotificationRecord,
  type NotificationStore,
} from './store.js';

export {
  InMemoryNotificationChannel,
  MailNotificationChannel,
  type MailNotificationChannelOptions,
  type MemoryNotificationChannel,
} from './channels.js';

export {
  DEFAULT_CHANNEL_CONCURRENCY,
  DEFAULT_CHANNEL_TIMEOUT_MS,
  NotificationDispatcher,
  type NotificationDispatcherOptions,
} from './dispatcher.js';

export {
  notificationsPlugin,
  notificationStoreToken,
  notificationsToken,
  type NotificationsBroadcastOptions,
  type NotificationsPluginOptions,
} from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { notificationsPlugin as default } from './plugin.js';
