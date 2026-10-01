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
 * (LIVE-PLAN.md Phase 3 notes 1-4).
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
 * transaction later rolls back from ever being emitted (LIVE-PLAN.md note 3).
 *
 * Flush re-reads each affected row by primary key — the write hooks only carry
 * the operation and identity, never a complete row — projects it with
 * {@link projectRow}, and hands a full {@link LiveChange} to the `onChange`
 * listener. Deletes skip the re-read and emit `row: null`. Nothing in the flush
 * path throws into the caller's write (LIVE-PLAN.md note 7): re-read errors are
 * reported through the optional `onError` listener and swallowed.
 */

import { EventSubscriber } from 'typeorm';
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

import type { Awaitable } from '../internal/awaitable.js';
import type { LiveChange, LiveChangeOperation } from './change-record.js';
import { projectRow } from './projection.js';

/** A callback receiving one flush's committed changes, in capture order. */
export type LiveChangeListener = (changes: readonly LiveChange[]) => Awaitable<void>;

/** Receives a non-fatal flush error (a re-read failure); the write is unaffected. */
export type LiveErrorListener = (error: unknown) => void;

/** Options for {@link createChangeCapture}. */
export interface ChangeCaptureOptions {
  /** Called after each outermost commit with the batch of committed changes. */
  onChange?: LiveChangeListener;
  /** Optional sink for flush errors that must not reach the write path. */
  onError?: LiveErrorListener;
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

/** One transaction depth's captured entries. */
interface Frame {
  entries: ResolvedEntry[];
}

type FrameStack = Frame[];

/** One affected row: its entity class, normalized PK, and the write operation. */
interface ResolvedEntry {
  readonly target: typeof BaseEntity;
  readonly operation: LiveChangeOperation;
  readonly idMap: Record<string, unknown>;
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
  stack.push({ entries: [] });
  state.frames.set(queryRunner, stack);
}

/**
 * Append a write to the runner's top frame. Ignores a write with no frame (a
 * bare query-builder write — LIVE-PLAN.md note 9's blind spot) and a
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
  top.entries.push(resolved);
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
  return { target: entityClass, operation, idMap };
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
  if (frame === undefined || frame.entries.length === 0) {
    return;
  }
  await flush(state, frame.entries, event.manager);
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
  parent.entries.push(...top.entries);
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
 * Re-read each captured row, project it, and emit the batch. Deletes skip the
 * re-read (the row is gone) and emit `row: null`. A failed re-read is reported
 * through `onError` and that one change is dropped, so a flush can never fail a
 * `save()` that already committed (LIVE-PLAN.md notes 5, 7).
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
  const changes: LiveChange[] = [];
  for (const entry of entries) {
    const change = await resolveChange(manager, state, entry);
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
    // (LIVE-PLAN.md note 7): report through onError and swallow.
    report(state, error);
  }
}

/** Re-read and project one entry into a {@link LiveChange}. */
async function resolveChange(
  manager: EntityManager,
  state: CaptureState,
  entry: ResolvedEntry,
): Promise<LiveChange | undefined> {
  try {
    let row: ObjectLiteral | null = null;
    if (entry.operation !== 'delete') {
      row = await manager.getRepository(entry.target).findOneBy(entry.idMap);
    }
    return {
      // The change log assigns the durable sequence; capture hands a placeholder
      // (Phase 4's ChangeLog.append(change) replaces it — LIVE-PLAN.md §4.5).
      sequence: 0,
      // Provisional: the publication-scoped collection is resolved by the
      // multiplexer/service (Phases 4-5); the entity name stands in until then.
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

/** Normalize a PK map to the wire string: `id` for one column, JSON for composite. */
function normalizeId(idMap: Record<string, unknown>): string {
  const values = Object.values(idMap);
  return values.length === 1 ? String(values[0]) : JSON.stringify(values);
}

/** Report a non-fatal flush error through the optional listener. */
function report(state: CaptureState, error: unknown): void {
  state.onError?.(error);
}
