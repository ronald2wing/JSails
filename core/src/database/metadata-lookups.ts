/**
 * Small, shared TypeORM metadata lookups.
 *
 * Kept separate from `relation-metadata.ts` and `through-relations.ts` so both
 * can use the same lookup without creating an import cycle.
 */

import { getMetadataArgsStorage } from 'typeorm';

/** Find the database join-column name for an entity property, when declared. */
export function findJoinColumn(entity: Function, propertyName: string): string | undefined {
  const storage = getMetadataArgsStorage();
  const joinColumn = storage.joinColumns.find(
    (candidate) => candidate.target === entity && candidate.propertyName === propertyName,
  );
  return joinColumn?.name;
}
