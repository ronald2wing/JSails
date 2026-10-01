/**
 * Database-backed {@link NotificationStore} over the framework-owned
 * `jsails_notifications` table, through the injected TypeORM data source's
 * repository: no raw SQL and no runtime DDL.
 *
 * The data source may be passed initialized, or as a `getDataSource` thunk
 * that the store initializes on first use, so an app config can build the
 * store without connecting. A missing table fails with a value-free
 * `missing_table` telling the caller to run `db:push`. Every query is scoped by
 * the notifiable key, so an id from one notifiable never reaches another's row.
 */

import { createOwnedTables, type OwnedTablesOptions } from 'jsails/plugin-sdk';
import { NotificationError } from '../contract.js';
import { JsailsNotification, NOTIFICATIONS_TABLE } from './entities.js';
import {
  resolveLimit,
  validateNotificationData,
  type NotificationRecord,
  type NotificationStore,
} from '../store.js';

/**
 * The TypeORM data source the store reads and writes through.
 *
 * @public
 */
export type NotificationDataSource = Exclude<OwnedTablesOptions['dataSource'], () => unknown>;

/**
 * Options for {@link createDatabaseNotificationStore}; give one of the two sources.
 *
 * @public
 */
export interface DatabaseNotificationStoreOptions {
  /** An initialized data source. */
  readonly dataSource?: NotificationDataSource;
  /** A thunk returning the data source; it is initialized on first use. */
  readonly getDataSource?: () => NotificationDataSource;
  /** Clock stamping `createdAt` and `readAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Create a database-backed notification store.
 *
 * @public
 */
export function createDatabaseNotificationStore(
  options: DatabaseNotificationStoreOptions,
): NotificationStore {
  const raw: unknown = options;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('createDatabaseNotificationStore requires an options object');
  }
  const { dataSource, getDataSource } = options;
  if ((dataSource === undefined) === (getDataSource === undefined)) {
    throw new TypeError('give exactly one of dataSource or getDataSource');
  }
  if (getDataSource !== undefined && typeof getDataSource !== 'function') {
    throw new TypeError('getDataSource must be a function');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }
  const now = options.now ?? (() => new Date());
  const tables = createOwnedTables({
    dataSource: getDataSource ?? (dataSource as NotificationDataSource),
    tables: [NOTIFICATIONS_TABLE],
    initialize: getDataSource !== undefined,
    makeError: (failure) =>
      failure === 'not_initialized'
        ? new NotificationError(
            'not_initialized',
            'the notifications data source must be initialized',
          )
        : new NotificationError(
            'missing_table',
            'the jsails_notifications table does not exist; run db:push to create it',
          ),
  });

  async function repository() {
    return (await tables.open()).getRepository(JsailsNotification);
  }

  return {
    async create(record) {
      const data = validateNotificationData(record.data);
      const repo = await repository();
      const saved = await repo.save(
        repo.create({
          notifiable: record.notifiable,
          type: record.type,
          data,
          readAt: null,
          createdAt: now(),
        }),
      );
      return toRecord(saved);
    },

    async list(notifiable, listOptions) {
      const limit = resolveLimit(listOptions);
      const repo = await repository();
      const query = repo
        .createQueryBuilder('notification')
        .where('notification.notifiable = :notifiable', { notifiable })
        .orderBy('notification.id', 'DESC')
        .take(limit);
      if (listOptions?.unread === true) {
        query.andWhere('notification.readAt IS NULL');
      }
      return (await query.getMany()).map(toRecord);
    },

    async unreadCount(notifiable) {
      const repo = await repository();
      return repo
        .createQueryBuilder('notification')
        .where('notification.notifiable = :notifiable', { notifiable })
        .andWhere('notification.readAt IS NULL')
        .getCount();
    },

    async markRead(notifiable, id) {
      const repo = await repository();
      const row = await repo.findOneBy({ id: assertId(id), notifiable });
      if (row === null) {
        return false;
      }
      if (row.readAt === null) {
        row.readAt = now();
        await repo.save(row);
      }
      return true;
    },

    async markUnread(notifiable, id) {
      const repo = await repository();
      const row = await repo.findOneBy({ id: assertId(id), notifiable });
      if (row === null) {
        return false;
      }
      if (row.readAt !== null) {
        row.readAt = null;
        await repo.save(row);
      }
      return true;
    },

    async markAllRead(notifiable) {
      const repo = await repository();
      // One scoped UPDATE, so a large unread backlog is never loaded into
      // memory. An UPDATE has no alias to resolve property names through, so
      // the columns come from the entity metadata (correct under any naming
      // strategy) and are escaped by the driver.
      const query = repo.createQueryBuilder().update().set({ readAt: now() });
      const notifiableColumn = query.escape(columnName(repo.metadata, 'notifiable'));
      const readAtColumn = query.escape(columnName(repo.metadata, 'readAt'));
      const result = await query
        .where(`${notifiableColumn} = :notifiable`, { notifiable })
        .andWhere(`${readAtColumn} IS NULL`)
        .execute();
      return result.affected ?? 0;
    },

    async delete(notifiable, id) {
      const repo = await repository();
      const result = await repo.delete({ id: assertId(id), notifiable });
      return (result.affected ?? 0) > 0;
    },
  };
}

/** The database column behind an entity property. */
function columnName(
  metadata: { findColumnWithPropertyName(property: string): { databaseName: string } | undefined },
  property: keyof JsailsNotification,
): string {
  const column = metadata.findColumnWithPropertyName(property);
  if (column === undefined) {
    throw new NotificationError('missing_table', 'the notifications entity is not registered');
  }
  return column.databaseName;
}

/** A record id must be a positive safe integer; anything else matches no row. */
function assertId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new NotificationError('not_found', 'a notification id must be a positive integer');
  }
  return id;
}

/** A plain record detached from the entity instance. */
function toRecord(row: JsailsNotification): NotificationRecord {
  return {
    id: row.id,
    notifiable: row.notifiable,
    type: row.type,
    data: row.data,
    readAt: row.readAt === null ? null : new Date(row.readAt),
    createdAt: new Date(row.createdAt),
  };
}
