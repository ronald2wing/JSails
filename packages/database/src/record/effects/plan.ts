/**
 * The effect plan: what a write of one model must do beyond its own
 * statement, compiled once per model and data source from the spec, the
 * hooks and validation `defineModel` was given, and the foreign-key actions
 * the schema declares. It is plain data keyed by primary-key metadata (no
 * column name is assumed), and the pipeline and the set writes read it:
 *
 * - `parents`: each `belongsTo` with a `counterCache` or `touch` on its
 *   target (`counter-cache.ts`, `touch.ts`).
 * - `dependents`: each `dependent` of a `hasMany`/`hasOne`, and each
 *   `belongsTo` of another model that declares `onDelete: 'cascade'` or
 *   `'set null'` towards this one with no such inverse (the same work, a
 *   destroy or a nullify, declared from the child's side), with the form
 *   that deletes or nullifies its rows (`dependent.ts`):
 *   `database` when the foreign-key action is the whole work (nullify of a
 *   child without `lockVersion`; destroy of a child whose delete plan is
 *   empty), `statement` for one condition-shaped statement (a polymorphic
 *   child, which has no foreign key, or a nullify that must bump the child's
 *   `lockVersion`), and `records` when each child must be destroyed through
 *   the pipeline.
 * - `autosave`: each relation with `autosave` (`autosave.ts`).
 * - `attachments`: the model's named attachments (`attachments.ts`).
 * - `cascades`: every model whose rows a database foreign-key action changes
 *   when rows of this model are deleted (through `cascade` actions,
 *   transitively), less the dependents the pipeline handles itself, so the
 *   delete reports them as `invalidate`; `actionCascades` is the whole
 *   closure, for a set delete that skips its effects and leaves every
 *   dependent to the database.
 *
 * A relation whose target the data source does not list has no effect: the
 * data source cannot reach that table, and a database foreign-key action on
 * it still applies.
 *
 * A child's delete plan is empty when deleting a child runs nothing: no
 * delete hook or `afterCommit`, no attachment, no counter cache or touch on
 * another relation than the one being cascaded, and every dependent of its
 * own lowered to the foreign-key action. Emptiness is computed as a greatest
 * fixed point over the data source's models, so a cycle (a self relation)
 * lowers to the database action unless something in it needs the pipeline.
 */

import type { CodecColumn, ModelCodecs } from '../../codec/model-codecs.js';
import { modelDefinition } from '../../model/define-model.js';
import type { ModelTarget } from '../../model/model-spec.js';
import { physicalTable } from '../../model/physical-table.js';
import type { StatementCatalog } from '../../statement/statement-catalog.js';
import { runsRecordLogic, type StoredBehavior } from '../hooks.js';

/** A `belongsTo` whose target row this model's writes keep up to date. */
export interface ParentEffect {
  readonly relation: string;
  /** The foreign key on this model. */
  readonly fk: CodecColumn;
  readonly parent: ModelCodecs;
  /** The parent's one-column primary key. */
  readonly parentKey: CodecColumn;
  /** The parent's integer column counting this model's rows. */
  readonly counter: CodecColumn | undefined;
  /** The parent's timestamp set to now when a row of this model is written. */
  readonly touch: CodecColumn | undefined;
}

/** How a child row points at its owner. */
export type ChildLink =
  | { readonly kind: 'fk'; readonly fk: CodecColumn }
  | {
      readonly kind: 'polymorphic';
      readonly type: CodecColumn;
      readonly id: CodecColumn;
      /** The owner's model name, as the type column stores it. */
      readonly typeValue: string;
    };

/** How a dependent's rows are deleted or nullified. */
export type DependentForm = 'database' | 'statement' | 'records';

/** A `dependent` of a `hasMany`/`hasOne`. */
export interface DependentEffect {
  /** The model whose rows' deletion the dependent follows. */
  readonly owner: ModelCodecs;
  /**
   * The owner's relation that declares `dependent`, or `undefined` when only
   * the child's `belongsTo` declares the action (`onDelete`).
   */
  readonly relation: string | undefined;
  readonly kind: 'destroy' | 'nullify';
  readonly child: ModelCodecs;
  /** The child's `belongsTo` that points back. */
  readonly inverse: string;
  readonly link: ChildLink;
  /** This model's one-column primary key, which the child's key holds. */
  readonly ownerKey: CodecColumn;
  readonly form: DependentForm;
}

/** A relation saved with the record that holds it. */
export type AutosaveEffect =
  | {
      readonly kind: 'belongsTo';
      readonly relation: string;
      readonly target: ModelCodecs;
      readonly fk: CodecColumn;
      readonly targetKey: CodecColumn;
    }
  | {
      readonly kind: 'hasMany' | 'hasOne';
      readonly relation: string;
      readonly target: ModelCodecs;
      readonly link: ChildLink;
      readonly ownerKey: CodecColumn;
    };

/** What a write of one model must do beyond its own statement. */
export interface EffectPlan {
  readonly codecs: ModelCodecs;
  readonly behavior: StoredBehavior | undefined;
  readonly primaryKey: readonly CodecColumn[];
  readonly lockVersion: CodecColumn | undefined;
  readonly tenant: CodecColumn | undefined;
  readonly parents: readonly ParentEffect[];
  readonly dependents: readonly DependentEffect[];
  readonly autosave: readonly AutosaveEffect[];
  readonly attachments: readonly string[];
  readonly cascades: readonly ModelCodecs[];
  readonly actionCascades: readonly ModelCodecs[];
}

interface Draft {
  readonly codecs: ModelCodecs;
  readonly behavior: StoredBehavior | undefined;
  readonly parents: ParentEffect[];
  readonly dependents: { effect: Omit<DependentEffect, 'form'>; form: DependentForm }[];
  readonly autosave: AutosaveEffect[];
}

const PLANS = new WeakMap<StatementCatalog, ReadonlyMap<ModelTarget, EffectPlan>>();

function column(codecs: ModelCodecs, property: string): CodecColumn {
  return codecs.property(property) as CodecColumn;
}

function singleKey(codecs: ModelCodecs): CodecColumn | undefined {
  const keys = codecs.spec.primaryKey;
  return keys.length === 1 ? column(codecs, keys[0] as string) : undefined;
}

function relationColumn(
  codecs: ModelCodecs,
  relation: string,
  origin: 'foreign-key' | 'polymorphic-type' | 'polymorphic-id',
): CodecColumn | undefined {
  const resolved = codecs.spec.columns.find(
    (candidate) => candidate.relation === relation && candidate.origin === origin,
  );
  return resolved === undefined ? undefined : column(codecs, resolved.property);
}

/** How `child` points back at `owner` through its relation `inverse`. */
function childLink(child: ModelCodecs, inverse: string, owner: ModelCodecs): ChildLink | undefined {
  const fk = relationColumn(child, inverse, 'foreign-key');
  if (fk !== undefined) return { kind: 'fk', fk };
  const type = relationColumn(child, inverse, 'polymorphic-type');
  const id = relationColumn(child, inverse, 'polymorphic-id');
  if (type === undefined || id === undefined) return undefined;
  return { kind: 'polymorphic', type, id, typeValue: owner.spec.name };
}

function draft(catalog: StatementCatalog, target: ModelTarget): Draft {
  const known = new Set(catalog.models);
  const codecs = catalog.codecs(target);
  const result: Draft = {
    codecs,
    behavior: modelDefinition(target)?.behavior,
    parents: [],
    dependents: [],
    autosave: [],
  };
  for (const [name, relation] of Object.entries(codecs.spec.relations)) {
    if (relation.kind === 'belongsTo') {
      if (!('target' in relation)) continue;
      const parentTarget = relation.target();
      if (!known.has(parentTarget)) continue;
      const parent = catalog.codecs(parentTarget);
      const fk = relationColumn(codecs, name, 'foreign-key');
      const parentKey = singleKey(parent);
      if (fk === undefined || parentKey === undefined) continue;
      const counter =
        relation.counterCache === undefined ? undefined : column(parent, relation.counterCache);
      const touch = relation.touch === undefined ? undefined : column(parent, relation.touch);
      if (counter !== undefined || touch !== undefined) {
        result.parents.push(
          Object.freeze({ relation: name, fk, parent, parentKey, counter, touch }),
        );
      }
      if (relation.autosave === true) {
        result.autosave.push(
          Object.freeze({
            kind: 'belongsTo',
            relation: name,
            target: parent,
            fk,
            targetKey: parentKey,
          }),
        );
      }
      continue;
    }
    if ('through' in relation) continue;
    const childTarget = relation.target();
    if (!known.has(childTarget)) continue;
    const child = catalog.codecs(childTarget);
    const ownerKey = singleKey(codecs);
    const link = childLink(child, relation.inverse, codecs);
    if (ownerKey === undefined || link === undefined) continue;
    if (relation.dependent !== undefined) {
      result.dependents.push({
        effect: Object.freeze({
          owner: codecs,
          relation: name,
          kind: relation.dependent,
          child,
          inverse: relation.inverse,
          link,
          ownerKey,
        }),
        form: 'database',
      });
    }
    if (relation.autosave === true) {
      result.autosave.push(
        Object.freeze({ kind: relation.kind, relation: name, target: child, link, ownerKey }),
      );
    }
  }
  return result;
}

/**
 * Add a dependent to each owner for every `belongsTo` whose `onDelete` is
 * `cascade` or `set null` and which no `dependent` of the owner covers: the
 * database would otherwise delete or nullify those children without their
 * effects (a counter cache or touch on another parent, attachments, delete
 * hooks, a `lockVersion` bump), whatever their plan holds.
 */
function addDeclaredActions(drafts: ReadonlyMap<ModelTarget, Draft>): void {
  for (const child of drafts.values()) {
    for (const [name, relation] of Object.entries(child.codecs.spec.relations)) {
      if (relation.kind !== 'belongsTo' || !('target' in relation)) continue;
      if (relation.onDelete !== 'cascade' && relation.onDelete !== 'set null') continue;
      const owner = drafts.get(relation.target());
      const fk = relationColumn(child.codecs, name, 'foreign-key');
      const ownerKey = owner === undefined ? undefined : singleKey(owner.codecs);
      if (owner === undefined || fk === undefined || ownerKey === undefined) continue;
      const covered = owner.dependents.some(
        ({ effect }) => effect.child.target === child.codecs.target && effect.inverse === name,
      );
      if (covered) continue;
      const link: ChildLink = { kind: 'fk', fk };
      owner.dependents.push({
        effect: Object.freeze({
          owner: owner.codecs,
          relation: undefined,
          kind: relation.onDelete === 'cascade' ? 'destroy' : 'nullify',
          child: child.codecs,
          inverse: name,
          link,
          ownerKey,
        }),
        form: 'database',
      });
    }
  }
}

/** Whether deleting a row of `child`, reached through its relation `via`, runs anything. */
function deleteRunsAnything(child: Draft, via: string): boolean {
  if (runsRecordLogic(child.behavior, 'delete')) return true;
  if (Object.keys(child.codecs.spec.attachments).length > 0) return true;
  if (child.parents.some((parent) => parent.relation !== via)) return true;
  return child.dependents.some((dependent) => dependent.form !== 'database');
}

/** The form of each dependent, worsened until no child's emptiness changes. */
function settleForms(drafts: ReadonlyMap<ModelTarget, Draft>): void {
  for (const model of drafts.values()) {
    for (const dependent of model.dependents) {
      const { kind, link, child } = dependent.effect;
      if (link.kind === 'polymorphic') dependent.form = 'statement';
      else if (kind === 'nullify' && child.spec.lockVersion) dependent.form = 'statement';
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const model of drafts.values()) {
      for (const dependent of model.dependents) {
        if (dependent.effect.kind !== 'destroy' || dependent.form === 'records') continue;
        const child = drafts.get(dependent.effect.child.target);
        if (child === undefined || !deleteRunsAnything(child, dependent.effect.inverse)) continue;
        dependent.form = 'records';
        changed = true;
      }
    }
  }
}

/** For each table, the models a foreign-key action changes when its rows are deleted. */
function actionEdges(
  catalog: StatementCatalog,
): ReadonlyMap<string, readonly { readonly model: ModelTarget; readonly cascade: boolean }[]> {
  const edges = new Map<string, { model: ModelTarget; cascade: boolean }[]>();
  for (const model of catalog.models) {
    for (const key of physicalTable(model, catalog.dialect).foreignKeys) {
      if (key.onDelete === 'restrict') continue;
      let list = edges.get(key.referencedTable);
      if (list === undefined) {
        list = [];
        edges.set(key.referencedTable, list);
      }
      list.push({ model, cascade: key.onDelete === 'cascade' });
    }
  }
  return edges;
}

function cascadesOf(
  catalog: StatementCatalog,
  model: Draft,
  edges: ReturnType<typeof actionEdges>,
  all: boolean,
): readonly ModelCodecs[] {
  const handled = new Set(
    all
      ? []
      : model.dependents
          .filter((dependent) => dependent.form !== 'database')
          .map((dependent) => dependent.effect.child.target),
  );
  const reached = new Set<ModelTarget>();
  const visit = (table: string, first: boolean): void => {
    for (const edge of edges.get(table) ?? []) {
      if (first && handled.has(edge.model)) continue;
      if (reached.has(edge.model)) continue;
      reached.add(edge.model);
      if (edge.cascade) visit(catalog.codecs(edge.model).spec.table, false);
    }
  };
  visit(model.codecs.spec.table, true);
  return Object.freeze([...reached].map((target) => catalog.codecs(target)));
}

function compile(catalog: StatementCatalog): ReadonlyMap<ModelTarget, EffectPlan> {
  const drafts = new Map<ModelTarget, Draft>();
  for (const model of catalog.models) drafts.set(model, draft(catalog, model));
  addDeclaredActions(drafts);
  settleForms(drafts);
  const edges = actionEdges(catalog);
  const plans = new Map<ModelTarget, EffectPlan>();
  for (const [target, model] of drafts) {
    const { codecs } = model;
    const spec = codecs.spec;
    plans.set(
      target,
      Object.freeze({
        codecs,
        behavior: model.behavior,
        primaryKey: Object.freeze(spec.primaryKey.map((property) => column(codecs, property))),
        lockVersion: spec.lockVersion ? column(codecs, 'lockVersion') : undefined,
        tenant: spec.tenant === undefined ? undefined : column(codecs, spec.tenant),
        parents: Object.freeze(model.parents),
        dependents: Object.freeze(
          model.dependents.map(({ effect, form }) => Object.freeze({ ...effect, form })),
        ),
        autosave: Object.freeze(model.autosave),
        attachments: Object.freeze(Object.keys(spec.attachments)),
        cascades: cascadesOf(catalog, model, edges, false),
        actionCascades: cascadesOf(catalog, model, edges, true),
      }),
    );
  }
  return plans;
}

/**
 * The effect plan of `codecs`' model in `catalog`, the full catalog of its
 * data source. Every model's plan is compiled on the first call.
 */
export function effectPlan(catalog: StatementCatalog, codecs: ModelCodecs): EffectPlan {
  let plans = PLANS.get(catalog);
  if (plans === undefined) {
    plans = compile(catalog);
    PLANS.set(catalog, plans);
  }
  return plans.get(codecs.target) as EffectPlan;
}
