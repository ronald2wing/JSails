/**
 * Set writes through the pipeline: `updateAll`, `deleteAll` and `insertAll`.
 * Each is one statement (`insertAll` one per bind-limit chunk) plus the set
 * form of the model's declared effects, with codecs and the tenant policy
 * applied and change records emitted, atomically.
 *
 * - No record hooks or validation run. On a model that declares any for the
 *   operation (`afterCommit` counts for every operation) the call must say
 *   so with `{ skipHooks: true }`, or it throws
 *   `query.set_write_skips_hooks`.
 * - Effects run in set form: counter caches are recounted and touched
 *   parents touched (`parent-effects.ts`), and `dependent` rows are deleted
 *   or nullified by condition before a `deleteAll` (`dependent.ts`). An
 *   effect with no set form (a dependent that must destroy each child
 *   through the pipeline, attachments on `deleteAll` or on an `updateAll`
 *   that assigns the primary key) throws `query.unsupported_set_write`
 *   unless the call passes `{ skipEffects: true }`, which skips every effect
 *   the pipeline would run (a database foreign-key action still applies).
 * - Change records: an `updateAll`/`deleteAll` whose condition is a
 *   primary-key lookup reports each key, anything else one `invalidate`
 *   (`statement-keys.ts`); `insertAll` reads the inserted keys back when a
 *   subscription exists. A write that matched no row reports nothing.
 */

import type { ChangeKey } from '../change/change-record.js';
import { predicateKeys } from '../change/statement-keys.js';
import { decodeColumn, type ModelCodecs } from '../codec/model-codecs.js';
import type { SqlValue } from '../engine/contract.js';
import { BIND_LIMITS } from '../engine/render.js';
import type { Predicate } from '../engine/statement.js';
import { QueryErrors } from '../query/query-errors.js';
import type { QueryContext, WriteResult } from '../query/query-context.js';
import { deleteFrom, insert, update } from '../statement/builders.js';
import { encodeAssignments, encodeInsertRows, type Values } from '../statement/model-values.js';
import { withoutTenantScope } from '../statement/tenant-scope.js';
import { transaction } from '../transaction/run-transaction.js';
import { applyDependentsOfRows } from './effects/dependent.js';
import { parentsOfRows, recountParents } from './effects/parent-effects.js';
import type { EffectPlan, ParentEffect } from './effects/plan.js';
import { openSession, type WriteSession } from './effects/write-session.js';
import { runsRecordLogic, type RecordOperation } from './hooks.js';

/** What a set write acknowledges it leaves out. */
export interface SetWriteOptions {
  /** Write although the model declares hooks or validation for the operation; none run. */
  readonly skipHooks?: boolean;
  /** Write without the pipeline's effects, which also lifts `unsupported_set_write`. */
  readonly skipEffects?: boolean;
}

interface Acknowledged {
  readonly skipHooks: boolean;
  readonly skipEffects: boolean;
}

const OPTION_KEYS: ReadonlySet<string> = new Set(['skipHooks', 'skipEffects']);

/** `options` checked, for a set write `method` on `codecs`' model. */
function acknowledged(codecs: ModelCodecs, method: string, options: unknown): Acknowledged {
  if (options === undefined) return { skipHooks: false, skipEffects: false };
  const invalid = (): never => {
    throw new QueryErrors.Error('invalid_argument', {
      model: codecs.spec.name,
      method,
      argument: 'options',
    });
  };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return invalid();
  const given = options as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(given)) {
    if (!OPTION_KEYS.has(key)) invalid();
    if (given[key] !== undefined && typeof given[key] !== 'boolean') invalid();
  }
  return { skipHooks: given.skipHooks === true, skipEffects: given.skipEffects === true };
}

/** Refuse a set write that would silently skip the model's hooks or validation. */
function requireHooksAcknowledged(
  plan: EffectPlan,
  operation: RecordOperation,
  ack: Acknowledged,
): void {
  if (!ack.skipHooks && runsRecordLogic(plan.behavior, operation)) {
    throw new QueryErrors.Error('set_write_skips_hooks', { model: plan.codecs.spec.name });
  }
}

function unsupported(plan: EffectPlan, effect: 'dependent' | 'attachment'): never {
  throw new QueryErrors.Error('unsupported_set_write', { model: plan.codecs.spec.name, effect });
}

/**
 * Open a session, let `prepare` check the write and say whether it needs a
 * transaction, and run `write` in one when it does, under the tenant scope
 * or with it off.
 */
function runWrite<R>(
  context: QueryContext,
  unscoped: boolean,
  prepare: (session: WriteSession) => boolean,
  write: (session: WriteSession) => Promise<R>,
): Promise<R> {
  const start = async (): Promise<R> => {
    const session = await openSession(context);
    return prepare(session)
      ? transaction(context.dataSource, () => write(session))
      : write(session);
  };
  return unscoped ? withoutTenantScope(start) : start();
}

/** Report the rows `where` matched as keys, or as an `invalidate` of the collection. */
function recordMatched(
  session: WriteSession,
  codecs: ModelCodecs,
  op: 'update' | 'delete',
  where: Predicate,
  byKey: boolean,
): void {
  const tenant = session.scopeTenant(codecs);
  const keys = byKey ? predicateKeys(codecs, where) : undefined;
  if (keys === undefined) {
    session.record(codecs, 'invalidate', undefined, tenant);
    return;
  }
  for (const key of keys) session.record(codecs, op, key, tenant);
}

/** The parents of the rows `where` matches, per effect, read before the write. */
async function parentsBefore(
  session: WriteSession,
  codecs: ModelCodecs,
  parents: readonly ParentEffect[],
  where: Predicate,
): Promise<Map<ParentEffect, unknown[]>> {
  const before = new Map<ParentEffect, unknown[]>();
  for (const parent of parents)
    before.set(parent, await parentsOfRows(session, codecs, parent, where));
  return before;
}

/**
 * Update the rows `where` matches with `set`; see the module header.
 *
 * @throws `query.invalid_argument` (`options`), `query.set_write_skips_hooks`,
 *   `query.unsupported_set_write`, and the codec, policy and database
 *   failures of its statements.
 */
export function updateRows<T>(
  context: QueryContext,
  codecs: ModelCodecs,
  where: Predicate,
  set: Values<T>,
  options: SetWriteOptions | undefined,
  unscoped: boolean,
): Promise<WriteResult> {
  const ack = acknowledged(codecs, 'updateAll', options);
  const assignments = encodeAssignments(codecs, set);
  const assigned = new Set(assignments.map((assignment) => assignment.column));
  let parents: readonly ParentEffect[] = [];
  let keyAssigned = false;
  const prepare = (session: WriteSession): boolean => {
    const plan = session.plan(codecs);
    requireHooksAcknowledged(plan, 'update', ack);
    keyAssigned = plan.primaryKey.some((column) => assigned.has(column.column));
    if (ack.skipEffects) return false;
    if (keyAssigned && plan.attachments.length > 0) unsupported(plan, 'attachment');
    parents = plan.parents.filter(
      (parent) =>
        parent.touch !== undefined ||
        (parent.counter !== undefined && assigned.has(parent.fk.column)),
    );
    return parents.length > 0;
  };
  const write = async (session: WriteSession): Promise<WriteResult> => {
    const before = await parentsBefore(session, codecs, parents, where);
    const result = await session.run(update(codecs.spec.table, assignments, where));
    if (result.affected > 0) {
      const now = new Date();
      for (const parent of parents) {
        const keys = before.get(parent) ?? [];
        const moved = (set as Readonly<Record<string, unknown>>)[parent.fk.property];
        await recountParents(
          session,
          codecs,
          parent,
          moved === undefined ? keys : [...keys, moved],
          now,
        );
      }
      recordMatched(session, codecs, 'update', where, !keyAssigned);
    }
    await session.flush();
    return Object.freeze({ affected: result.affected });
  };
  return runWrite(context, unscoped, prepare, write);
}

/**
 * Delete the rows `where` matches; see the module header.
 *
 * @throws `query.invalid_argument` (`options`), `query.set_write_skips_hooks`,
 *   `query.unsupported_set_write`, and the policy and database failures of
 *   its statements.
 */
export function deleteRows(
  context: QueryContext,
  codecs: ModelCodecs,
  where: Predicate,
  options: SetWriteOptions | undefined,
  unscoped: boolean,
): Promise<WriteResult> {
  const ack = acknowledged(codecs, 'deleteAll', options);
  let plan: EffectPlan | undefined;
  const prepare = (session: WriteSession): boolean => {
    plan = session.plan(codecs);
    requireHooksAcknowledged(plan, 'delete', ack);
    if (ack.skipEffects) return false;
    if (plan.attachments.length > 0) unsupported(plan, 'attachment');
    if (plan.dependents.some((dependent) => dependent.form === 'records')) {
      unsupported(plan, 'dependent');
    }
    return plan.parents.length > 0 || plan.dependents.some((d) => d.form === 'statement');
  };
  const write = async (session: WriteSession): Promise<WriteResult> => {
    const current = plan as EffectPlan;
    const parents = ack.skipEffects ? [] : current.parents;
    const before = await parentsBefore(session, codecs, parents, where);
    if (!ack.skipEffects) {
      await applyDependentsOfRows(session, current.dependents, where);
    }
    const result = await session.run(deleteFrom(codecs.spec.table, where));
    if (result.affected > 0) {
      const now = new Date();
      for (const parent of parents) {
        await recountParents(session, codecs, parent, before.get(parent) ?? [], now);
      }
      recordMatched(session, codecs, 'delete', where, true);
      for (const cascade of ack.skipEffects ? current.actionCascades : current.cascades) {
        session.record(cascade, 'invalidate', undefined, session.scopeTenant(cascade));
      }
    }
    await session.flush();
    return Object.freeze({ affected: result.affected });
  };
  return runWrite(context, unscoped, prepare, write);
}

/**
 * Insert `rows` of `codecs`' model: one statement per bind-limit chunk, all
 * in one transaction when there is more than one or an effect runs.
 *
 * @throws `query.invalid_argument` (`options`), `query.set_write_skips_hooks`,
 *   `statement.invalid_values` (no rows, or rows that differ in their
 *   properties), `statement.unknown_column`, `ColumnValueError`, the tenant
 *   policy's codes, and the engine's `DatabaseError`s.
 */
export function insertRows<T>(
  context: QueryContext,
  codecs: ModelCodecs,
  rows: readonly Values<T>[],
  options?: SetWriteOptions,
): Promise<WriteResult> {
  const ack = acknowledged(codecs, 'insertAll', options);
  const encoded = encodeInsertRows(codecs, rows);
  // One spare parameter per row for the tenant column the policy may stamp.
  const perRow = encoded.columns.length + 1;
  const chunkSize = Math.max(1, Math.floor(BIND_LIMITS[context.catalog.dialect] / perRow));
  const chunks: (readonly (readonly SqlValue[])[])[] = [];
  for (let start = 0; start < encoded.rows.length; start += chunkSize) {
    chunks.push(encoded.rows.slice(start, start + chunkSize));
  }
  let plan: EffectPlan | undefined;
  const prepare = (session: WriteSession): boolean => {
    plan = session.plan(codecs);
    requireHooksAcknowledged(plan, 'insert', ack);
    return chunks.length > 1 || (!ack.skipEffects && plan.parents.length > 0);
  };
  const write = async (session: WriteSession): Promise<WriteResult> => {
    const current = plan as EffectPlan;
    const reported = session.emitter.active;
    const returning = reported
      ? [...current.primaryKey, ...(current.tenant === undefined ? [] : [current.tenant])]
      : [];
    let affected = 0;
    for (const chunk of chunks) {
      const result = await session.run(
        insert(
          codecs.spec.table,
          encoded.columns,
          chunk,
          reported ? { returning: [...new Set(returning.map((column) => column.column))] } : {},
        ),
      );
      affected += result.affected;
      for (const row of reported ? result.rows : []) {
        const decoded: Record<string, unknown> = {};
        for (const column of returning) {
          decoded[column.property] = decodeColumn(column, row[column.column]);
        }
        const key =
          current.primaryKey.length === 1
            ? decoded[(current.primaryKey[0] as (typeof returning)[number]).property]
            : Object.freeze(
                Object.fromEntries(
                  current.primaryKey.map((c) => [c.property, decoded[c.property]]),
                ),
              );
        session.record(
          codecs,
          'insert',
          key as ChangeKey,
          current.tenant === undefined ? undefined : decoded[current.tenant.property],
        );
      }
    }
    if (!ack.skipEffects && affected > 0) {
      const now = new Date();
      for (const parent of current.parents) {
        const keys = rows.map(
          (row) => (row as Readonly<Record<string, unknown>>)[parent.fk.property],
        );
        await recountParents(session, codecs, parent, keys, now);
      }
    }
    await session.flush();
    return Object.freeze({ affected });
  };
  return runWrite(context, false, prepare, write);
}

/**
 * `rows` split into consecutive runs whose rows name the same properties:
 * one insert writes one column list, and a seed row may leave out a column
 * that has a default. Keeping the runs in order keeps generated keys in the
 * rows' order. Seeded and fixture rows go through it.
 */
export function runsOfSameShape(
  rows: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>>[][] {
  const runs: Readonly<Record<string, unknown>>[][] = [];
  let shape: string | undefined;
  for (const row of rows) {
    const key = Object.keys(row)
      .filter((property) => row[property] !== undefined)
      .toSorted()
      .join('\u0000');
    if (key !== shape || runs.length === 0) {
      runs.push([]);
      shape = key;
    }
    runs[runs.length - 1]?.push(row);
  }
  return runs;
}
