/**
 * Fixtures: rows a test states as the database's contents. `defineFixture`
 * pairs a model (a class model, or a `defineTable` link table) with its rows;
 * `loadFixtures(ds, fixtures)` inserts them in order.
 *
 * A fixture states rows as they are stored, so it loads the way
 * `FileDataSource` seeds: through `insertAll`'s set path with the same codecs
 * (encrypted columns are sealed), with no hooks, validation or declared
 * effects (a counter cache holds what the row says), and with the tenant
 * policy off (a row names its tenant, so one fixture can hold several
 * tenants' rows). Rows run in batches of the same properties, in order.
 *
 * The whole load is one `transaction()`: a failed fixture leaves none of the
 * rows behind, and inside `withTestTransaction` it is a savepoint that rolls
 * back with the test.
 *
 * On PostgreSQL an identity key given explicitly does not advance its
 * sequence, so the next generated key would collide with a fixture's;
 * after a fixture that sets one, the sequence moves past the table's largest
 * key (MariaDB and SQLite do that themselves). The sequence is not
 * transactional, so it stays moved after a rollback, which only skips keys.
 */

import type { Conn } from '../engine/contract.js';
import { modelDefinition, type TableDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { physicalTable } from '../model/physical-table.js';
import { dataSourceContext } from '../query/query-context.js';
import { internalsOf, modelName, type JsailsDataSource } from '../record/data-source.js';
import { insertRows, runsOfSameShape } from '../record/set-writes.js';
import { stringLiteral } from '../schema/column-default.js';
import { quoteName } from '../schema/emit.js';
import type { Values } from '../statement/model-values.js';
import { withoutTenantScope } from '../statement/tenant-scope.js';
import { transaction } from '../transaction/run-transaction.js';
import { TESTING_ORIGIN } from './empty-tables.js';
import { TestingErrors } from './testing-errors.js';

/** Rows of one model, stated as they are stored. */
export interface Fixture {
  readonly model: ModelTarget;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

type FixtureRow = Readonly<Record<string, unknown>>;

/** A model class, as `query()` takes one. */
type ModelConstructor = abstract new (...args: never[]) => object;

function isRow(value: unknown): value is FixtureRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkFixture(value: unknown): Fixture {
  if (value === null || typeof value !== 'object') {
    throw new TestingErrors.Error('invalid_fixture', { field: 'fixture' });
  }
  const { model, rows } = value as Partial<Fixture>;
  if (modelDefinition(model) === undefined) {
    throw new TestingErrors.Error('invalid_fixture', { field: 'model' });
  }
  if (!Array.isArray(rows) || !rows.every(isRow)) {
    throw new TestingErrors.Error('invalid_fixture', { field: 'rows' });
  }
  return value as Fixture;
}

/**
 * The rows of `model` as a fixture, frozen. The rows are copied, so later
 * changes to them do not reach the fixture.
 *
 * @throws `testing.invalid_fixture`.
 */
export function defineFixture<M extends ModelConstructor>(
  model: M,
  rows: readonly Values<InstanceType<M>>[],
): Fixture;
export function defineFixture(model: TableDefinition, rows: readonly FixtureRow[]): Fixture;
export function defineFixture(model: ModelTarget, rows: readonly FixtureRow[]): Fixture {
  const fixture = checkFixture({ model, rows });
  return Object.freeze({
    model: fixture.model,
    rows: Object.freeze(fixture.rows.map((row) => Object.freeze({ ...row }))),
  });
}

/** Move `model`'s identity sequence past its largest key, when the rows gave that key. */
async function resyncIdentity(
  conn: Conn,
  model: ModelTarget,
  rows: readonly FixtureRow[],
): Promise<void> {
  const definition = modelDefinition(model);
  const spec = definition?.spec;
  const property = spec?.generatedKey === true ? spec.primaryKey[0] : undefined;
  if (property === undefined || !rows.some((row) => row[property] !== undefined)) return;
  const table = physicalTable(model, 'postgres');
  const column = table.columns.find((candidate) => candidate.identity);
  if (column === undefined) return;
  const quotedTable = quoteName('postgres', table.name);
  await conn.query(
    `SELECT setval(pg_get_serial_sequence(${stringLiteral(quotedTable)}, ` +
      `${stringLiteral(column.name)}), COALESCE(MAX(${quoteName('postgres', column.name)}), 0) + 1, false) ` +
      `FROM ${quotedTable}`,
    [],
    { origin: TESTING_ORIGIN },
  );
}

/**
 * Insert every fixture's rows into `dataSource`, in order (parents before
 * children), in one transaction, as stored: no hooks, validation or effects,
 * and no tenant policy.
 *
 * ```ts
 * const users = defineFixture(User, [{ id: 1, name: 'ada', tenantId: 1 }]);
 * const posts = defineFixture(Post, [{ id: 1, authorId: 1, title: 'a', tenantId: 1 }]);
 * await loadFixtures(ds, [users, posts]);
 * ```
 *
 * @throws `testing.invalid_fixture`, `testing.unknown_fixture_model` for a
 *   model `dataSource` does not hold, and every failure of the inserts
 *   (codecs, constraints).
 */
export async function loadFixtures(
  dataSource: JsailsDataSource,
  fixtures: readonly Fixture[],
): Promise<void> {
  const internals = internalsOf(dataSource);
  if (!Array.isArray(fixtures)) {
    throw new TestingErrors.Error('invalid_fixture', { field: 'fixtures' });
  }
  const checked = fixtures.map(checkFixture);
  for (const { model } of checked) {
    if (!dataSource.models.includes(model)) {
      throw new TestingErrors.Error('unknown_fixture_model', { model: modelName(model) });
    }
  }
  internals.assertOpen();
  const context = dataSourceContext(dataSource);
  const engine = await internals.engine();
  await transaction(dataSource, () =>
    withoutTenantScope(async () => {
      for (const { model, rows } of checked) {
        const codecs = internals.catalog.codecs(model);
        for (const run of runsOfSameShape(rows)) {
          await insertRows(context, codecs, run, { skipHooks: true, skipEffects: true });
        }
        if (dataSource.dialect !== 'postgres') continue;
        const conn = await engine.lease();
        try {
          await resyncIdentity(conn, model, rows);
        } finally {
          await conn.release();
        }
      }
    }),
  );
}
