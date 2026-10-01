/**
 * Autosave: relations declared `autosave: true` are saved with the record
 * that holds them, through the pipeline (their own hooks, validation and
 * effects run), in the owner's transaction.
 *
 * - A `belongsTo` target set on the owner is saved first, when it is new or
 *   changed, and its key copied into the owner's foreign key, so the owner's
 *   write names it.
 * - The records of an inverse `hasMany` (an array) or `hasOne` set on the
 *   owner are saved after the owner, with their foreign key (and the type
 *   of a polymorphic one) pointing at it; only new or changed ones are
 *   written.
 *
 * The relation is what the owner holds (`heldRelation`: loaded or
 * assigned); a relation it does not hold, or `null`, means nothing to save.
 * A set write holds no instances, so autosave never applies to one.
 *
 * Autosave never undoes a key the application changed. A record the
 * application assigned to the relation (or added to a loaded array) states
 * the link, and its key is written. A record the relation held as loaded
 * (`loadedMember`) only follows a key change of the record it points at
 * (a target's or an owner's primary key changing in the same save): when
 * its key no longer names that record as stored, the application moved it,
 * and the key is left as set. Once the keys are written the relation is
 * settled as loaded (undone on rollback), so a later key change is kept too.
 */

import { recordState } from '../../codec/hydrate.js';
import { modelDefinition } from '../../model/define-model.js';
import { heldRelation, loadedMember, settleRelation } from '../../relation/relation-state.js';
import { RecordErrors } from '../record-errors.js';
import { changedColumns, sameValue } from '../record-values.js';
import type { AutosaveEffect, ChildLink, EffectPlan } from './plan.js';
import type { WriteSession } from './write-session.js';

/** Saves one related record within the owner's write. */
export type SaveRelated = (record: object) => Promise<void>;

function related(plan: EffectPlan, effect: AutosaveEffect, value: unknown): readonly object[] {
  if (value === undefined || value === null) return [];
  const invalid = (): never => {
    throw new RecordErrors.Error('invalid_relation', {
      model: plan.codecs.spec.name,
      relation: effect.relation,
    });
  };
  if (effect.kind === 'hasMany' && !Array.isArray(value)) return invalid();
  const items: readonly unknown[] = effect.kind === 'hasMany' ? (value as unknown[]) : [value];
  for (const item of items) {
    const target =
      item !== null && typeof item === 'object'
        ? (item as { readonly constructor?: unknown }).constructor
        : undefined;
    if (target !== effect.target.target || modelDefinition(target) === undefined) {
      invalid();
    }
  }
  return items as readonly object[];
}

/**
 * Whether saving `record` of `plan`'s model must write it: it is new, a
 * column changed, or an autosave relation of its own has work. `seen` stops
 * a cycle of relations.
 */
export function needsSave(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  seen: Set<object>,
): boolean {
  if (seen.has(record)) return false;
  seen.add(record);
  const state = recordState(record);
  if (state === undefined || !state.persisted) return true;
  if (changedColumns(plan.codecs, record, state).length > 0) return true;
  return autosaveHasWork(session, plan, record, seen);
}

/** Whether `child` already points at the owner whose key is `key` through `link`. */
function pointsAt(child: object, link: ChildLink, key: unknown): boolean {
  const values = child as Record<string, unknown>;
  if (key === undefined || key === null) return false;
  if (link.kind === 'fk') return sameValue(values[link.fk.property], key);
  return values[link.type.property] === link.typeValue && sameValue(values[link.id.property], key);
}

/** The value of `property` stored for `record`, or `undefined` for a new one. */
function storedValue(record: object, property: string): unknown {
  const state = recordState(record);
  return state?.persisted === true ? state.baseline[property] : undefined;
}

/**
 * Whether the foreign key of `record` takes the key of `target`: the
 * relation was assigned, or it was loaded and the key still names the
 * target as stored. Read before the target is saved.
 */
function followsTarget(
  record: object,
  effect: Extract<AutosaveEffect, { kind: 'belongsTo' }>,
  target: object,
): boolean {
  if (!loadedMember(record, effect.relation, target)) return true;
  const stored = storedValue(target, effect.targetKey.property);
  const fk = (record as Record<string, unknown>)[effect.fk.property];
  return stored !== undefined && sameValue(fk, stored);
}

/**
 * Whether `child` is pointed at its owner `record`: it was assigned or
 * added, or it was loaded and still points at the owner's key `before` the
 * save.
 */
function followsOwner(
  record: object,
  effect: Extract<AutosaveEffect, { kind: 'hasMany' | 'hasOne' }>,
  child: object,
  before: unknown,
): boolean {
  return !loadedMember(record, effect.relation, child) || pointsAt(child, effect.link, before);
}

/**
 * Whether an autosave relation of `record` has work: a related record that
 * must be saved, a `belongsTo` target whose key the foreign key must take
 * and does not hold yet, or a child that must point at `record` and does not
 * yet (an existing record moved to it), each of which writes a row.
 */
export function autosaveHasWork(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  seen: Set<object>,
): boolean {
  const values = record as Record<string, unknown>;
  for (const effect of plan.autosave) {
    const items = related(plan, effect, heldRelation(record, effect.relation));
    const childPlan = session.plan(effect.target);
    for (const item of items) {
      if (effect.kind === 'belongsTo') {
        const key = (item as Record<string, unknown>)[effect.targetKey.property];
        const moves = !sameValue(values[effect.fk.property], key);
        if (moves && followsTarget(record, effect, item)) return true;
      } else {
        const key = values[effect.ownerKey.property];
        const before = storedValue(record, effect.ownerKey.property) ?? key;
        if (!pointsAt(item, effect.link, key) && followsOwner(record, effect, item, before)) {
          return true;
        }
      }
      if (needsSave(session, childPlan, item, seen)) return true;
    }
  }
  return false;
}

/**
 * Save the `belongsTo` targets of `record` and point its foreign keys at the
 * ones it follows (`followsTarget`).
 */
export async function saveTargets(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  save: SaveRelated,
): Promise<void> {
  for (const effect of plan.autosave) {
    if (effect.kind !== 'belongsTo') continue;
    const [target] = related(plan, effect, heldRelation(record, effect.relation));
    if (target === undefined) continue;
    const follows = followsTarget(record, effect, target);
    if (needsSave(session, session.plan(effect.target), target, new Set())) await save(target);
    if (!follows) continue;
    (record as Record<string, unknown>)[effect.fk.property] = (target as Record<string, unknown>)[
      effect.targetKey.property
    ];
    session.onRollback(settleRelation(record, effect.relation));
  }
}

function pointAt(child: object, link: ChildLink, key: unknown): void {
  const values = child as Record<string, unknown>;
  if (link.kind === 'fk') {
    values[link.fk.property] = key;
    return;
  }
  values[link.type.property] = link.typeValue;
  values[link.id.property] = key;
}

/**
 * Point the inverse children of the saved `record` that follow it
 * (`followsOwner`) at it, and save those with work. `before` is the
 * record's stored values before its write, `undefined` for an insert.
 */
export async function saveChildren(
  session: WriteSession,
  plan: EffectPlan,
  record: object,
  before: Readonly<Record<string, unknown>> | undefined,
  save: SaveRelated,
): Promise<void> {
  for (const effect of plan.autosave) {
    if (effect.kind === 'belongsTo') continue;
    const children = related(plan, effect, heldRelation(record, effect.relation));
    if (children.length === 0) continue;
    const key = (record as Record<string, unknown>)[effect.ownerKey.property];
    const previous = before === undefined ? key : before[effect.ownerKey.property];
    const childPlan = session.plan(effect.target);
    for (const child of children) {
      if (followsOwner(record, effect, child, previous)) pointAt(child, effect.link, key);
      if (needsSave(session, childPlan, child, new Set())) await save(child);
    }
    session.onRollback(settleRelation(record, effect.relation));
  }
}
