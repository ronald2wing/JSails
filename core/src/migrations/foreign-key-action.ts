/**
 * The portable referential-action vocabulary and its one mapping onto the SQL
 * clause TypeORM emits, shared by the schema editor (portable -> SQL), the
 * declared-schema reader (SQL -> portable), and the normalizer (membership).
 */

import type { ForeignKeyAction } from './schema-types.js';

/** The SQL clause for each portable `ON DELETE` / `ON UPDATE` action. */
export const FOREIGN_KEY_ACTION_SQL: Readonly<Record<ForeignKeyAction, string>> = Object.freeze({
  cascade: 'CASCADE',
  restrict: 'RESTRICT',
  setNull: 'SET NULL',
  noAction: 'NO ACTION',
});

/** Every portable action, in declaration order. */
export const FOREIGN_KEY_ACTIONS: readonly ForeignKeyAction[] = Object.freeze(
  Object.keys(FOREIGN_KEY_ACTION_SQL) as ForeignKeyAction[],
);

/** True when `value` names a portable referential action. */
export function isForeignKeyAction(value: unknown): value is ForeignKeyAction {
  return typeof value === 'string' && Object.hasOwn(FOREIGN_KEY_ACTION_SQL, value);
}

/** The SQL clause TypeORM expects for a portable action. */
export function toTypeormForeignKeyAction(action: ForeignKeyAction): string {
  return FOREIGN_KEY_ACTION_SQL[action];
}

/** The portable action for a SQL clause, or `undefined` when the clause is not one. */
export function toPortableForeignKeyAction(clause: string): ForeignKeyAction | undefined {
  return FOREIGN_KEY_ACTIONS.find((action) => FOREIGN_KEY_ACTION_SQL[action] === clause);
}
