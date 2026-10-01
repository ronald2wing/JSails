/**
 * Attachments (`hasOneAttached`): a named file per record, kept as one row of
 * the framework table `attachmentTable` (`attachment-table.ts`) pointing at a
 * blob on the data source's attachment disk.
 *
 * ```ts
 * defineModel(User, { table: 'users', columns, attachments: { avatar: { kind: 'one' } } });
 * // new JsailsDataSource({
 * //   config,
 * //   models: [User, attachmentTable],
 * //   attachments: { disk, onCleanupError: (error) => log.warn(error) },
 * // });
 * const written = await disk.write(key, bytes, { maxBytes, contentType });
 * user.avatar = { key, contentType, byteSize: written.size };
 * await user.save();
 * const avatar = await attachmentOf(user, 'avatar');
 * ```
 *
 * Bytes are written to the disk first (a stream cannot be held inside a
 * transaction) and the record then names the blob: an `AttachmentBlob`, or
 * `null` to detach. Saving the record writes the attachment row in the
 * save's transaction, replacing the previous row rather than adding one.
 * Destroying the record deletes its attachment rows in the transaction.
 * Changing the record's primary key through `save()` moves its rows to the
 * new key. A loaded record does not hold its attachments; `attachmentOf`
 * reads one.
 *
 * A blob is deleted from the disk only once nothing names it:
 *
 * - The blob a save replaced, and the blobs of a destroyed record, once the
 *   transaction commits, when no attachment row names the key (two records
 *   may name one blob, and a save may name the blob already stored).
 * - A blob a rolled-back save named, once the rollback is done, when no
 *   attachment row names the key and the record no longer names it. A
 *   record still holding the blob keeps it pending, so a retry (the
 *   caller's, or `transaction()`'s `retry`) saves it with its bytes; a blob
 *   whose record is then abandoned is the uploader's to delete.
 *
 * The deletion is cleanup: the write's outcome stands whatever it meets. A
 * failure (of the disk, or of the read that checks the key) goes to the
 * data source's `attachments.onCleanupError`, and the blob stays.
 *
 * Attachment writes are effect writes of the pipeline. A set write cannot
 * delete blobs per row, so `deleteAll` on a model with attachments is
 * refused, as is an `updateAll` that assigns its primary key.
 */

import type { Disk } from 'jsails/filesystem';

import {
  decodeColumn,
  encodeColumn,
  type CodecColumn,
  type ModelCodecs,
} from '../codec/model-codecs.js';
import { recordState } from '../codec/hydrate.js';
import { runStatement } from '../query/query-context.js';
import { and, col, deleteFrom, eq, insert, select, table, update } from '../statement/builders.js';
import type { Tx } from '../transaction/run-transaction.js';
import { attachmentTable } from './attachment-table.js';
import type { EffectPlan } from './effects/plan.js';
import type { WriteSession } from './effects/write-session.js';
import { DataSourceErrors, RecordErrors } from './record-errors.js';
import { targetOf } from './record-values.js';

/** The disk attachment blobs live on: only `delete` is called. */
export type AttachmentDisk = Pick<Disk, 'delete'>;

/** The attachment options of a data source. */
export interface AttachmentOptions {
  /** Where the blobs live. */
  readonly disk: AttachmentDisk;
  /**
   * Receives what deleting a blob no row names any more failed with, after
   * the write settled; the blob stays on the disk. It never changes the
   * write's outcome.
   */
  readonly onCleanupError: (error: unknown) => void;
}

/** A blob already on the attachment disk, as a record names it. */
export interface AttachmentBlob {
  /** The disk key. */
  readonly key: string;
  readonly contentType: string;
  /** The blob's size in bytes. */
  readonly byteSize: number;
  readonly filename?: string;
  /** The blob's SHA-256, hex. */
  readonly checksum?: string;
}

/** An attachment as stored. */
export interface StoredAttachment extends AttachmentBlob {
  readonly createdAt: Date;
}

/** The attachment values each record last saved, by name. */
const SAVED = new WeakMap<object, Map<string, unknown>>();

const BLOB_KEYS: ReadonlySet<string> = new Set([
  'key',
  'contentType',
  'byteSize',
  'filename',
  'checksum',
]);

function isBlob(value: unknown): value is AttachmentBlob {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const blob = value as Readonly<Record<string, unknown>>;
  return (
    Object.keys(blob).every((key) => BLOB_KEYS.has(key)) &&
    typeof blob.key === 'string' &&
    blob.key !== '' &&
    blob.key.length <= 255 &&
    typeof blob.contentType === 'string' &&
    blob.contentType.length <= 127 &&
    Number.isSafeInteger(blob.byteSize) &&
    (blob.byteSize as number) >= 0 &&
    (blob.filename === undefined ||
      (typeof blob.filename === 'string' && blob.filename.length <= 255)) &&
    (blob.checksum === undefined ||
      (typeof blob.checksum === 'string' && blob.checksum.length <= 64))
  );
}

/** The attachments of `record` set since it was last saved: name and blob, or `null` to detach. */
export function pendingAttachments(
  plan: EffectPlan,
  record: object,
): readonly (readonly [string, AttachmentBlob | null])[] {
  if (plan.attachments.length === 0) return [];
  const saved = SAVED.get(record);
  const pending: [string, AttachmentBlob | null][] = [];
  for (const name of plan.attachments) {
    if (!Object.hasOwn(record, name)) continue;
    const value: unknown = (record as Record<string, unknown>)[name];
    if (value === undefined || (saved !== undefined && saved.get(name) === value)) continue;
    if (value !== null && !isBlob(value)) {
      throw new RecordErrors.Error('invalid_attachment', {
        model: plan.codecs.spec.name,
        attachment: name,
      });
    }
    pending.push([name, value]);
  }
  return pending;
}

function attachmentCodecs(session: WriteSession): ModelCodecs {
  return session.context.catalog.codecs(attachmentTable);
}

function columnOf(codecs: ModelCodecs, property: string): CodecColumn {
  return codecs.property(property) as CodecColumn;
}

function options(session: WriteSession): AttachmentOptions {
  const attached = session.internals.attachments;
  // The data source refuses models with attachments and no disk when it is
  // constructed, so this guards a catalog built some other way.
  if (attached === undefined) {
    throw new DataSourceErrors.Error('invalid_options', { field: 'attachments' });
  }
  return attached;
}

/** The condition naming one record's attachment rows, or one of them. */
function rowsOf(codecs: ModelCodecs, plan: EffectPlan, key: unknown, name?: string) {
  const ref = (property: string) => col(codecs.spec.table, columnOf(codecs, property).column);
  const value = (property: string, raw: unknown) => encodeColumn(columnOf(codecs, property), raw);
  const terms = [
    eq(ref('recordType'), value('recordType', plan.codecs.spec.name)),
    eq(ref('recordId'), value('recordId', String(key))),
  ];
  if (name !== undefined) terms.push(eq(ref('name'), value('name', name)));
  return and(...terms);
}

function keysOf(codecs: ModelCodecs, rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  const column = columnOf(codecs, 'key');
  return rows.map((row) => decodeColumn(column, row[column.column] as never) as string);
}

/** Remember `blob` as `record`'s saved attachment `name`, forgotten again if the write rolls back. */
function remember(
  session: WriteSession,
  record: object,
  name: string,
  blob: AttachmentBlob | null,
): void {
  let saved = SAVED.get(record);
  if (saved === undefined) {
    saved = new Map();
    SAVED.set(record, saved);
  }
  const had = saved.has(name);
  const previous = saved.get(name);
  saved.set(name, blob);
  const memory = saved;
  session.onRollback(() => {
    if (memory.get(name) !== blob) return;
    if (had) memory.set(name, previous);
    else memory.delete(name);
  });
}

/** Hand a cleanup failure to the data source's reporter. */
function reportCleanup(attached: AttachmentOptions, error: unknown): void {
  try {
    attached.onCleanupError(error);
  } catch {
    // The reporter is the application's own; one that throws has nowhere
    // further to go, and the write it reports on has settled.
  }
}

/**
 * Delete the blob `key` when no attachment row names it, where the ended
 * frame's callbacks run (the enclosing open transaction, or autocommit).
 * Never throws: a failure goes to the reporter and the blob stays.
 */
async function releaseBlob(session: WriteSession, key: string): Promise<void> {
  const attached = options(session);
  try {
    const codecs = attachmentCodecs(session);
    const keyColumn = columnOf(codecs, 'key');
    const named = await session.run(
      select(table(codecs.spec.table), {
        columns: [{ column: col(codecs.spec.table, keyColumn.column), as: keyColumn.column }],
        where: eq(col(codecs.spec.table, keyColumn.column), encodeColumn(keyColumn, key)),
        limit: 1,
      }),
    );
    if (named.rows.length === 0) await attached.disk.delete(key);
  } catch (error) {
    reportCleanup(attached, error);
  }
}

/** Release the blob `key` once `tx` commits. */
function releaseAfterCommit(session: WriteSession, tx: Tx, key: string): void {
  tx.afterCommit(() => releaseBlob(session, key));
}

/** Whether `record` still holds a blob of `key` as its attachment `name`. */
function holdsBlob(record: object, name: string, key: string): boolean {
  if (!Object.hasOwn(record, name)) return false;
  const value: unknown = (record as Record<string, unknown>)[name];
  return value !== null && typeof value === 'object' && (value as { key?: unknown }).key === key;
}

/**
 * Release the blob `key`, which `record`'s attachment `name` was saved with,
 * once the save is rolled back, unless the record still holds it. The
 * frame's undos run before its afterRollback callbacks, so the record is
 * back as it was by then.
 */
function releaseAfterRollback(
  session: WriteSession,
  tx: Tx,
  record: object,
  name: string,
  key: string,
): void {
  tx.afterRollback(async () => {
    if (!holdsBlob(record, name, key)) await releaseBlob(session, key);
  });
}

/**
 * Write the pending attachments of the record whose primary key is `key`
 * inside `tx`, and remember them as saved; the blobs no row names any more
 * are released after the transaction ends (see the module header).
 */
export async function writeAttachments(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  key: unknown,
  pending: readonly (readonly [string, AttachmentBlob | null])[],
  tx: Tx,
): Promise<void> {
  if (pending.length === 0) return;
  const codecs = attachmentCodecs(session);
  const attachments = codecs.spec.table;
  const encode = (property: string, value: unknown) =>
    encodeColumn(columnOf(codecs, property), value);
  for (const [name, blob] of pending) {
    if (blob !== null) releaseAfterRollback(session, tx, record, name, blob.key);
    const where = rowsOf(codecs, plan, key, name);
    const current = await session.run(
      select(table(attachments), {
        columns: [
          {
            column: col(attachments, columnOf(codecs, 'key').column),
            as: columnOf(codecs, 'key').column,
          },
        ],
        where,
        lock: { mode: 'update' },
      }),
    );
    const [previous] = keysOf(codecs, current.rows);
    if (blob === null) {
      if (previous !== undefined) await session.run(deleteFrom(attachments, where));
    } else {
      const values: readonly (readonly [string, unknown])[] = [
        ['key', blob.key],
        ['filename', blob.filename ?? null],
        ['contentType', blob.contentType],
        ['byteSize', BigInt(blob.byteSize)],
        ['checksum', blob.checksum ?? null],
      ];
      if (previous === undefined) {
        const all: readonly (readonly [string, unknown])[] = [
          ['recordType', plan.codecs.spec.name],
          ['recordId', String(key)],
          ['name', name],
          ...values,
        ];
        await session.run(
          insert(
            attachments,
            all.map(([property]) => columnOf(codecs, property).column),
            [all.map(([property, value]) => encode(property, value))],
          ),
        );
      } else {
        await session.run(
          update(
            attachments,
            values.map(([property, value]) => ({
              column: columnOf(codecs, property).column,
              value: encode(property, value),
            })),
            where,
          ),
        );
      }
    }
    if (previous !== undefined && previous !== blob?.key) releaseAfterCommit(session, tx, previous);
    remember(session, record, name, blob);
  }
  session.record(codecs, 'invalidate');
}

/**
 * Move the attachment rows of the record whose primary key changed from
 * `from` to `to`, inside the save's transaction.
 */
export async function moveAttachments(
  session: WriteSession,
  plan: EffectPlan,
  from: unknown,
  to: unknown,
): Promise<void> {
  if (plan.attachments.length === 0) return;
  const codecs = attachmentCodecs(session);
  const recordId = columnOf(codecs, 'recordId');
  const result = await session.run(
    update(
      codecs.spec.table,
      [{ column: recordId.column, value: encodeColumn(recordId, String(to)) }],
      rowsOf(codecs, plan, from),
    ),
  );
  if (result.affected > 0) session.record(codecs, 'invalidate');
}

/** Delete the attachment rows of the record `key` inside `tx`, and release its blobs after commit. */
export async function destroyAttachments(
  session: WriteSession,
  plan: EffectPlan,
  key: unknown,
  tx: Tx,
): Promise<void> {
  if (plan.attachments.length === 0) return;
  const codecs = attachmentCodecs(session);
  const attachments = codecs.spec.table;
  const where = rowsOf(codecs, plan, key);
  const keyColumn = columnOf(codecs, 'key').column;
  const current = await session.run(
    select(table(attachments), {
      columns: [{ column: col(attachments, keyColumn), as: keyColumn }],
      where,
      lock: { mode: 'update' },
    }),
  );
  if (current.rows.length === 0) return;
  await session.run(deleteFrom(attachments, where));
  for (const blob of keysOf(codecs, current.rows)) releaseAfterCommit(session, tx, blob);
  session.record(codecs, 'invalidate');
}

/**
 * The attachment `name` of a saved `record`, or `null`.
 *
 * @throws `record.not_persisted`, `record.unknown_attachment` for a name the
 *   model does not declare.
 */
export async function attachmentOf(record: object, name: string): Promise<StoredAttachment | null> {
  const { context, codecs: owner } = targetOf(record);
  if (!Object.hasOwn(owner.spec.attachments, name)) {
    throw new RecordErrors.Error('unknown_attachment', { model: owner.spec.name });
  }
  const state = recordState(record);
  if (state === undefined || !state.persisted) {
    throw new RecordErrors.Error('not_persisted', {
      model: owner.spec.name,
      operation: 'reloaded',
    });
  }
  const codecs = context.catalog.codecs(attachmentTable);
  const keyProperty = owner.spec.primaryKey[0] as string;
  const ref = (property: string) => col(codecs.spec.table, columnOf(codecs, property).column);
  const value = (property: string, raw: unknown) => encodeColumn(columnOf(codecs, property), raw);
  const result = await runStatement(
    context,
    select(table(codecs.spec.table), {
      columns: codecs.columns.map((entry) => ({
        column: col(codecs.spec.table, entry.column),
        as: entry.column,
      })),
      where: and(
        eq(ref('recordType'), value('recordType', owner.spec.name)),
        eq(ref('recordId'), value('recordId', String(state.baseline[keyProperty]))),
        eq(ref('name'), value('name', name)),
      ),
      limit: 1,
    }),
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const read = (property: string): unknown => {
    const entry = columnOf(codecs, property);
    return decodeColumn(entry, row[entry.column]);
  };
  const filename = read('filename');
  const checksum = read('checksum');
  return Object.freeze({
    key: read('key') as string,
    contentType: read('contentType') as string,
    byteSize: Number(read('byteSize') as bigint),
    ...(filename === null ? {} : { filename: filename as string }),
    ...(checksum === null ? {} : { checksum: checksum as string }),
    createdAt: read('createdAt') as Date,
  });
}
