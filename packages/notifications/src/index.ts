/**
 * The `@jsails/notifications` package: a narrow, multi-channel delivery seam.
 *
 * It exports the {@link NotificationMessage} and {@link NotificationChannel}
 * contracts, the value-free {@link NotificationError}, an in-memory channel for
 * tests and demos, a mail adapter over the `@jsails/mail` `Mailer`, the
 * {@link NotificationDispatcher} that fans a message out to named channels, and
 * the {@link notificationsPlugin} that exposes a {@link NotificationsService}
 * under a typed service token.
 *
 * Importing this barrel depends on the mail surface only through the
 * `mailToken` identity (plus the `Mailer` type) and never opens a connection,
 * enqueues work, or touches a database — nodemailer stays a lazy `await import`
 * inside the mail transports. Delivery is in-process and synchronous per send;
 * an application needing retries or out-of-process delivery should enqueue
 * through the jobs plugin and send from the job handler.
 */

export {
  NotificationError,
  type NotificationChannel,
  type NotificationErrorCode,
  type NotificationMessage,
  type NotificationsService,
  type NotifyOptions,
} from './contract.js';

export {
  InMemoryNotificationChannel,
  MailNotificationChannel,
  type MailNotificationChannelOptions,
  type MemoryNotificationChannel,
} from './channels.js';

export { NotificationDispatcher } from './dispatcher.js';

export {
  notificationsPlugin,
  notificationsToken,
  type NotificationsPluginOptions,
} from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every first-party
// subpath barrel must default-export its factory alongside the named export.
export { notificationsPlugin as default } from './plugin.js';
