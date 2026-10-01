/**
 * Shared validation for relation options.
 *
 * The compiler (which reads `@jsails.*` decorators from source) and
 * `defineModel` (which lowers the emitted spec onto TypeORM) both accept the
 * same referential actions. Keeping the set here means a new action is added
 * once, not twice.
 */

import type { JsailsOnDelete } from './jsails-namespace.js';

/** Referential actions TypeORM's `OnDeleteType` accepts. */
export const ON_DELETE_VALUES: ReadonlySet<string> = new Set([
  'CASCADE',
  'RESTRICT',
  'SET NULL',
  'NO ACTION',
]);

/** True when `value` is a supported referential action. */
export function isOnDelete(value: unknown): value is JsailsOnDelete {
  return typeof value === 'string' && ON_DELETE_VALUES.has(value);
}
