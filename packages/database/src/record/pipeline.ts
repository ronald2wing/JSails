/**
 * The write pipeline of a record: `save()` and `destroy()` of one full
 * instance, with its hooks, validation, declared effects and change records,
 * atomically.
 *
 * - A save inserts a new record (every property that is not `undefined`,
 *   reading every column back so generated keys, defaults and the stamped
 *   tenant land on it) or updates the columns of a persisted one that differ
 *   from its baseline, by the baseline key, requiring and bumping
 *   `lockVersion` when the model has one. A save with nothing to write (no
 *   changed column, no pending attachment, no autosave relation with work)
 *   does nothing at all: no statement, no hook, no change record.
 * - The order of a save: `beforeSave`, `beforeInsert`/`beforeUpdate`, the
 *   autosave `belongsTo` targets, the tenant stamp of an insert, validation,
 *   the write, the parent effects (counter cache, touch), the move of the
 *   attachment rows when the primary key changed, the autosave children,
 *   the attachments, `afterInsert`/`afterUpdate`, `afterSave`, and
 *   `afterCommit` once the outermost transaction commits.
 * - The order of a destroy: `beforeDelete`, the dependents, the attachment
 *   rows, the delete, the parent effects, `afterDelete`, `afterCommit`.
 * - An update or delete that matches no row throws `record.stale_record`:
 *   the row was deleted, or changed under optimistic locking. Its effects
 *   roll back with it.
 * - When the transaction a write ran in rolls back (its own, or the
 *   caller's later), each record it wrote is put back as it was before the
 *   write: unsaved again after an insert, its old baseline and
 *   `lockVersion` after an update, saved again after a destroy. A record
 *   written several times in the transaction is put back as it was before
 *   the first write (the undos run newest first).
 * - A write that runs more than one statement, or any hook, runs in a
 *   transaction: a new one, or a savepoint of the caller's, so a failure
 *   leaves nothing of the write behind while the caller's transaction
 *   carries on. A one-statement write without hooks runs as that statement.
 *   Related records an effect saves or destroys (autosave, a dependent that
 *   needs its own pipeline) run inside the same write.
 * - A new record of a tenant-scoped model whose tenant property is unset
 *   takes the current tenant before validation; the guarded compile still
 *   refuses any other. A foreign key is not checked to point at a row of the
 *   same tenant: that is the schema's or the application's rule to keep.
 * - The change records of the write are handed to the feed in its
 *   transaction, so they are delivered after the outermost commit and
 *   dropped with a rollback.
 */

import { persistedState, recordState, setRecordState, type RecordState } from '../codec/hydrate.js';
import {
  decodeColumn,
  encodeColumn,
  type CodecColumn,
  type ModelCodecs,
} from '../codec/model-codecs.js';
import type { ChangeKey } from '../change/change-record.js';
import type { Assignment } from '../engine/statement.js';
import { and, col, deleteFrom, eq, insert, update } from '../statement/builders.js';
import { encodeInsertRows } from '../statement/model-values.js';
import { currentTenantScope } from '../statement/tenant-scope.js';
import { transaction, type Tx } from '../transaction/run-transaction.js';
import {
  destroyAttachments,
  moveAttachments,
  pendingAttachments,
  writeAttachments,
} from './attachments.js';
import { autosaveHasWork, saveChildren, saveTargets } from './effects/autosave.js';
import { applyDependentsOfRecord } from './effects/dependent.js';
import { applyParentRow } from './effects/parent-effects.js';
import type { EffectPlan } from './effects/plan.js';
import { openSession, recordTenant, type WriteSession } from './effects/write-session.js';
import {
  OPERATION_HOOKS,
  runHook,
  type PipelineHookContext,
  type RecordOperation,
} from './hooks.js';
import { RecordErrors } from './record-errors.js';
import {
  assign,
  changedColumns,
  keyCondition,
  persisted,
  sameValue,
  storeRow,
  targetOf,
  undoOnRollback,
  type RecordObject,
} from './record-values.js';
import { validateRecord } from './validation.js';

/** One top-level write and the records it already saved, so a relation cycle saves each once. */
interface WriteRun {
  readonly session: WriteSession;
  readonly visited: Set<object>;
}

type Changes = Map<string, readonly [before: unknown, after: unknown]>;

const NO_CHANGES: ReadonlyMap<string, readonly [unknown, unknown]> = new Map();

/** Whether `plan`'s model declares a hook a write of `operation` calls. */
function hasHooks(plan: EffectPlan, operation: RecordOperation): boolean {
  const hooks = plan.behavior?.hooks;
  return (
    hooks !== undefined && OPERATION_HOOKS[operation].some((name) => hooks[name] !== undefined)
  );
}

/** The primary key of `values` (a record or a baseline) as the change records carry it. */
function keyOf(plan: EffectPlan, values: Readonly<Record<string, unknown>>): ChangeKey {
  if (plan.primaryKey.length === 1) {
    return values[(plan.primaryKey[0] as CodecColumn).property] as ChangeKey;
  }
  const key: Record<string, unknown> = {};
  for (const column of plan.primaryKey) key[column.property] = values[column.property];
  return Object.freeze(key);
}

function hookContext(
  record: object,
  operation: RecordOperation,
  changes: ReadonlyMap<string, readonly [unknown, unknown]>,
  tx: Tx | undefined,
): PipelineHookContext {
  // A write runs hooks only inside a transaction (`needsTransaction`), so
  // `tx` is set whenever a context reaches a hook.
  return Object.freeze({ record, operation, changes, tx: tx as Tx });
}

/** The changes of `record` against `state`: `[before, after]` per changed column. */
function pendingChanges(
  codecs: ModelCodecs,
  record: object,
  state: RecordState | undefined,
): Changes {
  const changes: Changes = new Map();
  const values = record as RecordObject;
  for (const column of changedColumns(codecs, record, state)) {
    const before = state?.persisted === true ? state.baseline[column.property] : undefined;
    changes.set(column.property, [before, values[column.property]]);
  }
  return changes;
}

/** Set an unset tenant property of a new record from the tenant scope. */
function stampTenant(session: WriteSession, plan: EffectPlan, record: object): void {
  if (plan.tenant === undefined) return;
  const values = record as RecordObject;
  if (values[plan.tenant.property] !== undefined) return;
  const scope = currentTenantScope();
  const tenant = session.context.catalog.tenant(plan.codecs.spec.table);
  if (scope.unscoped || scope.tenantId === undefined || tenant === undefined) return;
  values[plan.tenant.property] = decodeColumn(plan.tenant, tenant.encode(scope.tenantId));
}

/** Whether any parent effect of `plan` writes a parent when `record` is saved. */
function parentWrites(plan: EffectPlan, record: object, state: RecordState | undefined): boolean {
  const values = record as RecordObject;
  return plan.parents.some((parent) => {
    const after = values[parent.fk.property];
    const before = state?.persisted === true ? state.baseline[parent.fk.property] : undefined;
    if (parent.touch !== undefined) return (after ?? before ?? null) !== null;
    return state?.persisted !== true ? (after ?? null) !== null : !sameValue(before, after);
  });
}

/** Whether a save of a persisted `record` changes its primary key. */
function changesKey(plan: EffectPlan, record: object, state: RecordState | undefined): boolean {
  if (state?.persisted !== true) return false;
  const values = record as RecordObject;
  return plan.primaryKey.some(
    (column) => !sameValue(values[column.property], state.baseline[column.property]),
  );
}

/** Whether a save of `record` may run more than one statement, or runs any hook. */
function saveNeedsTransaction(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  state: RecordState | undefined,
  operation: RecordOperation,
): boolean {
  if (hasHooks(plan, operation)) return true;
  if (pendingAttachments(plan, record).length > 0) return true;
  if (plan.attachments.length > 0 && changesKey(plan, record, state)) return true;
  if (autosaveHasWork(session, plan, record, new Set([record]))) return true;
  return parentWrites(plan, record, state);
}

async function insertRow(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
): Promise<Changes> {
  const { codecs } = plan;
  const values: Record<string, unknown> = {};
  for (const column of codecs.columns) {
    const value = (record as RecordObject)[column.property];
    if (value !== undefined) values[column.property] = value;
  }
  const encoded = encodeInsertRows(codecs, [values]);
  const result = await session.run(
    insert(codecs.spec.table, encoded.columns, encoded.rows, {
      returning: codecs.columns.map((column) => column.column),
    }),
  );
  const row = result.rows[0];
  if (row === undefined) throw new RecordErrors.Error('stale_record', { model: codecs.spec.name });
  session.onRollback(undoOnRollback(record, codecs, () => storeRow(record, codecs, row)));
  const changes: Changes = new Map();
  for (const column of codecs.columns) {
    changes.set(column.property, [undefined, (record as RecordObject)[column.property]]);
  }
  return changes;
}

async function updateRow(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  state: RecordState,
): Promise<Changes> {
  const { codecs } = plan;
  const values = record as RecordObject;
  const changed = changedColumns(codecs, record, state);
  const changes: Changes = new Map();
  if (changed.length === 0) return changes;
  const written: Record<string, unknown> = {};
  const assignments: Assignment[] = [];
  const write = (column: CodecColumn, value: unknown): void => {
    const stored = encodeColumn(column, value);
    assignments.push({ column: column.column, value: stored });
    written[column.property] = decodeColumn(column, stored);
    changes.set(column.property, [state.baseline[column.property], written[column.property]]);
  };
  for (const column of changed) write(column, values[column.property]);
  let where = keyCondition(codecs, state.baseline);
  const version = plan.lockVersion;
  if (version !== undefined) {
    const current = state.baseline[version.property];
    where = and(where, eq(col(codecs.spec.table, version.column), encodeColumn(version, current)));
    if (!changed.includes(version)) write(version, (current as number) + 1);
  }
  const result = await session.run(update(codecs.spec.table, assignments, where));
  if (result.affected === 0) {
    throw new RecordErrors.Error('stale_record', { model: codecs.spec.name });
  }
  session.onRollback(
    undoOnRollback(record, codecs, () => {
      assign(record, written);
      const baseline: Record<string, unknown> = {};
      for (const column of codecs.columns) baseline[column.property] = values[column.property];
      setRecordState(record, persistedState(codecs, baseline));
    }),
  );
  return changes;
}

/** Save `record` of `plan`'s model within `run`; see the module header for the order. */
async function saveWithin(
  run: WriteRun,
  record: object,
  plan: EffectPlan,
  tx: Tx | undefined,
): Promise<void> {
  if (run.visited.has(record)) return;
  run.visited.add(record);
  const { session } = run;
  const { codecs, behavior } = plan;
  const state = recordState(record);
  const operation: RecordOperation = state?.persisted === true ? 'update' : 'insert';
  if (hasHooks(plan, operation)) {
    const before = hookContext(record, operation, pendingChanges(codecs, record, state), tx);
    await runHook(behavior, 'beforeSave', before);
    await runHook(behavior, operation === 'insert' ? 'beforeInsert' : 'beforeUpdate', before);
  }
  const saveRelated = (related: object): Promise<void> =>
    saveWithin(run, related, session.plan(targetOf(related).codecs), tx);
  await saveTargets(session, plan, record, saveRelated);
  if (operation === 'insert') stampTenant(session, plan, record);
  validateRecord(behavior?.validate, record, codecs.spec.name);
  const pending = pendingAttachments(plan, record);
  const oldKey = state?.persisted === true ? keyOf(plan, state.baseline) : undefined;
  const changes =
    state?.persisted === true
      ? await updateRow(session, plan, record, state)
      : await insertRow(session, plan, record);
  const values = record as RecordObject;
  if (changes.size > 0) {
    const now = new Date();
    for (const parent of plan.parents) {
      const before = state?.persisted === true ? state.baseline[parent.fk.property] : undefined;
      await applyParentRow(session, parent, { before, after: values[parent.fk.property] }, now);
    }
  }
  const key = keyOf(plan, values);
  const keyChanged =
    oldKey !== undefined && plan.primaryKey.some((column) => changes.has(column.property));
  if (keyChanged) await moveAttachments(session, plan, oldKey, key);
  await saveChildren(
    session,
    plan,
    record,
    state?.persisted === true ? state.baseline : undefined,
    saveRelated,
  );
  if (pending.length > 0) await writeAttachments(session, plan, record, key, pending, tx as Tx);
  const tenant = recordTenant(plan.tenant, record);
  if (oldKey === undefined) session.record(codecs, 'insert', key, tenant);
  else if (keyChanged) {
    session.record(codecs, 'delete', oldKey, tenant);
    session.record(codecs, 'insert', key, tenant);
  } else if (changes.size > 0) session.record(codecs, 'update', key, tenant);
  if (!hasHooks(plan, operation)) return;
  const after = hookContext(record, operation, changes, tx);
  await runHook(behavior, operation === 'insert' ? 'afterInsert' : 'afterUpdate', after);
  await runHook(behavior, 'afterSave', after);
  if (behavior?.hooks.afterCommit !== undefined) {
    (tx as Tx).afterCommit(() => runHook(behavior, 'afterCommit', after));
  }
}

/** Destroy `record` of `plan`'s model within `run`; see the module header for the order. */
async function destroyWithin(
  run: WriteRun,
  record: object,
  plan: EffectPlan,
  tx: Tx | undefined,
): Promise<void> {
  if (run.visited.has(record)) return;
  run.visited.add(record);
  const { session } = run;
  const { codecs, behavior } = plan;
  const state = persisted(record, codecs, 'destroyed');
  const hooked = hasHooks(plan, 'delete');
  const context = hookContext(record, 'delete', NO_CHANGES, tx);
  if (hooked) await runHook(behavior, 'beforeDelete', context);
  const key = keyOf(plan, state.baseline);
  await applyDependentsOfRecord(session, plan.dependents, key, (child, childPlan) =>
    destroyWithin(run, child, childPlan, tx),
  );
  if (plan.attachments.length > 0) await destroyAttachments(session, plan, key, tx as Tx);
  let where = keyCondition(codecs, state.baseline);
  const version = plan.lockVersion;
  if (version !== undefined) {
    where = and(
      where,
      eq(
        col(codecs.spec.table, version.column),
        encodeColumn(version, state.baseline[version.property]),
      ),
    );
  }
  const result = await session.run(deleteFrom(codecs.spec.table, where));
  if (result.affected === 0) {
    throw new RecordErrors.Error('stale_record', { model: codecs.spec.name });
  }
  const now = new Date();
  for (const parent of plan.parents) {
    const before = state.baseline[parent.fk.property];
    await applyParentRow(session, parent, { before, after: undefined }, now);
  }
  session.record(codecs, 'delete', key, recordTenant(plan.tenant, state.baseline));
  for (const cascade of plan.cascades) {
    session.record(cascade, 'invalidate', undefined, session.scopeTenant(cascade));
  }
  session.onRollback(
    undoOnRollback(record, codecs, () =>
      setRecordState(record, { persisted: false, baseline: state.baseline, fks: state.fks }),
    ),
  );
  if (!hooked) return;
  await runHook(behavior, 'afterDelete', context);
  if (behavior?.hooks.afterCommit !== undefined) {
    (tx as Tx).afterCommit(() => runHook(behavior, 'afterCommit', context));
  }
}

/** Whether a destroy of `record` runs more than one statement or any hook. */
function destroyNeedsTransaction(plan: EffectPlan, state: RecordState): boolean {
  if (hasHooks(plan, 'delete') || plan.attachments.length > 0) return true;
  if (plan.dependents.some((dependent) => dependent.form !== 'database')) return true;
  return plan.parents.some((parent) => (state.baseline[parent.fk.property] ?? null) !== null);
}

/**
 * Insert `record`, or update its changed columns; see the module header.
 *
 * @throws `record.invalid`, `record.stale_record`, `record.invalid_attachment`,
 *   `record.invalid_relation`, and the codec, policy and database failures
 *   of its statements.
 */
export async function saveRecord(record: object): Promise<void> {
  const { context, codecs } = targetOf(record);
  const session = await openSession(context);
  const plan = session.plan(codecs);
  const state = recordState(record);
  const operation: RecordOperation = state?.persisted === true ? 'update' : 'insert';
  if (
    operation === 'update' &&
    changedColumns(codecs, record, state).length === 0 &&
    pendingAttachments(plan, record).length === 0 &&
    !autosaveHasWork(session, plan, record, new Set([record]))
  ) {
    return;
  }
  const run: WriteRun = { session, visited: new Set() };
  if (!saveNeedsTransaction(session, plan, record, state, operation)) {
    await saveWithin(run, record, plan, undefined);
    await session.flush();
    return;
  }
  await transaction(context.dataSource, async (tx) => {
    await saveWithin(run, record, plan, tx);
    await session.flush();
  });
}

/**
 * Delete `record`'s row, with its dependents and attachments; it is unsaved
 * afterwards.
 *
 * @throws `record.not_persisted`, `record.stale_record`, and the policy and
 *   database failures of its statements.
 */
export async function destroyRecord(record: object): Promise<void> {
  const { context, codecs } = targetOf(record);
  const state = persisted(record, codecs, 'destroyed');
  const session = await openSession(context);
  const plan = session.plan(codecs);
  const run: WriteRun = { session, visited: new Set() };
  if (!destroyNeedsTransaction(plan, state)) {
    await destroyWithin(run, record, plan, undefined);
    await session.flush();
    return;
  }
  await transaction(context.dataSource, async (tx) => {
    await destroyWithin(run, record, plan, tx);
    await session.flush();
  });
}
