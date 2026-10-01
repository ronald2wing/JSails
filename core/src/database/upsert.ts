/**
 * Update-or-insert for stores that key rows by a natural identifier (a session
 * id, a flag key and scope) rather than the primary key.
 *
 * Two statements on the common path: a lookup by the natural key, then either
 * an `UPDATE` of only the columns the mutator changed (by primary key) or an
 * `INSERT`. No transaction is held across them — the session store calls this
 * on every request that writes the session, and a pooled connection held for
 * BEGIN/SELECT/reload/write/COMMIT was most of the cost. Instead the race two
 * concurrent first writers run (both miss, both insert) is resolved by the
 * database: the loser's insert fails as a unique violation and is retried once
 * as an update of the winner's row. That requires a unique index over the
 * natural key; without one, concurrent first writes can create duplicates.
 *
 * Writes go through `Repository.update`/`insert`, which do not fire entity
 * subscribers; these tables are plain store tables with no model hooks.
 */

import { isDeepStrictEqual } from 'node:util';

import type { DataSource, EntityTarget, FindOptionsWhere, ObjectLiteral } from 'typeorm';

import { isUniqueViolation } from './unique-violation.js';

/** Options for {@link upsertRow}. */
export interface UpsertRowOptions<T extends ObjectLiteral> {
  readonly dataSource: DataSource;
  readonly entity: EntityTarget<T>;
  /** The natural-key lookup. */
  readonly where: FindOptionsWhere<T>;
  /** Mutate the existing row in place before it is saved. */
  readonly update: (existing: T) => void;
  /** The column values of a new row when none matches `where`. */
  readonly create: () => Partial<T>;
}

/** A column's value before the mutator ran, or `uncloneable` when it could not be copied. */
type ColumnSnapshot = { readonly value: unknown } | 'uncloneable';

/**
 * Deep-copy every column value before the mutator runs. A mutator may change a
 * JSON object or a `Date` in place, keeping the same reference, so comparing
 * against a shallow copy would miss the change and lose the write.
 */
function snapshotColumns(
  row: Record<string, unknown>,
  columns: readonly { readonly propertyName: string }[],
): Map<string, ColumnSnapshot> {
  const snapshot = new Map<string, ColumnSnapshot>();
  for (const { propertyName } of columns) {
    try {
      snapshot.set(propertyName, { value: structuredClone(row[propertyName]) });
    } catch {
      // A value structuredClone cannot copy cannot be compared later, so the
      // column is always written.
      snapshot.set(propertyName, 'uncloneable');
    }
  }
  return snapshot;
}

function columnChanged(before: ColumnSnapshot | undefined, value: unknown): boolean {
  if (before === undefined || before === 'uncloneable') return true;
  return !isDeepStrictEqual(before.value, value);
}

/** Update the row matching `where`, or insert a new one. */
export async function upsertRow<T extends ObjectLiteral>(
  options: UpsertRowOptions<T>,
): Promise<void> {
  const repository = options.dataSource.getRepository(options.entity);

  const updateExisting = async (existing: T): Promise<void> => {
    const row = existing as Record<string, unknown>;
    const before = snapshotColumns(row, repository.metadata.columns);
    options.update(existing);
    const changes: Record<string, unknown> = {};
    for (const column of repository.metadata.columns) {
      const property = column.propertyName;
      const value = row[property];
      if (columnChanged(before.get(property), value)) changes[property] = value;
    }
    if (Object.keys(changes).length === 0) return;
    const id = repository.metadata.getEntityIdMap(existing);
    if (id === undefined) {
      await repository.save(existing);
      return;
    }
    await repository.update(
      id as FindOptionsWhere<T>,
      changes as Parameters<typeof repository.update>[1],
    );
  };

  const existing = await repository.findOneBy(options.where);
  if (existing !== null) {
    await updateExisting(existing);
    return;
  }
  try {
    await repository.insert(repository.create(options.create() as T));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent writer inserted the row between the lookup and the insert.
    const winner = await repository.findOneBy(options.where);
    if (winner === null) throw error;
    await updateExisting(winner);
  }
}
