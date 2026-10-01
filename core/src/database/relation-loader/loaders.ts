/**
 * Per-relation-kind batch loaders: M2O, O2M, O2O-owning/inverse, M2M,
 * through, and polymorphic forward/inverse.
 *
 * Each loader follows the same IN-clause batching discipline:
 * collect distinct FK values, query target entities by PK IN, index by PK,
 * and assign back onto parents in place.
 */

import { getMetadataArgsStorage, In } from 'typeorm';
import type { BaseEntity, FindOptionsWhere } from 'typeorm';

import { RelationError, type ResolvedRelation } from '../relation-metadata.js';
import { resolvePolymorphicDescriptor, type PolymorphicDescriptor } from '../polymorphic.js';
import type { RelationLoadOptions } from './load-options.js';
import {
  fkPropertyName,
  resolveTableName,
  selectToObject,
  serializePk,
  deserializeCompositePk,
  validatePolymorphicColumns,
} from './relation-resolution.js';
import {
  assignMany,
  assignOne,
  buildFindOptions,
  collectParentPks,
  firstPairMap,
  groupPairs,
  indexByPk,
} from './batch.js';

// ---------------------------------------------------------------------------
// M2O / O2O-owning loader
// ---------------------------------------------------------------------------

export async function loadManyToOne<T extends object>(
  parents: readonly T[],
  parentEntity: Function,
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const pkColumns = relation.primaryColumns;
  if (pkColumns.length !== 1) {
    throw new RelationError('Composite-key many-to-one loading is not yet supported');
  }

  const pkColProp = pkColumns[0]!;
  const targetRepo = (relation.targetEntity as typeof BaseEntity).getRepository();
  const parentsRepo = (parentEntity as typeof BaseEntity).getRepository();

  // Read the (PK, FK) mapping through the QueryBuilder, because TypeORM does
  // not expose FK values as readable properties on hydrated entity instances.
  // The QueryBuilder delegates identifier quoting to the driver.

  // Collect distinct, non-null parent PKs.
  const parentPkList: unknown[] = [];
  const seenPks = new Set<unknown>();
  for (const parent of parents) {
    const pk = (parent as Record<string, unknown>)[pkColProp];
    if (pk != null && !seenPks.has(pk)) {
      seenPks.add(pk);
      parentPkList.push(pk);
    }
  }

  if (parentPkList.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = null;
    }
    return;
  }

  // Read the (PK, FK) tuples through the QueryBuilder so identifier quoting is
  // delegated to the driver (double quotes on SQLite/Postgres, backticks on
  // MySQL/MariaDB). Hand-built SQL would not be portable across drivers.
  const fkProp = fkPropertyName(parentsRepo, relation.joinColumn!);
  const rawRows: { _pk: unknown; _fk: unknown }[] = await parentsRepo
    .createQueryBuilder('parent')
    .select(`parent.${pkColProp}`, '_pk')
    .addSelect(`parent.${fkProp}`, '_fk')
    .where(`parent.${pkColProp} IN (:...pks)`, { pks: parentPkList })
    .getRawMany();

  // Build PK → FK map and collect distinct FK values.
  const pkToFk = new Map<string, unknown>();
  const fkValueSet = new Set<unknown>();
  for (const row of rawRows) {
    const fk = row._fk;
    pkToFk.set(String(row._pk), fk);
    if (fk != null) fkValueSet.add(fk);
  }

  if (fkValueSet.size === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = null;
    }
    return;
  }

  let fkList = [...fkValueSet];
  if (maxRowsPerRelation !== undefined && fkList.length > maxRowsPerRelation) {
    fkList = fkList.slice(0, maxRowsPerRelation);
  }

  // Load target entities by PK using In().
  const findOptions: Record<string, unknown> = {
    where: {
      [pkColumns[0]!]: In(fkList),
      ...(opts.where ?? {}),
    } satisfies FindOptionsWhere<unknown>,
  };

  if (opts.select && opts.select.length > 0) {
    findOptions.select = selectToObject(opts.select);
  }
  if (opts.order) {
    findOptions.order = opts.order;
  }

  const related = (await targetRepo.find(findOptions)) as unknown as Record<string, unknown>[];

  // Index target entities by serialized PK.
  const index = new Map<string, Record<string, unknown>>();
  for (const row of related) {
    index.set(serializePk(row, pkColumns), row);
  }

  // Assign target entity to each parent using PK → FK → target mapping.
  for (const parent of parents) {
    const pk = (parent as Record<string, unknown>)[pkColProp];
    if (pk == null) {
      (parent as Record<string, unknown>)[relation.propertyName] = null;
      continue;
    }
    const fk = pkToFk.get(String(pk));
    if (fk == null) {
      (parent as Record<string, unknown>)[relation.propertyName] = null;
      continue;
    }
    const pkLookup =
      pkColumns.length === 1 ? { [pkColumns[0]!]: fk } : deserializeCompositePk(fk, pkColumns);
    (parent as Record<string, unknown>)[relation.propertyName] =
      index.get(serializePk(pkLookup, pkColumns)) ?? null;
  }
}

// ---------------------------------------------------------------------------
// O2M loader
// ---------------------------------------------------------------------------

export async function loadOneToMany<T extends object>(
  parents: readonly T[],
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const pkColumns = relation.primaryColumns;
  if (pkColumns.length !== 1) {
    throw new RelationError('Composite-key one-to-many loading is not yet supported');
  }

  const pkColProp = pkColumns[0]!;
  const childRepo = (relation.targetEntity as typeof BaseEntity).getRepository();
  const childPkProp = childRepo.metadata.primaryColumns[0]!.propertyName;

  const pkList = collectParentPks(parents, pkColProp, maxRowsPerRelation);
  if (pkList.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  // Query child rows matching FK IN (parentPKs) through the QueryBuilder so
  // identifier quoting is driver-portable. The FK is addressed by the scalar
  // column that backs the relation; the child PK by its property name.
  const fkProp = fkPropertyName(childRepo, relation.inverseJoinColumn!);
  const rawRows: { _pk: unknown; _fk: unknown }[] = await childRepo
    .createQueryBuilder('child')
    .select(`child.${childPkProp}`, '_pk')
    .addSelect(`child.${fkProp}`, '_fk')
    .where(`child.${fkProp} IN (:...pks)`, { pks: pkList })
    .getRawMany();

  const { groups, targets } = groupPairs(rawRows, '_fk', '_pk');
  if (targets.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  const children = (await childRepo.find(
    buildFindOptions(childPkProp, targets, opts),
  )) as unknown as Record<string, unknown>[];
  assignMany(
    parents,
    relation.propertyName,
    pkColProp,
    groups,
    indexByPk(children, childPkProp),
    opts.limit,
  );
}

// ---------------------------------------------------------------------------
// O2O-inverse loader
// ---------------------------------------------------------------------------

export async function loadOneToOneInverse<T extends object>(
  parents: readonly T[],
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const pkColumns = relation.primaryColumns;
  if (pkColumns.length !== 1) {
    throw new RelationError('Composite-key one-to-one inverse loading is not yet supported');
  }

  const pkColProp = pkColumns[0]!;
  const childRepo = (relation.targetEntity as typeof BaseEntity).getRepository();
  // For O2O inverse, resolveRelation stores the FK column name (from the
  // owning entity's @JoinColumn) in joinColumn, not inverseJoinColumn.
  const childPkProp = childRepo.metadata.primaryColumns[0]!.propertyName;

  const pkList = collectParentPks(parents, pkColProp, maxRowsPerRelation);
  if (pkList.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = null;
    }
    return;
  }

  // Query child rows matching FK IN (parentPKs) through the QueryBuilder so
  // identifier quoting is driver-portable.
  const fkProp = fkPropertyName(childRepo, relation.joinColumn!);
  const rawRows: { _pk: unknown; _fk: unknown }[] = await childRepo
    .createQueryBuilder('child')
    .select(`child.${childPkProp}`, '_pk')
    .addSelect(`child.${fkProp}`, '_fk')
    .where(`child.${fkProp} IN (:...pks)`, { pks: pkList })
    .getRawMany();

  // One child per FK for O2O.
  const fkToChildPk = firstPairMap(rawRows, '_fk', '_pk');
  const allChildPks = [...fkToChildPk.values()];
  if (allChildPks.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = null;
    }
    return;
  }

  const children = (await childRepo.find(
    buildFindOptions(childPkProp, allChildPks, opts),
  )) as unknown as Record<string, unknown>[];
  assignOne(
    parents,
    relation.propertyName,
    pkColProp,
    fkToChildPk,
    indexByPk(children, childPkProp),
  );
}

// ---------------------------------------------------------------------------
// M2M loader
// ---------------------------------------------------------------------------

/**
 * Load a many-to-many relation in exactly two queries: one against the junction
 * table collecting (owner, inverse) pairs, and one against the target entity by
 * PK IN. The junction-table query uses the raw junction table name from
 * {@link ResolvedRelation.junction} — the `@JoinTable` metadata is resolved
 * offline in `resolveRelation`, which already normalises `ownerColumn`/
 * `inverseColumn` so owning and inverse sides follow the same flow.
 *
 * The junction table is queried through the parent repository's
 * `createQueryBuilder().from()` so identifier quoting is delegated to the
 * driver; no raw SQL strings are hand-built.
 */
export async function loadManyToMany<T extends object>(
  parents: readonly T[],
  parentEntity: Function,
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const junction = relation.junction!;
  const targetRepo = (relation.targetEntity as typeof BaseEntity).getRepository();
  const parentsRepo = (parentEntity as typeof BaseEntity).getRepository();

  // Parent PK columns — resolve from the parent repository's metadata so the
  // loader works regardless of PK naming conventions.
  const parentPkCols = parentsRepo.metadata.primaryColumns.map((col) => col.propertyName);
  if (parentPkCols.length !== 1) {
    throw new RelationError('Composite-key many-to-many loading is not yet supported');
  }
  const parentPkProp = parentPkCols[0]!;

  // Target PK columns.
  const targetPkCols = targetRepo.metadata.primaryColumns.map((col) => col.propertyName);
  if (targetPkCols.length !== 1) {
    throw new RelationError('Composite-key many-to-many loading is not yet supported');
  }
  const targetPkProp = targetPkCols[0]!;

  const pkList = collectParentPks(parents, parentPkProp, maxRowsPerRelation);
  if (pkList.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  // Phase 1: query the junction table for (ownerColumn, inverseColumn) pairs.
  // The junction table has no entity repository, so we build a query with
  // `.from()` on the raw table name. Identifier quoting is handled by the
  // driver — column and table references are passed to the query builder as
  // plain strings and the driver escapes them per dialect.
  const qb = parentsRepo.manager.connection.createQueryBuilder();
  qb.select(`jt.${junction.inverseColumn}`, '_inverse')
    .addSelect(`jt.${junction.ownerColumn}`, '_owner')
    .from(junction.table, 'jt')
    .where(`jt.${junction.ownerColumn} IN (:...pks)`, { pks: pkList });

  const jtRows: { _inverse: unknown; _owner: unknown }[] = await qb.getRawMany();
  const { groups: ownerToTargetPks, targets: allTargetPks } = groupPairs(
    jtRows,
    '_owner',
    '_inverse',
  );
  if (allTargetPks.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  // Phase 2: load target entities by PK IN with optional select/where/order.
  const related = (await targetRepo.find(
    buildFindOptions(targetPkProp, allTargetPks, opts),
  )) as unknown as Record<string, unknown>[];
  assignMany(
    parents,
    relation.propertyName,
    parentPkProp,
    ownerToTargetPks,
    indexByPk(related, targetPkProp),
    opts.limit,
  );
}

// ---------------------------------------------------------------------------
// Through-relation loader ("has_many :through")
// ---------------------------------------------------------------------------

/**
 * Load a "has_many :through" relation in exactly two queries: one raw query
 * against the through (intermediate) entity's table collecting (sourceKey,
 * targetKey) pairs, and one {@code find()} on the target entity by PK IN.
 *
 * This is structurally identical to {@link loadManyToMany} but the "junction"
 * table is a real entity (the through entity) rather than an anonymous join
 * table. The {@link ThroughRelation} descriptor carries the DB column names,
 * and the through entity's repository provides the table name.
 *
 * Composite-key and polymorphic through paths are rejected upstream by
 * {@link resolveThroughRelation} before the loader is reached.
 *
 * Total queries = 2 (one raw through-table query + one target find).
 */
export async function loadThroughRelation<T extends object>(
  parents: readonly T[],
  parentEntity: Function,
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const through = relation.through!;
  const parentsRepo = (parentEntity as typeof BaseEntity).getRepository();
  const targetRepo = (relation.targetEntity as typeof BaseEntity).getRepository();

  // Resolve the through entity class from TypeORM metadata by its class name
  // (ThroughRelation.through stores the entity class name, not the table name).
  const storage = getMetadataArgsStorage();
  const throughTableArg = storage.tables.find(
    (t) => typeof t.target === 'function' && t.target.name === through.through,
  );
  if (!throughTableArg || typeof throughTableArg.target !== 'function') {
    throw new RelationError('Through entity not found in registered metadata');
  }
  const throughEntity = throughTableArg.target as typeof BaseEntity;
  const throughRepo = throughEntity.getRepository();

  // Parent PK columns.
  const parentPkCols = parentsRepo.metadata.primaryColumns.map((col) => col.propertyName);
  if (parentPkCols.length !== 1) {
    throw new RelationError('Composite-key through loading is not yet supported');
  }
  const parentPkProp = parentPkCols[0]!;

  // Target PK columns.
  const targetPkCols = targetRepo.metadata.primaryColumns.map((col) => col.propertyName);
  if (targetPkCols.length !== 1) {
    throw new RelationError('Composite-key through-loading target PK is not yet supported');
  }
  const targetPkProp = targetPkCols[0]!;

  const pkList = collectParentPks(parents, parentPkProp, maxRowsPerRelation);
  if (pkList.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  // Phase 1: query the through entity's table for (sourceKey, targetKey) pairs.
  // The through entity has no safe join table abstraction, so we use the raw
  // table name via `.from()` with driver-level identifier quoting.
  const throughTableName = throughRepo.metadata.tableName;
  const qb = parentsRepo.manager.connection.createQueryBuilder();
  qb.select(`jt.${through.targetKey}`, '_target')
    .addSelect(`jt.${through.sourceKey}`, '_owner')
    .from(throughTableName, 'jt')
    .where(`jt.${through.sourceKey} IN (:...pks)`, { pks: pkList });

  const jtRows: { _target: unknown; _owner: unknown }[] = await qb.getRawMany();
  const { groups: ownerToTargetPks, targets: allTargetPks } = groupPairs(
    jtRows,
    '_owner',
    '_target',
  );
  if (allTargetPks.length === 0) {
    for (const parent of parents) {
      (parent as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  // Phase 2: load target entities by PK IN with optional select/where/order.
  const related = (await targetRepo.find(
    buildFindOptions(targetPkProp, allTargetPks, opts),
  )) as unknown as Record<string, unknown>[];
  assignMany(
    parents,
    relation.propertyName,
    parentPkProp,
    ownerToTargetPks,
    indexByPk(related, targetPkProp),
    opts.limit,
  );
}

// ---------------------------------------------------------------------------
// Polymorphic forward loader (child -> parent)
// ---------------------------------------------------------------------------

/**
 * Load the polymorphic forward relation (child -> parent). Groups children by
 * their {@code typeColumn} discriminator value (the target table name), issues
 * one {@code find()} per distinct target table, and stitches results back onto
 * each child via a {@code (type, pk)} index.
 *
 * Total queries = number of distinct target tables present in the batch.
 * An unrecognised type value is harmless — the child gets {@code null}.
 */
export async function loadPolymorphicForward<T extends object>(
  parents: readonly T[],
  _parentEntity: Function,
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const descriptor = relation.polymorphic!;
  const typeCol = descriptor.typeColumn;
  const idCol = descriptor.idColumn;

  // Validate select/where columns against every target entity before any query.
  validatePolymorphicColumns(descriptor, opts);

  // Group children by the discriminator column value. Each distinct value maps
  // to one target table, so one query per group.
  const groups = new Map<string, { ids: unknown[]; children: Record<string, unknown>[] }>();

  for (const parent of parents) {
    const rec = parent as unknown as Record<string, unknown>;
    const typeVal = rec[typeCol];
    const idVal = rec[idCol];

    if (typeVal == null || idVal == null) {
      rec[relation.propertyName] = null;
      continue;
    }
    if (typeof typeVal !== 'string') {
      throw new RelationError('Polymorphic type column value must be a string');
    }

    let group = groups.get(typeVal);
    if (!group) {
      group = { ids: [], children: [] };
      groups.set(typeVal, group);
    }
    group.ids.push(idVal);
    group.children.push(rec);
  }

  if (groups.size === 0) return;

  // Build tableName -> targetClass map from the descriptor so we can resolve
  // each discriminator value to the correct entity repository. Uses
  // repo.metadata.tableName rather than the private resolveTableName helper.
  const tableToClass = new Map<string, Function>();
  for (const targetClass of descriptor.targetClasses) {
    const targetRepo = (targetClass as typeof BaseEntity).getRepository();
    tableToClass.set(targetRepo.metadata.tableName, targetClass);
  }

  // Index: `${typeValue}:${serializedPk}` -> loaded target entity.
  const loadedIndex = new Map<string, Record<string, unknown>>();

  // Query one target table per distinct discriminator value.
  for (const [typeVal, group] of groups) {
    const targetClass = tableToClass.get(typeVal);
    if (!targetClass) {
      // Discriminator value does not match any registered target.
      // Every child in this group gets null.
      for (const child of group.children) {
        child[relation.propertyName] = null;
      }
      continue;
    }

    const targetRepo = (targetClass as typeof BaseEntity).getRepository();
    const targetPkCols = targetRepo.metadata.primaryColumns.map((c) => c.propertyName);

    // The polymorphic idColumn is always a single integer; a composite-PK
    // target would still map through a single FK. For the index we serialise
    // the target's actual PK columns so lookups are stable regardless of PK
    // shape (single or composite).
    let idList = group.ids;
    if (maxRowsPerRelation !== undefined && idList.length > maxRowsPerRelation) {
      idList = idList.slice(0, maxRowsPerRelation);
    }

    const findOpts: Record<string, unknown> = {
      where: {
        [targetPkCols[0]!]: In(idList),
        ...(opts.where ?? {}),
      } satisfies FindOptionsWhere<unknown>,
    };
    if (opts.select && opts.select.length > 0) {
      findOpts.select = selectToObject(opts.select);
    }
    if (opts.order) {
      findOpts.order = opts.order;
    }

    const related = (await targetRepo.find(findOpts)) as unknown as Record<string, unknown>[];

    // Index by `${type}:${serializedPk}` so stitching can match (type, pk)
    // back to the loaded entity regardless of PK column count.
    for (const row of related) {
      const key = `${typeVal}:${serializePk(row, targetPkCols)}`;
      loadedIndex.set(key, row);
    }
  }

  // Stitch: for each child, look up `(typeVal, idVal)` in the loaded index.
  for (const [typeVal, group] of groups) {
    const targetClass = tableToClass.get(typeVal);
    for (const child of group.children) {
      if (!targetClass) {
        child[relation.propertyName] = null;
        continue;
      }
      const idVal = child[idCol];
      const targetRepo = (targetClass as typeof BaseEntity).getRepository();
      const targetPkCols = targetRepo.metadata.primaryColumns.map((c) => c.propertyName);
      const pkObj: Record<string, unknown> = {};
      pkObj[targetPkCols[0]!] = idVal;
      const key = `${typeVal}:${serializePk(pkObj, targetPkCols)}`;
      child[relation.propertyName] = loadedIndex.get(key) ?? null;
    }
  }
}

// ---------------------------------------------------------------------------
// Polymorphic inverse loader (parent -> children)
// ---------------------------------------------------------------------------

/**
 * Load the polymorphic inverse relation (parent -> children). Finds the child
 * entity whose {@link PolymorphicDescriptor} carries a {@code relatedName}
 * matching the property name and whose target classes include the parent's
 * table, then issues ONE {@code find()} on the child table filtered by
 * {@code typeColumn = parentTable AND idColumn IN (parentPks)}.
 *
 * Results are grouped by {@code idColumn} and assigned to parents as arrays.
 */
export async function loadPolymorphicInverseBatched<T extends object>(
  parents: readonly T[],
  parentEntity: Function,
  relation: ResolvedRelation,
  opts: RelationLoadOptions,
  maxRowsPerRelation?: number,
): Promise<void> {
  const parentRepo = (parentEntity as typeof BaseEntity).getRepository();
  const parentTableName = parentRepo.metadata.tableName;
  const parentPkCols = parentRepo.metadata.primaryColumns.map((c) => c.propertyName);

  // Find the child entity whose polymorphic descriptor targets this parent
  // table with the matching relatedName. Scans all registered tables; the
  // descriptor is on the child, not the parent.
  const storage = getMetadataArgsStorage();
  let childClass: Function | undefined;
  let childDescriptor: PolymorphicDescriptor | undefined;

  for (const tableArg of storage.tables) {
    const candidate = tableArg.target;
    if (typeof candidate !== 'function') continue;
    const desc = resolvePolymorphicDescriptor(candidate);
    if (!desc) continue;
    if (desc.relatedName !== relation.propertyName) continue;

    for (const targetClass of desc.targetClasses) {
      if (resolveTableName(targetClass) === parentTableName) {
        childClass = candidate;
        childDescriptor = desc;
        break;
      }
    }
    if (childClass) break;
  }

  if (!childClass || !childDescriptor) {
    // No polymorphic child targets this parent — every parent gets an empty
    // array. This is not an error: a parent may legitimately have no polymorphic
    // children.
    for (const parent of parents) {
      (parent as unknown as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  // Collect distinct, non-null parent PK values.
  const pkValueSet = new Set<unknown>();
  const parentPkProp = parentPkCols[0]!;
  for (const parent of parents) {
    const pk = (parent as unknown as Record<string, unknown>)[parentPkProp];
    if (pk != null) pkValueSet.add(pk);
  }

  if (pkValueSet.size === 0) {
    for (const parent of parents) {
      (parent as unknown as Record<string, unknown>)[relation.propertyName] = [];
    }
    return;
  }

  let pkList = [...pkValueSet];
  if (maxRowsPerRelation !== undefined && pkList.length > maxRowsPerRelation) {
    pkList = pkList.slice(0, maxRowsPerRelation);
  }

  // ONE query: filter child table by type discriminator + parent PKs.
  const childRepo = (childClass as typeof BaseEntity).getRepository();
  const findOpts: Record<string, unknown> = {
    where: {
      [childDescriptor.typeColumn]: parentTableName,
      [childDescriptor.idColumn]: In(pkList),
      ...(opts.where ?? {}),
    } satisfies FindOptionsWhere<unknown>,
  };
  if (opts.select && opts.select.length > 0) {
    // Always include the discriminator columns in the select — the idColumn is
    // needed to group children by parent FK, and stripping it would silently
    // drop every loaded row from the result.
    const merged = new Set(opts.select);
    merged.add(childDescriptor.typeColumn);
    merged.add(childDescriptor.idColumn);
    findOpts.select = selectToObject([...merged]);
  }
  if (opts.order) {
    findOpts.order = opts.order;
  }

  const children = (await childRepo.find(findOpts)) as unknown as Record<string, unknown>[];

  // Group children by the FK column (idColumn) that references the parent PK.
  const fkToChildren = new Map<unknown, Record<string, unknown>[]>();
  for (const child of children) {
    const fkVal = child[childDescriptor.idColumn];
    if (fkVal == null) continue;
    let group = fkToChildren.get(fkVal);
    if (!group) {
      group = [];
      fkToChildren.set(fkVal, group);
    }
    group.push(child);
  }

  // Assign children arrays to parents, applying per-parent limit when set.
  for (const parent of parents) {
    const pk = (parent as unknown as Record<string, unknown>)[parentPkProp];
    if (pk == null) {
      (parent as unknown as Record<string, unknown>)[relation.propertyName] = [];
      continue;
    }

    let matched = fkToChildren.get(pk) ?? [];
    if (opts.limit !== undefined && matched.length > opts.limit) {
      matched = matched.slice(0, opts.limit);
    }
    (parent as unknown as Record<string, unknown>)[relation.propertyName] = matched;
  }
}
