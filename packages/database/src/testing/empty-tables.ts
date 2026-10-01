/**
 * Emptying tables of a test database.
 *
 * - {@link emptyTables}: a data source's tables, between tests that commit
 *   for real (a `commits` test of `transactionalTests`, a store contract
 *   case), in one transaction.
 * - {@link emptyManagedTables}: a kept per-worker database that
 *   `createTestDataSource` opens again, inside its schema push (after the
 *   guard, under the lock, before the plan), so rows an earlier run left
 *   cannot block a change the push makes.
 *
 * Only the tables of the models, and those the pushing owner still owns, are
 * emptied, never the schema ledger (which holds the test-database marker) or
 * another owner's tables. Foreign keys never decide the order: PostgreSQL
 * truncates every table in one statement, MariaDB deletes with foreign key
 * checks off for that statement only, and SQLite defers its checks to the
 * commit, when every table is empty. No session setting outlives its
 * statement or transaction, so a connection goes back as it came.
 */

import type { Dialect } from '../engine/contract.js';
import { internalsOf, type JsailsDataSource } from '../record/data-source.js';
import { declaredTables } from '../schema/declared-tables.js';
import { quoteName } from '../schema/emit.js';
import type { TestPushStep } from '../schema/push-schema.js';
import { transaction } from '../transaction/run-transaction.js';

/** The query-ledger origin of the testing surface's own statements. */
export const TESTING_ORIGIN = 'testing';

/** The statements that empty `tables` (quoted names, at least one) whatever their keys. */
function emptyStatements(dialect: Dialect, tables: readonly string[]): readonly string[] {
  switch (dialect) {
    case 'postgres':
      return [`TRUNCATE TABLE ${tables.join(', ')}`];
    case 'mariadb':
      return tables.map((table) => `SET STATEMENT foreign_key_checks = 0 FOR DELETE FROM ${table}`);
    case 'sqlite':
      return ['PRAGMA defer_foreign_keys = ON', ...tables.map((table) => `DELETE FROM ${table}`)];
  }
}

/** Delete every row of every table of `dataSource`'s models, in one transaction. */
export async function emptyTables(dataSource: JsailsDataSource): Promise<void> {
  const internals = internalsOf(dataSource);
  internals.assertOpen();
  const dialect = dataSource.dialect;
  const tables = declaredTables(dataSource.models, dialect).map((table) =>
    quoteName(dialect, table.name),
  );
  if (tables.length === 0) return;
  const engine = await internals.engine();
  await transaction(dataSource, async () => {
    const conn = await engine.lease();
    try {
      for (const sql of emptyStatements(dialect, tables)) {
        await conn.query(sql, [], { origin: TESTING_ORIGIN });
      }
    } finally {
      await conn.release();
    }
  });
}

/**
 * The step `createTestDataSource` runs inside its schema push: delete every
 * row of the live tables the push manages, the declared ones and those its
 * owner still owns. An owned table the models no longer declare is emptied
 * too: the push drops it, and until then its foreign keys would stop
 * PostgreSQL from truncating the tables it references.
 */
export async function emptyManagedTables(step: TestPushStep): Promise<void> {
  const managed = new Set(step.declared.map((table) => table.name));
  for (const [table, owner] of step.ownership) if (owner === step.owner) managed.add(table);
  const tables = step.live.tables
    .filter((table) => managed.has(table.name))
    .map((table) => quoteName(step.dialect, table.name));
  if (tables.length === 0) return;
  for (const sql of emptyStatements(step.dialect, tables)) {
    await step.verify();
    await step.conn.query(sql, [], { origin: TESTING_ORIGIN });
  }
}

/** The number of rows of `model`'s table, every tenant's, read without the tenant policy. */
export async function countRows(dataSource: JsailsDataSource, model: object): Promise<number> {
  const internals = internalsOf(dataSource);
  internals.assertOpen();
  const [table] = declaredTables([model], dataSource.dialect);
  if (table === undefined) return 0;
  const engine = await internals.engine();
  const conn = await engine.lease();
  try {
    const { rows } = await conn.query(
      `SELECT COUNT(*) AS n FROM ${quoteName(dataSource.dialect, table.name)}`,
      [],
      { origin: TESTING_ORIGIN },
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await conn.release();
  }
}
