/**
 * The database-backed notification store (`@jsails/notifications/database`):
 * the `jsails_notifications` entity and {@link createDatabaseNotificationStore}.
 * A separate subpath, so importing `@jsails/notifications` (the plugin a
 * config lists) loads no TypeORM. An app that keeps an inbox adds
 * `notificationEntities` to its data source, provides the store under
 * `notificationStoreToken` from its own plugin, and names that token in
 * `notificationsPlugin({ database: notificationStoreToken })`.
 */

export {
  JsailsNotification,
  NOTIFICATION_TYPE_LENGTH,
  notificationEntities,
  NOTIFICATIONS_TABLE,
} from './entities.js';
export {
  createDatabaseNotificationStore,
  type DatabaseNotificationStoreOptions,
  type NotificationDataSource,
} from './notification-store.js';
