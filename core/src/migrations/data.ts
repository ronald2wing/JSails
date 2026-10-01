/**
 * Data migrations: named functions that run against a live database connection
 * as the **second phase** of `db:push`, after the schema is reconciled. They are
 * dependency-ordered (declaration order is the tiebreaker) and each runs in its
 * own transaction by default.
 *
 * A data migration carries `up` (and `down`) handlers, each receiving a
 * {@link DataMigrationContext} that exposes a minimal query runner over the
 * already-initialized data source. No DDL is expected — schema alterations
 * belong in the declared model, which the reconciler already applies in phase 1.
 *
 * ## No ledger, idempotent by contract
 *
 * A data migration is **not recorded as applied**. There is no tracking table,
 * no `data_version` column, and no checksum — the ledger is exactly the history
 * model the declarative engine deleted. `up` therefore runs on **every**
 * `db:push`, so every data migration MUST be idempotent: the canonical form is a
 * guarded `UPDATE ... WHERE <not-yet-migrated>`, never an unguarded `INSERT`. A
 * non-idempotent migration duplicates rows on the second push; that is the
 * author's responsibility.
 *
 * ## Transactions
 *
 * Each migration runs inside its own transaction by default. A failure rolls
 * back that migration only; earlier migrations stay committed, and later ones
 * do not run. Set `transactional: false` for long batched backfills, a migration
 * that manages its own transaction, or external I/O; a `false` migration must
 * close any transaction it opens. DDL on MySQL/MariaDB auto-commits, so data
 * migrations remain DML-only.
 *
 * `down` is kept as a documented **manual escape hatch** — no command invokes
 * it. Without a ledger the engine cannot know which migrations ran, so it cannot
 * safely auto-revert; `down` exists for the developer to call from a script or
 * REPL when reverting a data change by hand.
 */

import type { QueryRunner } from 'typeorm';
import { MigrationError } from './schema-types.js';
import { validateIdentifier } from './schema-validation.js';

/** Context exposed to a data migration's `up` and `down` handlers. */
export interface DataMigrationContext {
  /** The query runner bound to the current migration session. */
  readonly queryRunner: QueryRunner;
}

/**
 * A data migration. `up` runs on every `db:push` and must be idempotent. `down`
 * is a manual escape hatch — no command invokes it.
 */
export interface DataMigration {
  readonly name: string;
  /**
   * Names of migrations that must run first. The registry topologically sorts
   * by this list; declaration order is the tiebreaker.
   */
  readonly dependencies?: readonly string[];
  /**
   * Run `up` inside its own transaction. Defaults to `true`; set `false` for
   * long batched backfills, self-managed transactions, or external I/O.
   */
  readonly transactional?: boolean;
  up(ctx: DataMigrationContext): Promise<void>;
  down(ctx: DataMigrationContext): Promise<void>;
}

/**
 * Define a data migration with `up` and `down` handlers. `name` must be a valid
 * identifier; `dependencies` names migrations that run first; `transactional`
 * (default true) wraps `up` in its own transaction. `up` must be idempotent (it
 * runs on every `db:push`); `down` is for manual reverts only.
 */
export function defineDataMigration(def: {
  name: string;
  dependencies?: readonly string[];
  transactional?: boolean;
  up(ctx: DataMigrationContext): Promise<void>;
  down(ctx: DataMigrationContext): Promise<void>;
}): DataMigration {
  const name = validateIdentifier(def.name);
  if (def.transactional !== undefined && typeof def.transactional !== 'boolean') {
    throw new MigrationError(`data migration "${name}" transactional must be a boolean`);
  }
  const dependencies: string[] = [];
  const seen = new Set<string>();
  for (const dependency of def.dependencies ?? []) {
    const id = validateIdentifier(dependency);
    if (id === name) {
      throw new MigrationError(`data migration "${name}" cannot depend on itself`);
    }
    if (seen.has(id)) {
      throw new MigrationError(`data migration "${name}" lists dependency "${id}" twice`);
    }
    seen.add(id);
    dependencies.push(id);
  }
  return {
    name,
    ...(dependencies.length > 0 ? { dependencies: Object.freeze(dependencies) } : {}),
    ...(def.transactional !== undefined ? { transactional: def.transactional } : {}),
    up: def.up,
    down: def.down,
  };
}

/**
 * Return migrations in dependency order. Independent migrations keep their
 * declaration order. Throws on an unknown dependency, a self-dependency, or a
 * cycle, before any database work.
 */
export function orderDataMigrations(
  migrations: ReadonlyMap<string, DataMigration>,
): ReadonlyMap<string, DataMigration> {
  const ordered = new Map<string, DataMigration>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const migration of migrations.values()) {
    if (migration.transactional !== undefined && typeof migration.transactional !== 'boolean') {
      throw new MigrationError(
        `data migration "${migration.name}" transactional must be a boolean`,
      );
    }
    if (migration.dependencies !== undefined && !Array.isArray(migration.dependencies)) {
      throw new MigrationError(`data migration "${migration.name}" dependencies must be an array`);
    }
  }

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new MigrationError(`data migration dependency cycle at "${name}"`);
    }
    const migration = migrations.get(name);
    if (migration === undefined) {
      throw new MigrationError(`data migration "${name}" is not registered`);
    }
    visiting.add(name);
    for (const dependency of migration.dependencies ?? []) {
      const id = validateIdentifier(dependency);
      if (!migrations.has(id)) {
        throw new MigrationError(`data migration "${name}" depends on unknown migration "${id}"`);
      }
      visit(id);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.set(name, migration);
  };

  for (const name of migrations.keys()) visit(name);
  return ordered;
}

/**
 * Validate and index a collection of data migrations keyed by name.
 * Rejects duplicate names, names that don't match the key, and invalid identifiers.
 */
export function createDataMigrationRegistry(
  migrations: Record<string, DataMigration>,
): ReadonlyMap<string, DataMigration> {
  const registry = new Map<string, DataMigration>();
  for (const [key, migration] of Object.entries(migrations)) {
    if (typeof migration !== 'object' || migration === null) {
      throw new MigrationError(`data migration "${key}" must be a DataMigration object`);
    }
    // Check duplicate name first so entries with different keys but the same name
    // are caught as duplicates, not as key/name mismatches.
    if (typeof migration.name !== 'string') {
      throw new MigrationError(`data migration "${key}" must have a string "name"`);
    }
    if (registry.has(migration.name)) {
      throw new MigrationError(`duplicate data migration name "${migration.name}"`);
    }
    if (migration.name !== key) {
      throw new MigrationError(
        `data migration key "${key}" does not match its name "${migration.name}"`,
      );
    }
    if (typeof migration.up !== 'function') {
      throw new MigrationError(`data migration "${migration.name}" must have an "up" function`);
    }
    if (typeof migration.down !== 'function') {
      throw new MigrationError(`data migration "${migration.name}" must have a "down" function`);
    }
    registry.set(migration.name, migration);
  }
  return orderDataMigrations(registry);
}
