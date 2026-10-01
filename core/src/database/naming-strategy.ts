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

import { snakeCase } from '../compiler/conventions.js';

/**
 * The foreign-key column JSails derives for a relation: both parts snake-cased
 * with the same acronym-aware splitter the compiler uses for table names
 * (`blogPost` + `id` → `blog_post_id`, `primaryURL` + `id` → `primary_url_id`).
 * Anything that predicts a physical FK name — the strategy below, the
 * migration rename hints — goes through here so the prediction cannot drift.
 */
export function foreignKeyColumnName(relationName: string, referencedColumnName: string): string {
  return `${snakeCase(relationName)}_${snakeCase(referencedColumnName)}`;
}

export class JsailsNamingStrategy extends DefaultNamingStrategy {
  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return foreignKeyColumnName(relationName, referencedColumnName);
  }
}
