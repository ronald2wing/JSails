/**
 * Relation filters: the correlated `EXISTS` subquery behind `whereHas` and
 * `has`. A relation is followed by the keys its declaration names:
 *
 * - `belongsTo`: `target.pk = outer.fk` (a polymorphic one has no single
 *   target table and is refused);
 * - `hasMany`/`hasOne` with an `inverse`: `target.fk = outer.pk`, or the
 *   inverse's type and id pair for a polymorphic inverse;
 * - a `through` relation whose `through` and `source` legs are direct
 *   relations: the link table joined to the target, correlated to the outer
 *   row through the link.
 *
 * The target's conditions arrive qualified by the target's table name. When
 * that name is already the outer query's (a self relation), or the link's,
 * the target is read under a fresh alias and its conditions are renamed to
 * it (`requalify.ts`). A count bound (`has`) is an `OFFSET` on the subquery:
 * `EXISTS (... LIMIT 1 OFFSET n - 1)` holds exactly when at least `n` rows
 * match, and stops reading after the `n`th.
 */

import type { ModelCodecs } from '../codec/model-codecs.js';
import type { Join, Predicate } from '../engine/statement.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { and, col, compareColumns, eq, exists, select, table } from '../statement/builders.js';
import type { StatementCatalog } from '../statement/statement-catalog.js';
import { StatementErrors } from '../statement/statement-errors.js';
import { QueryErrors } from './query-errors.js';
import { freshAlias, namesIn, requalify } from './requalify.js';

/** How one direct relation joins its two tables. */
type DirectLink =
  /** The near table holds the foreign key: `far.farColumn = near.nearColumn`. */
  | {
      readonly kind: 'columns';
      readonly nearColumn: string;
      readonly farColumn: string;
    }
  /** The far table holds a polymorphic pair pointing at the near table. */
  | {
      readonly kind: 'polymorphic';
      readonly nearColumn: string;
      readonly farType: string;
      readonly farId: string;
      readonly typeValue: string;
    };

/** A relation resolved to the tables and keys a subquery needs. */
export interface ResolvedRelation {
  readonly owner: ModelCodecs;
  readonly name: string;
  readonly target: ModelCodecs;
  /** The link table of a through relation, and how it reaches the owner. */
  readonly link?: { readonly codecs: ModelCodecs; readonly toOwner: DirectLink };
  /** How the target reaches the owner, or the link for a through relation. */
  readonly toNear: DirectLink;
}

function singleKey(codecs: ModelCodecs, owner: ModelCodecs, relation: string): string {
  const keys = codecs.spec.primaryKey;
  const property = keys[0];
  const column = property === undefined ? undefined : codecs.property(property);
  if (keys.length !== 1 || column === undefined) {
    throw new QueryErrors.Error('unsupported_relation', {
      model: owner.spec.name,
      relation,
    });
  }
  return column.column;
}

function codecsOf(
  catalog: StatementCatalog,
  target: ModelTarget,
  owner: ModelCodecs,
  relation: string,
): ModelCodecs {
  const definition = modelDefinition(target);
  if (definition === undefined) {
    throw new QueryErrors.Error('unsupported_relation', { model: owner.spec.name, relation });
  }
  if (!catalog.has(definition.spec.table)) {
    throw new StatementErrors.Error('unknown_table', { table: definition.spec.table });
  }
  return catalog.codecs(target);
}

/** A direct relation of `near`: its far side and how the two join. */
function direct(
  catalog: StatementCatalog,
  near: ModelCodecs,
  name: string,
  reported: ModelCodecs,
  reportedName: string,
): { readonly far: ModelCodecs; readonly link: DirectLink } {
  const relation = near.spec.relations[name];
  if (relation === undefined) {
    throw new QueryErrors.Error('unknown_relation', { model: near.spec.name, relation: name });
  }
  const unsupported = (): never => {
    throw new QueryErrors.Error('unsupported_relation', {
      model: reported.spec.name,
      relation: reportedName,
    });
  };
  if (relation.kind === 'belongsTo') {
    if (!('target' in relation)) return unsupported();
    const far = codecsOf(catalog, relation.target(), reported, reportedName);
    const fk = near.spec.columns.find(
      (column) => column.relation === name && column.origin === 'foreign-key',
    );
    if (fk === undefined) return unsupported();
    return {
      far,
      link: { kind: 'columns', nearColumn: fk.column, farColumn: singleKey(far, reported, name) },
    };
  }
  if ('through' in relation) return unsupported();
  const far = codecsOf(catalog, relation.target(), reported, reportedName);
  const inverse = relation.inverse;
  const columns = far.spec.columns.filter((column) => column.relation === inverse);
  const nearKey = singleKey(near, reported, reportedName);
  const fk = columns.find((column) => column.origin === 'foreign-key');
  if (fk !== undefined) {
    return { far, link: { kind: 'columns', nearColumn: nearKey, farColumn: fk.column } };
  }
  const type = columns.find((column) => column.origin === 'polymorphic-type');
  const id = columns.find((column) => column.origin === 'polymorphic-id');
  if (type === undefined || id === undefined) return unsupported();
  return {
    far,
    link: {
      kind: 'polymorphic',
      nearColumn: nearKey,
      farType: type.column,
      farId: id.column,
      typeValue: near.spec.name,
    },
  };
}

/**
 * Resolve relation `name` of `owner` against `catalog`.
 *
 * @throws `query.unknown_relation`, `query.unsupported_relation`, and
 *   `statement.unknown_table` for a target outside the catalog.
 */
export function resolveRelation(
  catalog: StatementCatalog,
  owner: ModelCodecs,
  name: string,
): ResolvedRelation {
  const relation = owner.spec.relations[name];
  if (relation === undefined) {
    throw new QueryErrors.Error('unknown_relation', { model: owner.spec.name, relation: name });
  }
  if ('through' in relation) {
    const through = relation;
    const first = direct(catalog, owner, through.through, owner, name);
    const second = direct(catalog, first.far, through.source, owner, name);
    return Object.freeze({
      owner,
      name,
      target: second.far,
      link: Object.freeze({ codecs: first.far, toOwner: first.link }),
      toNear: second.link,
    });
  }
  const resolved = direct(catalog, owner, name, owner, name);
  return Object.freeze({ owner, name, target: resolved.far, toNear: resolved.link });
}

/** The condition joining `far` (qualifier) to `near` (qualifier) through `link`. */
function joinCondition(link: DirectLink, near: string, far: string): Predicate {
  if (link.kind === 'columns') {
    return compareColumns(col(far, link.farColumn), '=', col(near, link.nearColumn));
  }
  return and(
    eq(col(far, link.farType), link.typeValue),
    compareColumns(col(far, link.farId), '=', col(near, link.nearColumn)),
  );
}

/** Options of {@link relationExists}. */
export interface RelationExistsOptions {
  /** The outer query's qualifier for the owner's table. */
  readonly outer: string;
  /** Conditions on the target, qualified by the target's table name. */
  readonly filter: Predicate;
  /** Hold only when more than this many target rows match (a `has` bound). */
  readonly skip?: number;
}

/** `EXISTS (SELECT ... )` over `relation` correlated to the outer row. */
export function relationExists(
  relation: ResolvedRelation,
  options: RelationExistsOptions,
): Predicate {
  const { outer } = options;
  const taken = namesIn(options.filter, new Set([outer]));
  const targetTable = relation.target.spec.table;
  const linkTable = relation.link?.codecs.spec.table;
  let linkName: string | undefined;
  if (linkTable !== undefined) {
    linkName =
      linkTable === outer || linkTable === targetTable ? freshAlias(linkTable, taken) : linkTable;
    taken.add(linkName);
  }
  const targetName =
    targetTable === outer || targetTable === linkName
      ? freshAlias(targetTable, taken)
      : targetTable;
  const filter = requalify(options.filter, targetTable, targetName);
  const targetRef = table(targetTable, targetName === targetTable ? undefined : targetName);
  const page: { readonly limit?: number; readonly offset?: number } =
    options.skip === undefined || options.skip === 0 ? {} : { limit: 1, offset: options.skip };
  if (relation.link === undefined || linkTable === undefined || linkName === undefined) {
    return exists(
      select(targetRef, {
        where: and(joinCondition(relation.toNear, outer, targetName), filter),
        ...page,
      }),
    );
  }
  const joined: Join = {
    kind: 'inner',
    table: targetRef,
    on: joinCondition(relation.toNear, linkName, targetName),
  };
  return exists(
    select(table(linkTable, linkName === linkTable ? undefined : linkName), {
      joins: [joined],
      where: and(joinCondition(relation.link.toOwner, outer, linkName), filter),
      ...page,
    }),
  );
}
