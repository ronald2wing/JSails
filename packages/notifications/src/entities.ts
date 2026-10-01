/**
 * The framework-owned entity for database notifications: one row per
 * notification delivered to one notifiable through the `database` channel.
 *
 * The table is created through the declarative schema history (`db:push`),
 * never at runtime: the `notifications` plugin's static schema declares it
 * when a `database` store is configured, and an app that builds its own data
 * source adds {@link notificationEntities} to its entity list. `createdAt` is
 * set from application code; `readAt` is `null` until the row is read.
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'jsails/models';
import type { JsonObject } from 'jsails/plugin-sdk';
import { NOTIFIABLE_KEY_LENGTH } from './contract.js';

/** Table JSails reserves for database notifications. */
export const NOTIFICATIONS_TABLE = 'jsails_notifications';

/** Column width of a notification type; matches the name limit in `defineNotification`. */
export const NOTIFICATION_TYPE_LENGTH = 120;

@Entity(NOTIFICATIONS_TABLE)
export class JsailsNotification extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  /** The notifiable's key (`String(id)`). */
  @Column({ type: 'varchar', length: NOTIFIABLE_KEY_LENGTH, nullable: false })
  notifiable!: string;

  /** The notification's name. */
  @Column({ type: 'varchar', length: NOTIFICATION_TYPE_LENGTH, nullable: false })
  type!: string;

  /** The payload the notification built for the database channel. */
  @Column({ type: 'json', nullable: false })
  data!: JsonObject;

  @Column({ type: 'datetime', nullable: true })
  readAt!: Date | null;

  @Column({ type: 'datetime', nullable: false })
  createdAt!: Date;
}

/** The entities an app adds to its `JsailsDataSource` to store notifications in the database. */
export const notificationEntities: readonly [typeof JsailsNotification] = Object.freeze([
  JsailsNotification,
] as const);
