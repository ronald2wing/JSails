/**
 * Dependents: what deleting an owner does to the rows of a `hasMany` or
 * `hasOne` that declares `dependent`, in the form the effect plan chose.
 *
 * - `database`: nothing here; the foreign-key action (`ON DELETE CASCADE` or
 *   `SET NULL`) is the whole work, and the delete reports the child as
 *   `invalidate` through the plan's cascades.
 * - `statement`: one statement before the owner's delete. Nullify sets the
 *   key (and a polymorphic type) to `NULL`, and bumps the child's
 *   `lockVersion`; destroy of a polymorphic child with an empty plan is one
 *   `DELETE`. The row form names the owner's key, the set form the owners
 *   matching the set write (`IN (SELECT pk FROM owner WHERE ...)`). The child
 *   is reported as `invalidate`. Child hooks never run (as for any effect
 *   write).
 * - `records`: each child is loaded and destroyed through the pipeline, in
 *   keyset batches of 500, so its own hooks and effects run. A set write
 *   cannot do this and is refused.
 */

import { hydrate } from '../../codec/hydrate.js';
import { encodeColumn, type CodecColumn } from '../../codec/model-codecs.js';
import type { SqlValue } from '../../engine/contract.js';
import type { Assignment, Predicate, SelectStatement } from '../../engine/statement.js';
import {
  and,
  col,
  deleteFrom,
  eq,
  inSelect,
  select,
  table,
  update,
} from '../../statement/builders.js';
import { modelColumns } from '../../statement/where.js';
import { keysetAfter, keysetOrder, keysetTerms } from '../../query/keyset.js';
import type { DependentEffect, EffectPlan } from './plan.js';
import type { WriteSession } from './write-session.js';

/** Destroys one child record through the pipeline, within the owner's write. */
export type DestroyChild = (record: object, plan: EffectPlan) => Promise<void>;

/** The rows of a records-form dependent destroyed per batch. */
export const DEPENDENT_BATCH_SIZE = 500;

/** The owners a dependent's rows point at: one key, or the owners a set write matches. */
export type Owners =
  | { readonly kind: 'key'; readonly key: unknown }
  | { readonly kind: 'rows'; readonly where: Predicate };

/** The condition on the child's rows that point at `owners`. */
function childCondition(effect: DependentEffect, owners: Owners): Predicate {
  const childTable = effect.child.spec.table;
  const { link } = effect;
  const target: CodecColumn = link.kind === 'fk' ? link.fk : link.id;
  let keyed: Predicate;
  if (owners.kind === 'key') {
    keyed = eq(col(childTable, target.column), encodeColumn(target, owners.key));
  } else {
    const ownerTable = effect.owner.spec.table;
    const owned: SelectStatement = select(table(ownerTable), {
      columns: [{ column: col(ownerTable, effect.ownerKey.column), as: effect.ownerKey.column }],
      ...(owners.where.op === 'true' ? {} : { where: owners.where }),
    });
    keyed = inSelect(col(childTable, target.column), owned);
  }
  if (link.kind === 'fk') return keyed;
  return and(eq(col(childTable, link.type.column), encodeColumn(link.type, link.typeValue)), keyed);
}

/** Run the statement form of `effect` for `owners`. */
async function applyStatement(
  session: WriteSession,
  effect: DependentEffect,
  owners: Owners,
): Promise<void> {
  const child = effect.child;
  const where = childCondition(effect, owners);
  let affected: number;
  if (effect.kind === 'destroy') {
    affected = (await session.run(deleteFrom(child.spec.table, where))).affected;
  } else {
    const { link } = effect;
    const set: Assignment[] = [];
    if (link.kind === 'fk') set.push({ column: link.fk.column, value: null });
    else {
      set.push({ column: link.type.column, value: null }, { column: link.id.column, value: null });
    }
    const version = session.plan(child).lockVersion;
    if (version !== undefined) set.push({ column: version.column, add: 1 });
    affected = (await session.run(update(child.spec.table, set, where))).affected;
  }
  if (affected > 0) session.record(child, 'invalidate', undefined, session.scopeTenant(child));
}

/** Destroy, through the pipeline, every child of the owner `key`. */
async function destroyChildren(
  session: WriteSession,
  effect: DependentEffect,
  key: unknown,
  destroy: DestroyChild,
): Promise<void> {
  const child = effect.child;
  const plan = session.plan(child);
  const childTable = child.spec.table;
  const where = childCondition(effect, { kind: 'key', key });
  const terms = keysetTerms(child, []);
  const orderBy = keysetOrder(terms, childTable);
  let cursor: readonly SqlValue[] | undefined;
  for (;;) {
    const after =
      cursor === undefined
        ? where
        : and(where, keysetAfter(terms, cursor, childTable, session.context.catalog.dialect));
    const result = await session.run(
      select(table(childTable), {
        columns: modelColumns(child, childTable),
        where: after,
        orderBy,
        limit: DEPENDENT_BATCH_SIZE,
      }),
    );
    for (const row of result.rows) await destroy(hydrate(child, row), plan);
    const last = result.rows[result.rows.length - 1];
    if (last === undefined || result.rows.length < DEPENDENT_BATCH_SIZE) return;
    cursor = terms.map((term) => last[term.column.column] as SqlValue);
  }
}

/**
 * Delete or nullify the dependents of the owner `key` before the owner's
 * own delete, through `destroy` for the records form.
 */
export async function applyDependentsOfRecord(
  session: WriteSession,
  dependents: readonly DependentEffect[],
  key: unknown,
  destroy: DestroyChild,
): Promise<void> {
  for (const effect of dependents) {
    if (effect.form === 'statement') await applyStatement(session, effect, { kind: 'key', key });
    else if (effect.form === 'records') await destroyChildren(session, effect, key, destroy);
  }
}

/** Delete or nullify the dependents of the owners `where` matches, before a set delete. */
export async function applyDependentsOfRows(
  session: WriteSession,
  dependents: readonly DependentEffect[],
  where: Predicate,
): Promise<void> {
  for (const effect of dependents) {
    if (effect.form === 'statement') await applyStatement(session, effect, { kind: 'rows', where });
  }
}
