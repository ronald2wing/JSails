/**
 * Pure batch helpers shared by the relation loaders.
 *
 * Every loader follows the same four phases: collect distinct parent keys,
 * query the related rows, index them by primary key, and assign them back onto
 * the parents in place. Only the query and the shape of the assignment differ
 * per relation kind, so the phases live here.
 */

import { In } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';

import type { RelationLoadOptions } from './load-options.js';
import { selectToObject } from './relation-resolution.js';

/** Distinct, non-null parent PK values, optionally bounded by `maxRows`. */
export function collectParentPks<T extends object>(
  parents: readonly T[],
  pkProperty: string,
  maxRows?: number,
): unknown[] {
  const seen = new Set<unknown>();
  for (const parent of parents) {
    const pk = (parent as Record<string, unknown>)[pkProperty];
    if (pk != null) seen.add(pk);
  }
  const list = [...seen];
  return maxRows !== undefined && list.length > maxRows ? list.slice(0, maxRows) : list;
}

/** Target keys grouped by owner key, plus the flat list of every target key. */
export interface PairGroups {
  readonly groups: Map<unknown, unknown[]>;
  readonly targets: unknown[];
}

/** Group `(owner, target)` pairs from a raw query. */
export function groupPairs(
  rows: readonly Record<string, unknown>[],
  ownerKey: string,
  targetKey: string,
): PairGroups {
  const groups = new Map<unknown, unknown[]>();
  const targets: unknown[] = [];
  for (const row of rows) {
    const owner = row[ownerKey];
    const target = row[targetKey];
    if (owner == null || target == null) continue;
    let group = groups.get(owner);
    if (!group) {
      group = [];
      groups.set(owner, group);
    }
    group.push(target);
    targets.push(target);
  }
  return { groups, targets };
}

/** First target key per owner key, for a one-to-one relation. */
export function firstPairMap(
  rows: readonly Record<string, unknown>[],
  ownerKey: string,
  targetKey: string,
): Map<unknown, unknown> {
  const byOwner = new Map<unknown, unknown>();
  for (const row of rows) {
    const owner = row[ownerKey];
    const target = row[targetKey];
    if (owner != null && target != null && !byOwner.has(owner)) {
      byOwner.set(owner, target);
    }
  }
  return byOwner;
}

/** Build the `find()` options for a PK-IN load with optional select/where/order. */
export function buildFindOptions(
  pkProperty: string,
  pks: readonly unknown[],
  opts: RelationLoadOptions,
): Record<string, unknown> {
  const findOptions: Record<string, unknown> = {
    where: {
      [pkProperty]: In([...pks]),
      ...(opts.where ?? {}),
    } satisfies FindOptionsWhere<unknown>,
  };
  if (opts.select && opts.select.length > 0) {
    findOptions.select = selectToObject(opts.select);
  }
  if (opts.order) {
    findOptions.order = opts.order;
  }
  return findOptions;
}

/** Index hydrated rows by their primary-key property. */
export function indexByPk(
  rows: readonly Record<string, unknown>[],
  pkProperty: string,
): Map<unknown, Record<string, unknown>> {
  const index = new Map<unknown, Record<string, unknown>>();
  for (const row of rows) {
    index.set(row[pkProperty], row);
  }
  return index;
}

/** Assign an array of loaded rows to each parent, applying the per-parent limit. */
export function assignMany<T extends object>(
  parents: readonly T[],
  propertyName: string,
  parentPkProperty: string,
  groups: ReadonlyMap<unknown, unknown[]>,
  index: ReadonlyMap<unknown, Record<string, unknown>>,
  limit?: number,
): void {
  for (const parent of parents) {
    const pk = (parent as Record<string, unknown>)[parentPkProperty];
    if (pk == null) {
      (parent as Record<string, unknown>)[propertyName] = [];
      continue;
    }
    const targetPks = groups.get(pk);
    if (!targetPks || targetPks.length === 0) {
      (parent as Record<string, unknown>)[propertyName] = [];
      continue;
    }
    let matched = targetPks.map((targetPk) => index.get(targetPk)!).filter(Boolean);
    if (limit !== undefined && matched.length > limit) {
      matched = matched.slice(0, limit);
    }
    (parent as Record<string, unknown>)[propertyName] = matched;
  }
}

/** Assign the single loaded row (or null) to each parent. */
export function assignOne<T extends object>(
  parents: readonly T[],
  propertyName: string,
  parentPkProperty: string,
  targetPkByParent: ReadonlyMap<unknown, unknown>,
  index: ReadonlyMap<unknown, Record<string, unknown>>,
): void {
  for (const parent of parents) {
    const pk = (parent as Record<string, unknown>)[parentPkProperty];
    if (pk == null) {
      (parent as Record<string, unknown>)[propertyName] = null;
      continue;
    }
    const targetPk = targetPkByParent.get(pk);
    (parent as Record<string, unknown>)[propertyName] =
      targetPk != null ? (index.get(targetPk) ?? null) : null;
  }
}
