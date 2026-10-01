/**
 * The framework-owned entity for database-backed config: one row per config
 * set, holding its active values as a JSON object.
 *
 * The table is created through the declarative schema history (`db:push`),
 * never at runtime: the `config` plugin's `schema` contribution declares it,
 * and the data source a database store uses lists {@link configEntities}. `updatedAt` is set from application code on every write.
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { JsonValue } from 'jsails/plugin-sdk';

/**
 * Table JSails reserves for database-backed config.
 *
 * @public
 */
export const CONFIG_TABLE = 'jsails_config';

/** Column width of a set name; matches the name limit in `defineConfig`. */
export const CONFIG_NAME_LENGTH = 120;

/**
 * One row of {@link CONFIG_TABLE}: a config set's stored values.
 *
 * @public
 */
@Entity(CONFIG_TABLE)
export class JsailsConfigEntry extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: CONFIG_NAME_LENGTH, unique: true, nullable: false })
  name!: string;

  /** The set's stored values: a JSON object keyed by field. */
  @Column({ type: 'json', nullable: false })
  values!: Record<string, JsonValue>;

  @Column({ type: 'datetime', nullable: false })
  updatedAt!: Date;
}

/**
 * The entities the data source of a database config store lists.
 *
 * @public
 */
export const configEntities: readonly [typeof JsailsConfigEntry] = Object.freeze([
  JsailsConfigEntry,
] as const);
