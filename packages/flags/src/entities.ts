/**
 * The framework-owned entity for database-backed feature flags.
 *
 * {@link JsailsFeatureFlag} is the single source of truth for the
 * `jsails_feature_flag` table JSails reserves for persisted flags. It is a plain
 * Active Record entity — a generated integer primary key plus four scalar
 * columns — that the portable schema model accepts, so an app registers it with
 * its `JsailsDataSource` and creates the table through the normal declarative
 * schema history (`db:push`), never through runtime DDL.
 *
 * `scope` is stored as the empty string for the global scope (so every lookup
 * is a plain equality, never an `IS NULL`), and `value` holds the boolean
 * active/inactive state. `updatedAt` has no database default and no
 * `@CreateDateColumn`; the store sets it from application code on every write.
 */

import { BaseEntity, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { FLAG_KEY_MAX_LENGTH, FLAG_SCOPE_MAX_LENGTH } from './flags.js';

/** Table JSails reserves for database-backed feature flags. */
export const FEATURE_FLAG_TABLE = 'jsails_feature_flag';

@Entity(FEATURE_FLAG_TABLE)
// Every lookup is by `(key, scope)` or by `scope` alone; a scope-first
// composite index serves both without a table scan.
@Index('jsails_feature_flag_scope_key', ['scope', 'key'])
export class JsailsFeatureFlag extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: FLAG_KEY_MAX_LENGTH, nullable: false })
  key!: string;

  @Column({ type: 'varchar', length: FLAG_SCOPE_MAX_LENGTH, nullable: false })
  scope!: string;

  @Column({ type: 'boolean', nullable: false })
  value!: boolean;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

/**
 * The entities an app must include in its `JsailsDataSource` `entities` list
 * when it persists feature flags in the database.
 */
export const flagsEntities = Object.freeze([JsailsFeatureFlag] as const);
