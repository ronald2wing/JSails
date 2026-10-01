/**
 * `emptyManagedTables` as the step of a test push, on the run's driver
 * (SQLite in the default suite): it empties the tables the push manages,
 * the declared ones and an owned one the models no longer declare, before
 * the plan, so a required column and a unique index apply over a table
 * that held duplicate rows; another owner's table and the test-database
 * marker are left as they were.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createEngine, type Engine } from '../../src/engine/index.js';
import { column, defineTable } from '../../src/model/index.js';
import {
  assertTestDatabase,
  introspect,
  markTestDatabase,
  pushSchema,
} from '../../src/schema/index.js';
import { pushTestSchema } from '../../src/schema/push-schema.js';
import { emptyManagedTables } from '../../src/testing/empty-tables.js';
import { forEachDriver, lastInFirstOut } from '../../src/testing/index.js';
import { matrixEngineConfig } from '../conformance/engine/fixtures/matrix-engine.js';

const KeepV1 = defineTable({ table: 'te_keep', columns: { title: column.string(20) } });
const Gone = defineTable({ table: 'te_gone', columns: { title: column.string(20) } });
const Other = defineTable({ table: 'te_other', columns: { title: column.string(20) } });
const KeepV2 = defineTable({
  table: 'te_keep',
  columns: { title: column.string(20), slug: column.string(20) },
  indexes: [{ columns: ['title'], unique: true }],
});

async function run(engine: Engine, sql: string): Promise<readonly Record<string, unknown>[]> {
  const conn = await engine.lease();
  try {
    return (await conn.query(sql)).rows;
  } finally {
    await conn.release();
  }
}

async function count(engine: Engine, table: string): Promise<number> {
  const [row] = await run(engine, `SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n);
}

void forEachDriver('emptying managed tables inside a test push', () => {
  it('empties the managed tables before the plan, and nothing else', async (t) => {
    const ordered = lastInFirstOut(t);
    const config = await matrixEngineConfig(ordered);
    const engine = await createEngine(config);
    ordered.after(() => engine.close());
    const conn = await engine.lease();
    try {
      await markTestDatabase(conn);
    } finally {
      await conn.release();
    }

    await pushTestSchema(
      { config, models: [KeepV1, Gone] },
      { approve: 'all' },
      emptyManagedTables,
    );
    await pushSchema({ config, models: [Other] }, { environment: 'test', owner: 'plugin' });
    await run(engine, "INSERT INTO te_keep (title) VALUES ('same'), ('same')");
    await run(engine, "INSERT INTO te_gone (title) VALUES ('left')");
    await run(engine, "INSERT INTO te_other (title) VALUES ('theirs')");

    const report = await pushTestSchema(
      { config, models: [KeepV2] },
      { approve: 'all' },
      emptyManagedTables,
    );
    assert.equal(report.complete, true, 'the required column and the unique index applied');
    assert.equal(await count(engine, 'te_keep'), 0);
    assert.equal(await count(engine, 'te_other'), 1, "another owner's rows are kept");

    const check = await engine.lease();
    try {
      const names = (await introspect(check, engine.dialect)).tables.map((table) => table.name);
      assert.ok(!names.includes('te_gone'), 'the owned table the models dropped is gone');
      await assertTestDatabase(check);
    } finally {
      await check.release();
    }
  });
});
