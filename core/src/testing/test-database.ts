/**
 * Transactional database test harness (`jsails/testing`).
 *
 * The Laravel/Rails "DatabaseTransactions" ergonomic: `jsails test` boots a
 * `*_test` database and migrates it once; a test opts into per-test isolation
 * with {@link withTestTransaction}, which wraps the body in
 * {@link withRollback} so every insert the test makes is discarded afterward and
 * tests never leak rows into each other.
 *
 * This module imports the application runtime (the `JsailsDataSource` + the
 * transaction seam); it is server-only and never part of the browser-safe root
 * entry.
 */

import { JsailsDataSource } from '../database/data-source.js';
import { diffSchemaStates } from '../migrations/autodetector.js';
import { executeSchemaPlan } from '../migrations/schema-executor.js';

import type { MixedList } from 'typeorm';
import type { EntitySchema } from 'typeorm';

/** TypeORM's entity-list shape: entity classes, schemas, or loadable paths. */
export type EmptyDataSourceEntities = MixedList<Function | string | EntitySchema>;

/** Options for {@link createEmptyDataSource}. */
export interface CreateEmptyDataSourceOptions {
  /** File path for the sqljs database; default `empty-test.db`. */
  readonly location?: string;
  /**
   * Reconcile the declared entity schema into the empty database after
   * initialization (`getModelSchema` → `diffSchemaStates` → `executeSchemaPlan`).
   * Defaults to `true`; pass `false` to leave the tables absent.
   */
  readonly migrate?: boolean;
}

/**
 * Wrap a test body in a rollback transaction against the test data source, so
 * every row it writes is discarded after it resolves. Mirrors Rails'
 * `ActiveRecord::TestCase`/Laravel's `DatabaseTransactions` trait.
 *
 * ```ts
 * await withTestTransaction(dataSource, async () => {
 *   const repo = dataSource.getRepository(User);
 *   await repo.save(repo.create({ email: 'a@x.test' }));
 * });
 * // the row is gone here.
 * ```
 *
 * The body's error propagates unchanged; the rollback happens regardless.
 */
export function withTestTransaction<T>(
  dataSource: JsailsDataSource,
  body: () => Promise<T>,
): Promise<T> {
  // Dynamic import keeps the read-only database fixture helpers out of the
  // eager import graph of the testing subpath.
  return import('../database/fixtures.js').then(({ withRollback }) =>
    withRollback(dataSource, body),
  );
}

/**
 * Initialize an isolated, on-disk sqljs data source over a unique location and,
 * by default, reconcile `entities` into it, so a test gets a ready, empty
 * database without repeating the four-step setup (construct → initialize →
 * `getModelSchema` → diff/execute). Callers must pass distinct `location`
 * values per test — sqljs persists to the file, so reusing one collides.
 */
export async function createEmptyDataSource(
  entities: EmptyDataSourceEntities,
  options: CreateEmptyDataSourceOptions = {},
): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: options.location ?? 'empty-test.db',
    entities,
  });
  await dataSource.initialize();

  const migrate = options.migrate ?? true;
  if (migrate) {
    const schema = await dataSource.getModelSchema();
    const operations = diffSchemaStates({ tables: [] }, schema);
    await executeSchemaPlan(dataSource, operations);
  }
  return dataSource;
}
