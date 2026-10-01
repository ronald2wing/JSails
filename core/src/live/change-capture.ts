/**
 * Post-commit change capture for the live layer.
 *
 * {@link createChangeCapture} builds a TypeORM event subscriber that turns
 * committed ORM writes into {@link LiveChange} records. The subscriber observes
 * `afterInsert`/`afterUpdate`/`afterRemove` — which fire *inside* the
 * transaction — and `afterTransactionStart`/`afterTransactionCommit`/
 * `afterTransactionRollback`, which delimit the transaction boundary. Because
 * the write hooks predate commit, the subscriber records into a per-transaction
 * buffer and only converts to emitted changes at the outermost commit
 * (docs/design/live.md §5 notes 1-4).
 *
 * The buffer is a stack of frames keyed by the TypeORM `QueryRunner` instance
 * (a `WeakMap`), one frame per transaction depth:
 *
 * - `afterTransactionStart` pushes a frame.
 * - the write hooks append to the top frame.
 * - `afterTransactionCommit` at depth > 0 merges the top frame into its parent;
 *   at depth 0 it flushes the merged frame and emits changes.
 * - `afterTransactionRollback` at depth > 0 drops the top frame; at depth 0 it
 *   drops everything.
 *
 * Savepoint commits are visited before the outer commit, so merging at depth
 * > 0 and flushing only at depth 0 is what keeps a change whose outer
 * transaction later rolls back from ever being emitted (docs/design/live.md §5 note 3).
 *
 * Each frame coalesces its entries per (entity, primary key) as they arrive, so
 * a row written many times in one transaction costs one entry and one re-read:
 * insert+update stays an insert, insert+delete vanishes, update+delete is a
 * delete, and delete+insert (the key re-created) is an update.
 *
 * Flush re-reads the affected rows — the write hooks only carry the operation
 * and identity, never a complete row — in one primary-key `IN` query per entity
 * (chunked), projects them with {@link projectRow}, and hands full
 * {@link LiveChange}s to the `onChange` listener. Deletes skip the re-read and
 * emit `row: null`. Nothing in the flush
 * path throws into the caller's write (docs/design/live.md §5 note 7): re-read errors are
 * reported through the optional `onError` listener and swallowed.
 */

import { EventSubscriber, In } from 'typeorm';
import type {
  BaseEntity,
  EntityManager,
  EntitySubscriberInterface,
  InsertEvent,
  ObjectLiteral,
  RemoveEvent,
  TransactionCommitEvent,
  TransactionRollbackEvent,
  TransactionStartEvent,
  UpdateEvent,
} from 'typeorm';

import type { Awaitable } from '../contracts/awaitable.js';
import type { LiveChange, LiveChangeOperation } from './change-record.js';
import { projectRow } from './projection.js';
import { serializePrimaryKey } from '../database/primary-key.js';

/** A callback receiving one flush's committed changes, in capture order. */
export type LiveChangeListener = (changes: readonly LiveChange[]) => Awaitable<void>;

/** Receives a non-fatal flush error (a re-read failure); the write is unaffected. */
export type LiveErrorListener = (error: unknown) => void;

/** Options for {@link createChangeCapture}. */
export interface ChangeCaptureOptions {
  /** Called after each outermost commit with the batch of committed changes. */
  readonly onChange?: LiveChangeListener;
  /** Optional sink for flush errors that must not reach the write path. */
  readonly onError?: LiveErrorListener;
}

/**
 * A live capture handle: the compiled subscriber class to add to a data
 * source's `subscribers` option, plus `setListener`/`close` to connect then
 * detach the change/error listeners.
 */
export interface ChangeCaptureHandle {
  /** The TypeORM subscriber class for the data source's `subscribers` option. */
  readonly subscriber: new () => EntitySubscriberInterface<ObjectLiteral>;
  /** Attach (or, with `undefined`, detach) the change listener for later flushes. */
  setListener(listener: LiveChangeListener | undefined): void;
  /** Detach both listeners so a closed capture emits nothing and holds nothing. */
  close(): void;
}

/** One transaction depth's captured entries, coalesced by entity and key. */
interface Frame {
  entries: Map<string, ResolvedEntry>;
}

/** Rows re-read per `IN` query, below every supported driver's parameter limit. */
const REREAD_CHUNK_SIZE = 500;

type FrameStack = Frame[];

/** One affected row: its entity class, normalized PK, and the write operation. */
interface ResolvedEntry {
  readonly target: typeof BaseEntity;
  readonly operation: LiveChangeOperation;
  readonly idMap: Record<string, unknown>;
  /** `<entity name>\u0000<serialized key>`, the coalescing key. */
  readonly key: string;
}

/** The per-handle mutable state a capture subscriber closes over. */
interface CaptureState {
  onChange: LiveChangeListener | undefined;
  onError: LiveErrorListener | undefined;
  frames: WeakMap<object, FrameStack>;
}

/**
 * Build a change-capture subscriber.
 *
 * The returned handle carries a freshly compiled, `@EventSubscriber()`-decorated
 * class (mirroring {@link createEntitySubscriber}); add it to a
 * `JsailsDataSource`'s `subscribers` option. Each call closes over its own
 * frame buffer and listeners, so two data sources never share capture state.
 */
export function createChangeCapture(options: ChangeCaptureOptions = {}): ChangeCaptureHandle {
  const state: CaptureState = {
    onChange: options.onChange,
    onError: options.onError,
    frames: new WeakMap(),
  };

  @EventSubscriber()
  class LiveChangeCaptureSubscriber {
    afterTransactionStart(event: TransactionStartEvent): void {
      pushFrame(state, event.queryRunner);
    }

    afterInsert(event: InsertEvent<ObjectLiteral>): void {
      capture(state, event.queryRunner, 'insert', event.metadata.target, event.entity);
    }

    afterUpdate(event: UpdateEvent<ObjectLiteral>): void {
      capture(
        state,
        event.queryRunner,
        'update',
        event.metadata.target,
        event.databaseEntity ?? event.entity,
      );
    }

    afterRemove(event: RemoveEvent<ObjectLiteral>): void {
      // Prefer databaseEntity: for a bare remove() the entity is the id-less
      // caller partial, while databaseEntity is the full row TypeORM loaded
      // before deleting (carries the PK). Mirror afterUpdate's prefer-db order.
      capture(
        state,
        event.queryRunner,
        'delete',
        event.metadata.target,
        event.databaseEntity ?? event.entity,
      );
    }

    afterTransactionCommit(event: TransactionCommitEvent): Promise<void> {
      return commit(state, event);
    }

    afterTransactionRollback(event: TransactionRollbackEvent): void {
      rollback(state, event.queryRunner);
    }
  }

  return {
    subscriber: LiveChangeCaptureSubscriber,
    setListener(listener: LiveChangeListener | undefined): void {
      state.onChange = listener;
    },
    close(): void {
      state.onChange = undefined;
      state.onError = undefined;
      state.frames = new WeakMap();
    },
  };
}

/** Push an empty frame for a newly started transaction. */
function pushFrame(state: CaptureState, queryRunner: object): void {
  // No listener means no capture: skip the per-transaction bookkeeping entirely
  // so the always-wired subscriber stays free for apps that never use live.
  if (state.onChange === undefined) {
    return;
  }
  const stack = state.frames.get(queryRunner) ?? [];
  stack.push({ entries: new Map() });
  state.frames.set(queryRunner, stack);
}

/**
 * Append a write to the runner's top frame. Ignores a write with no frame (a
 * bare query-builder write — docs/design/live.md §5 note 9's blind spot) and a
 * classless `EntitySchema` target (which {@link projectRow} cannot project).
 */
function capture(
  state: CaptureState,
  queryRunner: object,
  operation: LiveChangeOperation,
  target: Function | string,
  entity: unknown,
): void {
  const resolved = resolveEntry(operation, target, entity);
  if (resolved === undefined) {
    return;
  }
  const stack = state.frames.get(queryRunner);
  if (stack === undefined || stack.length === 0) {
    return;
  }
  const top = stack[stack.length - 1];
  if (top === undefined) {
    return;
  }
  coalesce(top.entries, resolved);
}

/**
 * Fold a write into a frame's entries. The net effect of a transaction on one
 * row is what subscribers must see, so successive operations collapse: an
 * entry keeps its first position unless it disappears (insert then delete).
 */
function coalesce(entries: Map<string, ResolvedEntry>, next: ResolvedEntry): void {
  const previous = entries.get(next.key);
  if (previous === undefined) {
    entries.set(next.key, next);
    return;
  }
  const operation = combineOperations(previous.operation, next.operation);
  if (operation === undefined) {
    entries.delete(next.key);
    return;
  }
  entries.set(next.key, { ...next, operation });
}

/** The net operation of `first` followed by `second`, or `undefined` when they cancel. */
function combineOperations(
  first: LiveChangeOperation,
  second: LiveChangeOperation,
): LiveChangeOperation | undefined {
  if (first === 'insert') {
    return second === 'delete' ? undefined : 'insert';
  }
  if (first === 'delete') {
    return second === 'delete' ? 'delete' : 'update';
  }
  return second;
}

/** Derive a capture entry from a write event, or `undefined` when not projectable. */
function resolveEntry(
  operation: LiveChangeOperation,
  target: Function | string,
  entity: unknown,
): ResolvedEntry | undefined {
  if (typeof target !== 'function') {
    return undefined;
  }
  const entityClass = target as typeof BaseEntity;
  // `projectRow` projects through `entityClass.getRepository().metadata`, which
  // only a BaseEntity subclass carries. A plain-class EntitySchema target (a
  // function without the static) cannot be projected, so skip it rather than
  // throw into the write path — the classless-schema escape hatch.
  if (typeof entityClass.getRepository !== 'function') {
    return undefined;
  }
  if (entity === null || typeof entity !== 'object') {
    return undefined;
  }
  const metadata = entityClass.getRepository().metadata;
  const idMap: Record<string, unknown> = {};
  for (const column of metadata.primaryColumns) {
    const value = (entity as Record<string, unknown>)[column.propertyName];
    if (value === undefined) {
      // A partially loaded entity lacking its key cannot be re-read by PK.
      return undefined;
    }
    idMap[column.propertyName] = value;
  }
  return {
    target: entityClass,
    operation,
    idMap,
    key: `${metadata.name}\u0000${normalizeId(idMap)}`,
  };
}

/**
 * Merge the top frame into its parent (a savepoint commit at depth > 0), or,
 * at depth 0, remove the frame and flush its entries. Emits nothing on an empty
 * or missing frame.
 */
async function commit(state: CaptureState, event: TransactionCommitEvent): Promise<void> {
  const stack = state.frames.get(event.queryRunner);
  if (stack === undefined) {
    return;
  }
  if (stack.length > 1) {
    mergeTop(state, event.queryRunner);
    return;
  }
  const frame = stack[0];
  state.frames.delete(event.queryRunner);
  if (frame === undefined || frame.entries.size === 0) {
    return;
  }
  await flush(state, [...frame.entries.values()], event.manager);
}

/** A savepoint (depth > 0) commit merges the top frame into its parent. */
function mergeTop(state: CaptureState, queryRunner: object): void {
  const stack = state.frames.get(queryRunner);
  if (stack === undefined || stack.length < 2) {
    return;
  }
  const top = stack.pop();
  const parent = stack[stack.length - 1];
  if (top === undefined || parent === undefined) {
    return;
  }
  for (const entry of top.entries.values()) {
    coalesce(parent.entries, entry);
  }
}

/** A rollback drops the top frame; at depth 0 it drops the whole stack. */
function rollback(state: CaptureState, queryRunner: object): void {
  const stack = state.frames.get(queryRunner);
  if (stack === undefined || stack.length === 0) {
    return;
  }
  stack.pop();
  if (stack.length === 0) {
    state.frames.delete(queryRunner);
  }
}

/**
 * Re-read the captured rows, project them, and emit the batch. Deletes skip
 * the re-read (the row is gone) and emit `row: null`. A failed re-read is
 * reported through `onError` and its changes are dropped, so a flush can never
 * fail a `save()` that already committed (docs/design/live.md §5 notes 5, 7).
 */
async function flush(
  state: CaptureState,
  entries: readonly ResolvedEntry[],
  manager: EntityManager,
): Promise<void> {
  const listener = state.onChange;
  if (listener === undefined) {
    return;
  }
  const rows = await rereadRows(manager, state, entries);
  const changes: LiveChange[] = [];
  for (const entry of entries) {
    const change = toChange(state, entry, rows);
    if (change !== undefined) {
      changes.push(change);
    }
  }
  if (changes.length === 0) {
    return;
  }
  try {
    await listener(changes);
  } catch (error) {
    // A throwing listener must not fail a write that already committed
    // (docs/design/live.md §5 note 7): report through onError and swallow.
    report(state, error);
  }
}

/** Re-read outcome per entry key: the row, `null` when gone, absent when the read failed. */
type RereadRows = Map<string, ObjectLiteral | null>;

/**
 * Re-read every non-delete entry, batched per entity into chunked primary-key
 * queries instead of one query per row. A row the batch does not return (a
 * key whose database type serializes differently) falls back to a single
 * by-key read, so batching never turns a live row into a phantom `null`.
 */
async function rereadRows(
  manager: EntityManager,
  state: CaptureState,
  entries: readonly ResolvedEntry[],
): Promise<RereadRows> {
  const rows: RereadRows = new Map();
  const byTarget = new Map<typeof BaseEntity, ResolvedEntry[]>();
  for (const entry of entries) {
    if (entry.operation === 'delete') {
      continue;
    }
    const group = byTarget.get(entry.target) ?? [];
    group.push(entry);
    byTarget.set(entry.target, group);
  }
  for (const [target, group] of byTarget) {
    for (let index = 0; index < group.length; index += REREAD_CHUNK_SIZE) {
      const chunk = group.slice(index, index + REREAD_CHUNK_SIZE);
      try {
        await rereadChunk(manager, target, chunk, rows);
      } catch (error) {
        report(state, error);
      }
    }
  }
  return rows;
}

async function rereadChunk(
  manager: EntityManager,
  target: typeof BaseEntity,
  chunk: readonly ResolvedEntry[],
  rows: RereadRows,
): Promise<void> {
  const repository = manager.getRepository(target);
  const metadata = target.getRepository().metadata;
  const primary = metadata.primaryColumns.map((column) => column.propertyName);
  const [single] = primary;
  const found =
    primary.length === 1 && single !== undefined
      ? await repository.findBy({ [single]: In(chunk.map((entry) => entry.idMap[single])) })
      : await repository.findBy(chunk.map((entry) => entry.idMap));
  const byKey = new Map<string, ObjectLiteral>();
  for (const row of found) {
    const idMap: Record<string, unknown> = {};
    for (const name of primary) {
      idMap[name] = (row as unknown as Record<string, unknown>)[name];
    }
    byKey.set(`${metadata.name}\u0000${normalizeId(idMap)}`, row);
  }
  for (const entry of chunk) {
    const row = byKey.get(entry.key) ?? (await repository.findOneBy(entry.idMap));
    rows.set(entry.key, row);
  }
}

/** Build the {@link LiveChange} for one entry from the re-read rows. */
function toChange(
  state: CaptureState,
  entry: ResolvedEntry,
  rows: RereadRows,
): LiveChange | undefined {
  let row: ObjectLiteral | null = null;
  if (entry.operation !== 'delete') {
    const reread = rows.get(entry.key);
    if (reread === undefined) {
      // The re-read failed (already reported); drop this change.
      return undefined;
    }
    row = reread;
  }
  try {
    return {
      // The change log assigns the durable sequence on append
      // (docs/design/live.md §4.1, §4.5); capture hands a placeholder.
      sequence: 0,
      // Capture knows the entity, not the publications watching it; the service
      // maps the entity name to each publication's client-visible collection.
      collection: entry.target.getRepository().metadata.name,
      id: normalizeId(entry.idMap),
      operation: entry.operation,
      row: row === null ? null : projectRow(entry.target, row),
      at: Date.now(),
    };
  } catch (error) {
    report(state, error);
    return undefined;
  }
}

/** Normalize a PK map to the wire string. */
function normalizeId(idMap: Record<string, unknown>): string {
  return serializePrimaryKey(Object.values(idMap));
}

/** Report a non-fatal flush error through the optional listener. */
function report(state: CaptureState, error: unknown): void {
  state.onError?.(error);
}
