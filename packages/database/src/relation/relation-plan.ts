/**
 * A relation resolved to what loading it needs: which property of a parent
 * holds the key, which column of which table the key is matched against (and
 * grouped by, since the row carries it), the type condition of a
 * polymorphic side, and the link table a through relation joins.
 *
 * - `belongsTo`: the parent's foreign key, matched against the target's
 *   primary key.
 * - `hasMany`/`hasOne` with an inverse: the parent's primary key, matched
 *   against the target's foreign key (and its type column, for a
 *   polymorphic inverse).
 * - A through relation: the parent's side of the first leg, matched against
 *   the link's column (the link's owner key), with the target joined to the
 *   link by the second leg.
 * - A polymorphic `belongsTo` has no single target: its plan names the
 *   parent's type and id properties, and each distinct type becomes a
 *   `belongsTo` plan of its own at load time ({@link polymorphicTarget}).
 *
 * Direct and through relations are resolved by the same code as the
 * relation filters (`query/relation-filter.ts`), so a relation that can be
 * filtered on can be loaded, and the same refusals apply.
 */

import type { CodecColumn, ModelCodecs } from '../codec/model-codecs.js';
import type { Predicate } from '../engine/statement.js';
import { modelDefinition } from '../model/define-model.js';
import { QueryErrors } from '../query/query-errors.js';
import { resolveRelation, type ResolvedRelation } from '../query/relation-filter.js';
import { freshAlias } from '../query/requalify.js';
import { and, col, compareColumns, eq } from '../statement/builders.js';
import type { StatementCatalog } from '../statement/statement-catalog.js';
import { RelationErrors } from './relation-errors.js';

/** A column of the statement a load runs, with the qualifier it is read under. */
export interface QualifiedColumn {
  readonly qualifier: string;
  readonly column: CodecColumn;
}

/** A relation with one target model, resolved for loading. */
export interface LoadPlan {
  readonly kind: 'belongsTo' | 'hasMany' | 'hasOne';
  readonly owner: ModelCodecs;
  readonly name: string;
  readonly target: ModelCodecs;
  /** Whether the relation holds a list (`hasMany`) or one record or `null`. */
  readonly many: boolean;
  /** The parent property holding the key. */
  readonly parentKey: CodecColumn;
  /** The column the keys are matched against and the loaded rows grouped by. */
  readonly match: QualifiedColumn;
  /** The type condition of a polymorphic side: `qualifier.column = value`. */
  readonly type?: { readonly qualifier: string; readonly column: string; readonly value: string };
  /** The link table of a through relation, under `alias`, joined to the target by `on`. */
  readonly link?: { readonly codecs: ModelCodecs; readonly alias: string; readonly on: Predicate };
}

/** A polymorphic `belongsTo`: the parent's type and id properties. */
export interface PolymorphicPlan {
  readonly kind: 'polymorphic';
  readonly owner: ModelCodecs;
  readonly name: string;
  readonly typeColumn: CodecColumn;
  readonly idColumn: CodecColumn;
}

/** A relation resolved for loading. */
export type RelationPlan = LoadPlan | PolymorphicPlan;

type DirectLink = ResolvedRelation['toNear'];

/** Which relation a plan is for, as refusals report it. */
interface Reported {
  readonly model: string;
  readonly relation: string;
}

function columnOf(codecs: ModelCodecs, physical: string, reported: Reported): CodecColumn {
  const column = codecs.columns.find((candidate) => candidate.column === physical);
  if (column === undefined) throw new QueryErrors.Error('unsupported_relation', reported);
  return column;
}

/** The single primary-key column of `codecs`, or a refusal naming `owner.relation`. */
function singleKey(codecs: ModelCodecs, owner: ModelCodecs, relation: string): CodecColumn {
  const [property, ...rest] = codecs.spec.primaryKey;
  const column = property === undefined ? undefined : codecs.property(property);
  if (column === undefined || rest.length > 0) {
    throw new QueryErrors.Error('unsupported_relation', { model: owner.spec.name, relation });
  }
  return column;
}

/** The parent key and matched column of a direct link from `near` (the parent side) to `far`. */
function keyed(
  link: DirectLink,
  near: ModelCodecs,
  far: ModelCodecs,
  farQualifier: string,
  reported: Reported,
): Pick<LoadPlan, 'parentKey' | 'match' | 'type'> {
  const parentKey = columnOf(near, link.nearColumn, reported);
  if (link.kind === 'columns') {
    return {
      parentKey,
      match: { qualifier: farQualifier, column: columnOf(far, link.farColumn, reported) },
    };
  }
  return {
    parentKey,
    match: { qualifier: farQualifier, column: columnOf(far, link.farId, reported) },
    type: { qualifier: farQualifier, column: link.farType, value: link.typeValue },
  };
}

/** The join condition of the target (under its table name) to the link (under `alias`). */
function linkJoin(link: DirectLink, targetTable: string, alias: string): Predicate {
  if (link.kind === 'columns') {
    return compareColumns(col(targetTable, link.farColumn), '=', col(alias, link.nearColumn));
  }
  return and(
    eq(col(targetTable, link.farType), link.typeValue),
    compareColumns(col(targetTable, link.farId), '=', col(alias, link.nearColumn)),
  );
}

/**
 * Resolve relation `name` of `owner` for loading.
 *
 * @throws `query.unknown_relation`, `query.unsupported_relation` (a
 *   composite key on the matched side, a through relation over another
 *   through relation or a polymorphic leg), and `statement.unknown_table`
 *   for a target outside the catalog.
 */
export function resolveLoadPlan(
  catalog: StatementCatalog,
  owner: ModelCodecs,
  name: string,
): RelationPlan {
  const relation = Object.hasOwn(owner.spec.relations, name)
    ? owner.spec.relations[name]
    : undefined;
  if (relation === undefined) {
    throw new QueryErrors.Error('unknown_relation', { model: owner.spec.name, relation: name });
  }
  const reported: Reported = { model: owner.spec.name, relation: name };
  if (relation.kind === 'belongsTo' && 'polymorphic' in relation) {
    const columns = owner.spec.columns.filter((column) => column.relation === name);
    const type = columns.find((column) => column.origin === 'polymorphic-type');
    const id = columns.find((column) => column.origin === 'polymorphic-id');
    if (type === undefined || id === undefined) {
      throw new QueryErrors.Error('unsupported_relation', reported);
    }
    return Object.freeze({
      kind: 'polymorphic',
      owner,
      name,
      typeColumn: columnOf(owner, type.column, reported),
      idColumn: columnOf(owner, id.column, reported),
    });
  }
  const resolved = resolveRelation(catalog, owner, name);
  const target = resolved.target;
  const targetTable = target.spec.table;
  if (resolved.link === undefined) {
    return Object.freeze({
      kind: relation.kind,
      owner,
      name,
      target,
      many: relation.kind === 'hasMany',
      ...keyed(resolved.toNear, owner, target, targetTable, reported),
    });
  }
  const linkCodecs = resolved.link.codecs;
  const linkTable = linkCodecs.spec.table;
  const alias =
    linkTable === targetTable ? freshAlias(linkTable, new Set([targetTable])) : linkTable;
  return Object.freeze({
    kind: relation.kind,
    owner,
    name,
    target,
    many: relation.kind === 'hasMany',
    ...keyed(resolved.link.toOwner, owner, linkCodecs, alias, reported),
    link: Object.freeze({
      codecs: linkCodecs,
      alias,
      on: linkJoin(resolved.toNear, targetTable, alias),
    }),
  });
}

/**
 * The `belongsTo` plan of a polymorphic relation for parents whose type
 * column names `type`: the model of that name in the catalog, matched by its
 * primary key.
 *
 * @throws `relation.unknown_target` when no model of the catalog has that
 *   name, `query.unsupported_relation` for a target with a composite key.
 */
export function polymorphicTarget(
  catalog: StatementCatalog,
  plan: PolymorphicPlan,
  type: string,
): LoadPlan {
  const model = catalog.models.find((candidate) => modelDefinition(candidate)?.spec.name === type);
  if (model === undefined) {
    throw new RelationErrors.Error('unknown_target', {
      model: plan.owner.spec.name,
      relation: plan.name,
    });
  }
  const target = catalog.codecs(model);
  return Object.freeze({
    kind: 'belongsTo',
    owner: plan.owner,
    name: plan.name,
    target,
    many: false,
    parentKey: plan.idColumn,
    match: { qualifier: target.spec.table, column: singleKey(target, plan.owner, plan.name) },
  });
}
