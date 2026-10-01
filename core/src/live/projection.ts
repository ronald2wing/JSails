/**
 * Metadata-driven row projection for the live layer.
 *
 * {@link projectRow} reduces an entity instance to a frozen {@link LiveRow} of
 * its scalar column values, using the discriminator already proven in
 * `database/dirty-tracking.ts`. Relations are excluded because they are not columns;
 * anything a relation loads lives on the other side of a foreign key, not on
 * the row itself (docs/design/live.md §4.4).
 *
 * {@link projectRow} copies every scalar column, which is right for the change
 * log, a server-side record that needs the primary key and never leaves the
 * server. What a subscriber receives goes through {@link fieldProjector}
 * instead, which copies only the columns a publication allowlisted.
 */

import type { BaseEntity } from 'typeorm';

import type { LiveRow } from './change-record.js';
import { PublicationDefinitionError } from './publication.js';

/**
 * Project one entity instance into a frozen {@link LiveRow}.
 *
 * Enumerates the entity's scalar columns from TypeORM metadata and copies each
 * column's current value off the instance. The result is a fresh object frozen
 * against later mutation; relation properties (whose `relationMetadata` is set)
 * are excluded, so a caller that needs related data must denormalize it onto the
 * row (docs/design/live.md §15.5).
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

/**
 * Build the projection for a publication's `fields` allowlist.
 *
 * Every name must be a scalar column of `entityClass`; a relation or unknown
 * name throws `invalid_fields` once, here, rather than silently sending
 * `undefined` on every row. The returned function copies exactly those
 * columns, in the declared order, into a frozen row.
 */
export function fieldProjector(
  entityClass: typeof BaseEntity,
  fields: readonly string[],
): (row: object) => LiveRow {
  const scalar = new Set(
    entityClass
      .getRepository()
      .metadata.columns.filter((column) => column.relationMetadata === undefined)
      .map((column) => column.propertyName),
  );
  if (!fields.every((field) => scalar.has(field))) {
    throw new PublicationDefinitionError(
      'invalid_fields',
      'publication fields must name scalar columns of the queried entity',
    );
  }
  return (row) => {
    const record = row as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of fields) {
      projected[field] = record[field];
    }
    return Object.freeze(projected);
  };
}
