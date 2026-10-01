/**
 * Metadata-driven row projection for the live layer.
 *
 * {@link projectRow} reduces an entity instance to a frozen {@link LiveRow} of
 * its scalar column values, using the discriminator already proven in
 * `database/dirty.ts`. Relations are excluded because they are not columns;
 * anything a relation loads lives on the other side of a foreign key, not on
 * the row itself (LIVE-PLAN.md §4.4).
 */

import type { BaseEntity } from 'typeorm';

import type { LiveRow } from './change-record.js';

/**
 * Project one entity instance into a frozen {@link LiveRow}.
 *
 * Enumerates the entity's scalar columns from TypeORM metadata and copies each
 * column's current value off the instance. The result is a fresh object frozen
 * against later mutation; relation properties (whose `relationMetadata` is set)
 * are excluded, so a caller that needs related data must denormalize it onto the
 * row (LIVE-PLAN.md §15.5).
 *
 * The row is read by property name from the instance, so a freshly loaded
 * entity and the `databaseEntity` snapshot TypeORM hands subscriber hooks both
 * project correctly.
 */
export function projectRow(entityClass: typeof BaseEntity, row: object): LiveRow {
  const columns = entityClass
    .getRepository()
    .metadata.columns.filter((column) => column.relationMetadata === undefined);

  const record = row as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const column of columns) {
    projected[column.propertyName] = record[column.propertyName];
  }
  return Object.freeze(projected);
}
