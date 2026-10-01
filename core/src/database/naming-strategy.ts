/**
 * The JSails naming strategy.
 *
 * JSails stores a relation's foreign key as `<relation>_<referenced column>` —
 * `user` + `id` becomes `user_id`. TypeORM's default instead camel-cases the
 * pair (`userId`), so a bare `@JoinColumn()` would produce a column the
 * framework's convention never uses.
 *
 * This strategy overrides **only** `joinColumnName`. Every other TypeORM
 * naming decision (table, column, foreign-key and unique-constraint names)
 * keeps the `DefaultNamingStrategy` behavior, so the strategy is additive and
 * does not rename existing schema.
 *
 * An explicit `@JoinColumn({ name })` always wins over the strategy — it is the
 * escape hatch for a deliberate deviation.
 */

import { DefaultNamingStrategy } from 'typeorm';

/** Snake-case an identifier: `BlogPost` → `blog_post`, `user-id` → `user_id`. */
function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
}

export class JsailsNamingStrategy extends DefaultNamingStrategy {
  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return `${snake(relationName)}_${snake(referencedColumnName)}`;
  }
}
