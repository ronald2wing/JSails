/**
 * Shared entity-target guard for the database subpath.
 *
 * `defineFactory`, `defineEnum`, `defineEntityValidation`, and
 * `defineEntityHooks` all accept the same TypeORM target shapes. The predicate
 * lives here so a new shape is recognized once; the caller supplies its own
 * value-free error.
 */

import { EntitySchema, type EntityTarget, type ObjectLiteral } from 'typeorm';

export function assertEntityTarget(
  entity: unknown,
  fail: () => never,
): asserts entity is EntityTarget<ObjectLiteral> {
  const valid =
    typeof entity === 'function' ||
    typeof entity === 'string' ||
    entity instanceof EntitySchema ||
    (typeof entity === 'object' &&
      entity !== null &&
      typeof (entity as { name?: unknown }).name === 'string');
  if (!valid) {
    fail();
  }
}
