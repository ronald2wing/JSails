/**
 * Found while building this harness, behind the audit finding
 * "createOwnedTables probes with an unfiltered getTables(), introspecting
 * every table of every visible schema": on MariaDB that probe crashed for any
 * user without global privileges, which is what the CI leg connects as.
 * TypeORM's unfiltered `getTables()` lists every row of
 * `INFORMATION_SCHEMA.TABLES`, which shows such a user the
 * `performance_schema` tables, then looks each table's schema up in
 * `INFORMATION_SCHEMA.SCHEMATA`, which does not list `performance_schema` for
 * that user, and read `COLLATION` off `undefined`. The same probe also raced
 * other database-suite files creating and dropping `jsails_m_*` databases, so
 * for a privileged user the crash came and went with timing. Every store built
 * on `createOwnedTables` (flags, sessions, config, notifications, plugin state)
 * failed its first call.
 *
 * The probe is now one catalog query naming only the owned tables in the
 * connected database or schema. These tests hold it to that on every driver:
 * what it sends, what counts as an owned table (not a view, not a table of the
 * same name in another database or schema), and the memoize-on-success,
 * retry-after-failure contract. They pass for any MariaDB user, privileged or
 * not; the CI leg runs them as a user without global privileges.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../../src/database/data-source.js';
import { createOwnedTables } from '../../../src/database/owned-tables.js';
import { transaction } from '../../../src/database/transaction.js';
import {
  createServerDatabase,
  matrixDriver,
  matrixServer,
  openMatrixDataSource,
} from './matrix-database.js';
import { createStatementLog } from './statement-log.js';

@Entity('regression_owned')
class Owned extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;
}

@Entity('regression_unowned')
class Unowned extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;
}

class OwnedTablesFailure extends Error {}

function makeError(failure: string, table: string | undefined): Error {
  return new OwnedTablesFailure(`${failure}: ${table ?? ''}`);
}

/** The probe's failure, or a failure of the test when it resolves instead. */
async function openFailure(open: () => Promise<unknown>): Promise<OwnedTablesFailure> {
  const failure = await open().then(
    () => new Error('open() resolved although an owned table is missing'),
    (error: unknown) => error,
  );
  // Any other error fails the test as itself, so a crash in the probe reports
  // its own message instead of a comparison.
  if (!(failure instanceof OwnedTablesFailure)) throw failure;
  return failure;
}

describe('createOwnedTables', () => {
  it('introspects only the tables it owns, in one statement', async (t) => {
    const log = createStatementLog();
    const dataSource = await openMatrixDataSource(t, {
      entities: [Owned, Unowned],
      logger: log.logger,
    });
    const tables = createOwnedTables({ dataSource, tables: ['regression_owned'], makeError });
    log.reset();

    assert.equal(await tables.open(), dataSource);

    const strays = log.statements.filter(
      (statement) =>
        statement.sql.includes('regression_unowned') ||
        statement.parameters.includes('regression_unowned'),
    );
    assert.equal(strays.length, 0, 'the probe introspected regression_unowned');
    const selects = log.selects();
    assert.equal(selects.length, 1, selects.map((statement) => statement.sql).join('\n'));
    assert.ok(selects[0]?.parameters.includes('regression_owned'));
  });

  it('opens when its tables exist', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [Owned, Unowned] });
    const tables = createOwnedTables({
      dataSource,
      tables: ['regression_owned', 'regression_unowned'],
      makeError,
    });

    assert.equal(await tables.open(), dataSource);
  });

  it('reports the first missing table in the order given', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [Owned] });
    const tables = createOwnedTables({
      dataSource,
      tables: ['regression_owned', 'regression_absent', 'regression_also_absent'],
      makeError,
    });

    const failure = await openFailure(() => tables.open());
    assert.equal(failure.message, 'missing_table: regression_absent');
  });

  it('does not count a view as an owned table', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [Owned] });
    await dataSource.query('CREATE VIEW regression_view AS SELECT id FROM regression_owned');
    const tables = createOwnedTables({ dataSource, tables: ['regression_view'], makeError });

    const failure = await openFailure(() => tables.open());
    assert.equal(failure.message, 'missing_table: regression_view');
  });

  it('does not count a table of the same name in another database or schema', async (t) => {
    const dataSource = await openMatrixDataSource(t, { entities: [Owned] });
    const tables = createOwnedTables({ dataSource, tables: ['regression_elsewhere'], makeError });
    const driver = matrixDriver();
    let failure: OwnedTablesFailure;
    if (driver === 'sqlite') {
      // SQLite's other schema here is `temp`. sql.js reopens its database after
      // every autosaved write, which drops temp tables, so the table and the
      // probe share one framework transaction, which the probe's runner joins.
      failure = await transaction(dataSource, async ({ manager }) => {
        await manager.query('CREATE TEMP TABLE regression_elsewhere (id INTEGER)');
        return openFailure(() => tables.open());
      });
    } else {
      if (driver === 'mariadb') {
        const other = await createServerDatabase(t, 'other');
        await dataSource.query(`CREATE TABLE \`${other}\`.regression_elsewhere (id INT)`);
      } else {
        await dataSource.query('CREATE SCHEMA regression_other');
        await dataSource.query('CREATE TABLE regression_other.regression_elsewhere (id integer)');
      }
      failure = await openFailure(() => tables.open());
    }
    assert.equal(failure.message, 'missing_table: regression_elsewhere');
  });

  it(
    "looks in the data source's configured PostgreSQL schema",
    { skip: matrixDriver() !== 'postgres' && 'a schema option exists only on PostgreSQL' },
    async (t) => {
      const dataSource = await openMatrixDataSource(t, { entities: [Owned] });
      await dataSource.query('CREATE SCHEMA regression_other');
      await dataSource.query('CREATE TABLE regression_other.regression_elsewhere (id integer)');
      const server = matrixServer();
      const scoped = new JsailsDataSource({
        type: 'postgres',
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.password,
        database: dataSource.driver.database,
        schema: 'regression_other',
        entities: [],
      });
      // Destroyed in the body: the matrix's cleanup drops the database first.
      await scoped.initialize();
      try {
        const found = createOwnedTables({
          dataSource: scoped,
          tables: ['regression_elsewhere'],
          makeError,
        });
        assert.equal(await found.open(), scoped);
        const missing = createOwnedTables({
          dataSource: scoped,
          tables: ['regression_owned'],
          makeError,
        });
        const failure = await openFailure(() => missing.open());
        assert.equal(failure.message, 'missing_table: regression_owned');
      } finally {
        await scoped.destroy();
      }
    },
  );

  it('retries after a failure and memoizes the first success', async (t) => {
    const log = createStatementLog();
    const dataSource = await openMatrixDataSource(t, { entities: [Owned], logger: log.logger });
    const tables = createOwnedTables({ dataSource, tables: ['regression_late'], makeError });

    const failure = await openFailure(() => tables.open());
    assert.equal(failure.message, 'missing_table: regression_late');

    await dataSource.query('CREATE TABLE regression_late (id INTEGER PRIMARY KEY)');
    assert.equal(await tables.open(), dataSource);

    log.reset();
    assert.equal(await tables.open(), dataSource);
    assert.deepEqual(log.statements, [], 'a memoized open sent a statement');
  });
});
