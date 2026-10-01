/**
 * The parent effects of a `belongsTo`: `counterCache` (an integer column on
 * the parent counting this model's rows) and `touch` (a timestamp on the
 * parent set to now when one of its rows is written). Both are effect
 * writes: codecs and the tenant policy apply, the parent's hooks and
 * validation never run, its `lockVersion` is left alone, and each parent
 * written is reported by key, with the tenant of the scope it was written in.
 *
 * - Row form (a record write): one `UPDATE parent SET c = c ± 1[, t = ?]
 *   WHERE pk = ?` per parent the row left or joined; a row that stays with
 *   its parent only touches it.
 * - Set form (a set write): the parents of the matched rows are read first
 *   (`SELECT DISTINCT fk`), since an update can move rows out of its own
 *   condition, and recounted afterwards with `UPDATE parent SET c = (SELECT
 *   COUNT(*) FROM child WHERE child.fk = parent.pk)[, t = ?] WHERE pk IN
 *   (...)`, chunked at the bind limit. A recount is exact whatever the
 *   condition was.
 */

import type { ChangeKey } from '../../change/change-record.js';
import { decodeColumn, encodeColumn, type ModelCodecs } from '../../codec/model-codecs.js';
import { BIND_LIMITS } from '../../engine/render.js';
import type { Assignment, Predicate, Statement } from '../../engine/statement.js';
import {
  col,
  compareColumns,
  eq,
  inList,
  select,
  table,
  update,
} from '../../statement/builders.js';
import { sameValue } from '../record-values.js';
import type { ParentEffect } from './plan.js';
import type { WriteSession } from './write-session.js';

/** The alias of the counted child table inside a recount, so a self relation stays unambiguous. */
const COUNTED = 'jsails_counted';

/** Parameters a recount may bind besides its keys: the touch value and the tenant conditions. */
const RECOUNT_SPARE_PARAMETERS = 8;

/** Where a row of the child sat, by the foreign key's application value; `undefined` for no row. */
export interface ParentMove {
  readonly before: unknown;
  readonly after: unknown;
}

function keyed(effect: ParentEffect, key: unknown): Predicate {
  return eq(
    col(effect.parent.spec.table, effect.parentKey.column),
    encodeColumn(effect.parentKey, key),
  );
}

/** Apply `effect` to the parents a row left and joined (`move`), at instant `now`. */
export async function applyParentRow(
  session: WriteSession,
  effect: ParentEffect,
  move: ParentMove,
  now: Date,
): Promise<void> {
  const { before, after } = move;
  const stays = before !== undefined && after !== undefined && sameValue(before, after);
  const writes: { key: unknown; delta: number }[] = [];
  if (stays) {
    if (after !== null) writes.push({ key: after, delta: 0 });
  } else {
    if (before !== undefined && before !== null) writes.push({ key: before, delta: -1 });
    if (after !== undefined && after !== null) writes.push({ key: after, delta: 1 });
  }
  for (const { key, delta } of writes) {
    const set: Assignment[] = [];
    if (effect.counter !== undefined && delta !== 0) {
      set.push({ column: effect.counter.column, add: delta });
    }
    if (effect.touch !== undefined) {
      set.push({ column: effect.touch.column, value: encodeColumn(effect.touch, now) });
    }
    if (set.length === 0) continue;
    const result = await session.run(update(effect.parent.spec.table, set, keyed(effect, key)));
    if (result.affected > 0) {
      session.record(effect.parent, 'update', key as ChangeKey, session.scopeTenant(effect.parent));
    }
  }
}

/**
 * The parents of `child` rows matching `where` through `effect`: their keys,
 * read before a set write changes or deletes the rows.
 */
export async function parentsOfRows(
  session: WriteSession,
  child: ModelCodecs,
  effect: ParentEffect,
  where: Predicate,
): Promise<unknown[]> {
  const result = await session.run(
    select(table(child.spec.table), {
      columns: [{ column: col(child.spec.table, effect.fk.column), as: effect.fk.column }],
      distinct: true,
      ...(where.op === 'true' ? {} : { where }),
    }),
  );
  const keys: unknown[] = [];
  for (const row of result.rows) {
    const value = row[effect.fk.column];
    if (value === null || value === undefined) continue;
    keys.push(decodeColumn(effect.fk, value));
  }
  return keys;
}

/** The distinct, non-null values of `keys`. */
function distinctKeys(keys: readonly unknown[]): unknown[] {
  const distinct: unknown[] = [];
  for (const key of keys) {
    if (key === null || key === undefined) continue;
    if (!distinct.some((seen) => sameValue(seen, key))) distinct.push(key);
  }
  return distinct;
}

/** Recount and touch the parents `keys` of `child` through `effect`. */
export async function recountParents(
  session: WriteSession,
  child: ModelCodecs,
  effect: ParentEffect,
  keys: readonly unknown[],
  now: Date,
): Promise<void> {
  const parents = distinctKeys(keys);
  if (parents.length === 0) return;
  const parentTable = effect.parent.spec.table;
  const set: Assignment[] = [];
  if (effect.counter !== undefined) {
    set.push({
      column: effect.counter.column,
      select: select(table(child.spec.table, COUNTED), {
        columns: [{ aggregate: 'count', as: 'jsails_count' }],
        where: compareColumns(
          col(COUNTED, effect.fk.column),
          '=',
          col(parentTable, effect.parentKey.column),
        ),
      }),
    });
  }
  if (effect.touch !== undefined) {
    set.push({ column: effect.touch.column, value: encodeColumn(effect.touch, now) });
  }
  if (set.length === 0) return;
  const chunk = BIND_LIMITS[session.context.catalog.dialect] - RECOUNT_SPARE_PARAMETERS;
  for (let start = 0; start < parents.length; start += chunk) {
    const slice = parents.slice(start, start + chunk);
    const statement: Statement = update(
      parentTable,
      set,
      inList(
        col(parentTable, effect.parentKey.column),
        slice.map((key) => encodeColumn(effect.parentKey, key)),
      ),
    );
    const result = await session.run(statement);
    if (result.affected === 0) continue;
    const tenant = session.scopeTenant(effect.parent);
    for (const key of slice) session.record(effect.parent, 'update', key as ChangeKey, tenant);
  }
}
