/**
 * A query runs only on parts its data source made: a `ModelQuery` constructed
 * from a caller's own context (a catalog without the tenant policy, a data
 * handle's read context made writable), from codecs of another catalog, or
 * from a state no query method produced is refused with
 * `query.invalid_context` before any SQL, so the tenant scope and a handle's
 * grants cannot be swapped out around the public constructor.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  createQueryLedger,
  createStatementCatalog,
  dataHandle,
  insertAll,
  ir,
  JsailsDataSource,
  ModelQuery,
  query,
  resolveDatabaseConfig,
  runWithTenant,
  withQueryLedger,
  type QueryContext,
  type QueryState,
} from '../../src/index.js';
import { column, defineTable } from '../../src/model/index.js';
import { dataSourceContext } from '../../src/query/query-context.js';
import { unguarded } from '../../src/unguarded/index.js';
import { createTableStatements } from '../../src/schema/emit.js';
import { declaredTables } from '../../src/schema/declared-tables.js';

const TenantNote = defineTable({
  table: 'qc_tenant_notes',
  columns: { title: column.string(50), tenantId: column.integer() },
  tenant: 'tenantId',
});
const MODELS = [TenantNote];

describe('query contexts', () => {
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = new JsailsDataSource({
      config: resolveDatabaseConfig({ file: ':memory:' }, { env: {} }),
      models: MODELS,
    });
    const conn = await unguarded(dataSource).lease();
    try {
      for (const table of declaredTables(MODELS, 'sqlite')) {
        for (const statement of createTableStatements(table, 'sqlite')) await conn.query(statement);
      }
    } finally {
      await conn.release();
    }
    await runWithTenant(1, () => insertAll(TenantNote, [{ title: 'a1' }, { title: 'a2' }]));
    await runWithTenant(2, () => insertAll(TenantNote, [{ title: 'b1' }]));
  });
  after(() => dataSource.close());

  const refused = { code: 'query.invalid_context' };

  it('refuses a context built by the caller, even with the real catalog', async () => {
    const real = createStatementCatalog({ dialect: dataSource.dialect, models: MODELS });
    const codecs = real.codecs(TenantNote);
    const ledger = createQueryLedger({ detail: true });
    await withQueryLedger(ledger, () =>
      runWithTenant(1, async () => {
        const unscopedCatalog = { ...real, tenant: () => undefined };
        const forged: QueryContext = {
          dataSource,
          catalog: unscopedCatalog,
          records: true,
          writable: true,
        };
        assert.throws(() => new ModelQuery(forged, codecs), refused);
        const [own] = await query(TenantNote).getMany();
        assert.ok(own !== undefined);
        assert.equal(await query(TenantNote).count(), 2);
      }),
    );
    assert.ok(ledger.records.every((record) => /tenant_id/.test(record.sql)));
    assert.equal(await runWithTenant(2, () => query(TenantNote).count()), 1);
  });

  it('refuses a data handle read context made writable', async () => {
    const handle = dataHandle(dataSource, { models: [], read: [TenantNote] });
    const probe = handle.read(TenantNote);
    const catalog = createStatementCatalog({ dialect: dataSource.dialect, models: MODELS });
    assert.throws(
      () =>
        new ModelQuery(
          { dataSource, catalog, records: false, writable: true },
          catalog.codecs(TenantNote),
        ),
      refused,
    );
    await runWithTenant(1, async () => {
      await assert.rejects(() => probe.deleteAll(), { code: 'data_source.not_granted' });
      assert.equal(await query(TenantNote).count(), 2);
    });
  });

  it('refuses codecs of another catalog and a state no query method made', async () => {
    const context = dataSourceContext(dataSource);
    const codecs = context.catalog.codecs(TenantNote);
    const foreignCodecs = createStatementCatalog({
      dialect: dataSource.dialect,
      models: MODELS,
    }).codecs(TenantNote);
    assert.throws(() => new ModelQuery(context, foreignCodecs), refused);
    assert.throws(() => new ModelQuery({} as QueryContext, codecs), refused);
    assert.throws(() => new ModelQuery({ ...context }, codecs), refused);
    const forgedState: QueryState = {
      where: ir.TRUE,
      order: [],
      limit: undefined,
      offset: undefined,
      lock: { mode: 'update' },
      unscoped: true,
      projection: undefined,
      includes: [],
    };
    assert.throws(() => new ModelQuery(context, codecs, forgedState), refused);
    const own = new ModelQuery(context, codecs);
    assert.equal(await runWithTenant(1, () => own.count()), 2);
  });
});
