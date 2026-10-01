/**
 * The framework-owned entity for database-backed config: one row per config
 * set, holding its active values as a JSON object.
 *
 * The table is created through the declarative schema history (`db:push`),
 * never at runtime: the `config` plugin's static schema declares it, and an app
 * that builds its own data source adds {@link configEntities} to its entity
 * list. `updatedAt` is set from application code on every write.
 */

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { JsonValue } from 'jsails/plugin-sdk';

/** Table JSails reserves for database-backed config. */
export const CONFIG_TABLE = 'jsails_config';

/** Column width of a set name; matches the name limit in `defineConfig`. */
export const CONFIG_NAME_LENGTH = 120;

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

/** The entities an app adds to its `JsailsDataSource` to store config in the database. */
export const configEntities = Object.freeze([JsailsConfigEntry] as const);
