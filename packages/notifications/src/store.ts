/**
 * The notification store contract behind the `database` channel, and an
 * in-memory implementation for tests and demos.
 *
 * A store keeps one record per delivered notification, scoped by notifiable
 * key: every read and every read/unread change takes the notifiable, so a
 * caller holding one user's key can never list or mark another user's rows by
 * guessing an id. Records are returned newest first. The database-backed store
 * lives in `database-store.ts`.
 */

import { deepCloneJson, type JsonObject } from 'jsails/plugin-sdk';
import { NotificationError } from './contract.js';

/** One stored notification. */
export interface NotificationRecord {
  readonly id: number;
  /** The notifiable's key. */
  readonly notifiable: string;
  /** The notification's name. */
  readonly type: string;
  readonly data: JsonObject;
  /** When it was read, or `null` while unread. */
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** A new record, as the `database` channel writes it. */
export interface NewNotificationRecord {
  readonly notifiable: string;
  readonly type: string;
  readonly data: JsonObject;
}

/** Options for {@link NotificationStore.list}. */
export interface ListNotificationsOptions {
  /** Only unread records. Defaults to `false`. */
  readonly unread?: boolean;
  /** At most this many records, 1-500. Defaults to 50. */
  readonly limit?: number;
}

/** Where database notifications are kept. */
export interface NotificationStore {
  /** Store a new, unread record. */
  create(record: NewNotificationRecord): Promise<NotificationRecord>;
  /** The notifiable's records, newest first. */
  list(notifiable: string, options?: ListNotificationsOptions): Promise<NotificationRecord[]>;
  /** How many of the notifiable's records are unread. */
  unreadCount(notifiable: string): Promise<number>;
  /** Mark one of the notifiable's records read; `false` when it has no such record. */
  markRead(notifiable: string, id: number): Promise<boolean>;
  /** Mark one of the notifiable's records unread; `false` when it has no such record. */
  markUnread(notifiable: string, id: number): Promise<boolean>;
  /** Mark every unread record of the notifiable read; resolves to how many changed. */
  markAllRead(notifiable: string): Promise<number>;
  /** Delete one of the notifiable's records; `false` when it has no such record. */
  delete(notifiable: string, id: number): Promise<boolean>;
}

/** The page {@link NotificationStore.list} returns by default. */
export const DEFAULT_NOTIFICATION_LIMIT = 50;

/** The largest page {@link NotificationStore.list} returns. */
export const MAX_NOTIFICATION_LIMIT = 500;

/** The largest JSON payload one record may hold, in bytes. */
export const MAX_NOTIFICATION_DATA_BYTES = 65_536;

/** Resolve and validate a list limit. */
export function resolveLimit(options: ListNotificationsOptions | undefined): number {
  const limit = options?.limit ?? DEFAULT_NOTIFICATION_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_NOTIFICATION_LIMIT) {
    throw new NotificationError(
      'invalid_payload',
      `the notification list limit must be an integer from 1 to ${MAX_NOTIFICATION_LIMIT}`,
    );
  }
  return limit;
}

/**
 * Validate a database payload: a plain JSON object of at most
 * {@link MAX_NOTIFICATION_DATA_BYTES} bytes. Returns a detached copy.
 */
export function validateNotificationData(data: unknown): JsonObject {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new NotificationError('invalid_payload', 'a database notification must be a JSON object');
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(data);
  } catch {
    throw new NotificationError('invalid_payload', 'a database notification must be JSON');
  }
  if (Buffer.byteLength(encoded) > MAX_NOTIFICATION_DATA_BYTES) {
    throw new NotificationError(
      'too_large',
      `a database notification must encode to at most ${MAX_NOTIFICATION_DATA_BYTES} bytes`,
    );
  }
  return JSON.parse(encoded) as JsonObject;
}

/** Options for {@link InMemoryNotificationStore}. */
export interface InMemoryNotificationStoreOptions {
  /** Clock stamping `createdAt` and `readAt`. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** A {@link NotificationStore} kept in process memory; for tests and demos. */
export class InMemoryNotificationStore implements NotificationStore {
  readonly #records: NotificationRecord[] = [];
  readonly #now: () => Date;
  #nextId = 1;

  constructor(options: InMemoryNotificationStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async create(record: NewNotificationRecord): Promise<NotificationRecord> {
    const stored: NotificationRecord = {
      id: this.#nextId++,
      notifiable: record.notifiable,
      type: record.type,
      data: validateNotificationData(record.data),
      readAt: null,
      createdAt: this.#now(),
    };
    this.#records.push(stored);
    return copy(stored);
  }

  async list(
    notifiable: string,
    options?: ListNotificationsOptions,
  ): Promise<NotificationRecord[]> {
    const limit = resolveLimit(options);
    return this.#records
      .filter(
        (record) =>
          record.notifiable === notifiable && (options?.unread !== true || record.readAt === null),
      )
      .reverse()
      .slice(0, limit)
      .map(copy);
  }

  async unreadCount(notifiable: string): Promise<number> {
    return this.#records.filter(
      (record) => record.notifiable === notifiable && record.readAt === null,
    ).length;
  }

  async markRead(notifiable: string, id: number): Promise<boolean> {
    return this.#update(notifiable, id, (record) => record.readAt ?? this.#now());
  }

  async markUnread(notifiable: string, id: number): Promise<boolean> {
    return this.#update(notifiable, id, () => null);
  }

  async markAllRead(notifiable: string): Promise<number> {
    let changed = 0;
    const now = this.#now();
    this.#records.forEach((record, index) => {
      if (record.notifiable === notifiable && record.readAt === null) {
        this.#records[index] = { ...record, readAt: now };
        changed += 1;
      }
    });
    return changed;
  }

  async delete(notifiable: string, id: number): Promise<boolean> {
    const index = this.#indexOf(notifiable, id);
    if (index === -1) {
      return false;
    }
    this.#records.splice(index, 1);
    return true;
  }

  #indexOf(notifiable: string, id: number): number {
    return this.#records.findIndex(
      (record) => record.id === id && record.notifiable === notifiable,
    );
  }

  #update(
    notifiable: string,
    id: number,
    readAt: (record: NotificationRecord) => Date | null,
  ): boolean {
    const index = this.#indexOf(notifiable, id);
    const record = this.#records[index];
    if (record === undefined) {
      return false;
    }
    this.#records[index] = { ...record, readAt: readAt(record) };
    return true;
  }
}

/** A detached copy, so a caller cannot mutate the store through a returned record. */
function copy(record: NotificationRecord): NotificationRecord {
  return {
    ...record,
    data: deepCloneJson(record.data),
    readAt: record.readAt === null ? null : new Date(record.readAt),
    createdAt: new Date(record.createdAt),
  };
}

/** Whether `value` has the {@link NotificationStore} surface. */
export function isNotificationStore(value: unknown): value is NotificationStore {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const store = value as Record<string, unknown>;
  return ['create', 'list', 'unreadCount', 'markRead', 'markUnread', 'markAllRead', 'delete'].every(
    (method) => typeof store[method] === 'function',
  );
}
