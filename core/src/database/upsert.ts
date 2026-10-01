/**
 * Find-or-create in one transaction, for stores that key rows by a natural
 * identifier (a session id, a flag key and scope) rather than the primary key.
 */

import type { DataSource, EntityTarget, FindOptionsWhere, ObjectLiteral } from 'typeorm';

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

/** Update the row matching `where`, or insert a new one, inside one transaction. */
export async function upsertRow<T extends ObjectLiteral>(
  options: UpsertRowOptions<T>,
): Promise<void> {
  await options.dataSource.transaction(async (manager) => {
    const repository = manager.getRepository(options.entity);
    const existing = await repository.findOneBy(options.where);
    if (existing !== null) {
      options.update(existing);
      await repository.save(existing);
      return;
    }
    await repository.save(repository.create(options.create() as T));
  });
}
