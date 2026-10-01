/**
 * Pure batch helpers shared by the relation loaders.
 *
 * Every loader follows the same four phases: collect distinct parent keys,
 * query the related rows, index them by primary key, and assign them back onto
 * the parents in place. Only the query and the shape of the assignment differ
 * per relation kind, so the phases live here.
 *
 * Every `IN (...)` list is split into chunks of {@link IN_CHUNK_SIZE} keys:
 * one parameter is bound per key, and an unbounded list overruns PostgreSQL's
 * 65,535 and SQLite's 32,766 bound-parameter limits. A to-many load chunks its
 * target query by *owner*, keeping all of one parent's targets in the same
 * query, so the caller's `order` survives per parent and `limit` keeps the
 * first rows of that order rather than an arbitrary slice. A single owner with
 * more targets than one chunk holds is split across several queries, and its
 * rows are re-sorted in memory by `order` ({@link compareByOrder}).
 */

import { In } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';

import type { RelationLoadOptions } from './load-options.js';
import { selectToObject } from './relation-resolution.js';

/** The most keys one `IN (...)` list binds. */
export const IN_CHUNK_SIZE = 1000;

/** Split `list` into consecutive chunks of at most `size` items. */
export function chunked<T>(list: readonly T[], size: number = IN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < list.length; start += size) {
    chunks.push(list.slice(start, start + size));
  }
  return chunks;
}

/** Run `query` once per chunk of `keys` and concatenate the results in order. */
export async function queryInChunks<K, R>(
  keys: readonly K[],
  query: (chunk: K[]) => Promise<R[]>,
): Promise<R[]> {
  const rows: R[] = [];
  for (const chunk of chunked(keys)) {
    rows.push(...(await query(chunk)));
  }
  return rows;
}

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

/** Rank a value for in-memory ordering; `null`/`undefined` sort as the largest value. */
function compareValues(a: unknown, b: unknown): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left !== typeof right) return String(left) < String(right) ? -1 : 1;
  return (left as number) < (right as number) ? -1 : (left as number) > (right as number) ? 1 : 0;
}

/**
 * Compare two hydrated rows by a find-options `order`. It reproduces the
 * database order for numbers, dates, and binary-collated strings; nulls sort
 * last ascending and first descending (PostgreSQL's default), and a
 * locale-aware column collation is approximated by code-unit order.
 */
export function compareByOrder(
  order: Readonly<Record<string, 'ASC' | 'DESC'>>,
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  const keys = Object.entries(order);
  return (a, b) => {
    for (const [property, direction] of keys) {
      const result = compareValues(a[property], b[property]);
      if (result !== 0) return direction === 'DESC' ? -result : result;
    }
    return 0;
  };
}

/**
 * Load the targets of every owner in `groups` and return each owner's rows in
 * the order `fetch` returned them. Owners are packed into chunks whose
 * distinct target keys stay within {@link IN_CHUNK_SIZE}, and `fetch` runs
 * once per chunk. An owner with more targets than that is fetched alone in
 * several chunks; its rows are then re-sorted by `order` when one is given
 * (without one, the database order is arbitrary in any case).
 */
export async function loadGroupedTargets(
  groups: ReadonlyMap<unknown, readonly unknown[]>,
  targetPkProperty: string,
  fetch: (targetPks: unknown[]) => Promise<Record<string, unknown>[]>,
  order?: Readonly<Record<string, 'ASC' | 'DESC'>>,
): Promise<Map<unknown, Record<string, unknown>[]>> {
  const byOwner = new Map<unknown, Record<string, unknown>[]>();
  let owners: unknown[] = [];
  let targets = new Set<unknown>();

  const loadOversizedOwner = async (owner: unknown, ownerTargets: Set<unknown>): Promise<void> => {
    const rows: Record<string, unknown>[] = [];
    for (const chunk of chunked([...ownerTargets])) rows.push(...(await fetch(chunk)));
    if (order !== undefined && Object.keys(order).length > 0) rows.sort(compareByOrder(order));
    byOwner.set(owner, rows);
  };

  const flush = async (): Promise<void> => {
    if (owners.length === 0) return;
    const ownersOfTarget = new Map<unknown, unknown[]>();
    for (const owner of owners) {
      for (const target of groups.get(owner) ?? []) {
        const list = ownersOfTarget.get(target);
        if (list === undefined) ownersOfTarget.set(target, [owner]);
        else if (!list.includes(owner)) list.push(owner);
      }
    }
    for (const row of await fetch([...targets])) {
      for (const owner of ownersOfTarget.get(row[targetPkProperty]) ?? []) {
        const list = byOwner.get(owner);
        if (list === undefined) byOwner.set(owner, [row]);
        else list.push(row);
      }
    }
    owners = [];
    targets = new Set();
  };

  for (const [owner, ownerTargets] of groups) {
    const distinct = new Set(ownerTargets);
    if (distinct.size > IN_CHUNK_SIZE) {
      await flush();
      await loadOversizedOwner(owner, distinct);
      continue;
    }
    const added = ownerTargets.filter((target) => !targets.has(target)).length;
    if (owners.length > 0 && targets.size + added > IN_CHUNK_SIZE) await flush();
    owners.push(owner);
    for (const target of ownerTargets) targets.add(target);
  }
  await flush();
  return byOwner;
}

/** Assign each parent its rows (in load order), applying the per-parent limit. */
export function assignGrouped<T extends object>(
  parents: readonly T[],
  propertyName: string,
  parentPkProperty: string,
  byOwner: ReadonlyMap<unknown, readonly Record<string, unknown>[]>,
  limit?: number,
): void {
  for (const parent of parents) {
    const pk = (parent as Record<string, unknown>)[parentPkProperty];
    const rows = pk == null ? [] : (byOwner.get(pk) ?? []);
    (parent as Record<string, unknown>)[propertyName] =
      limit !== undefined && rows.length > limit ? rows.slice(0, limit) : [...rows];
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
