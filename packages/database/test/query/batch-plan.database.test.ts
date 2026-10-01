/**
 * The plan of a keyset batch on the run's driver: a walk runs under a query
 * ledger, and its second statement (the first that continues after a
 * cursor) is explained with the cursor's values. In key order it must read
 * a range of the primary key, never sort; in timestamp order a range of the
 * `(at, id)` index. SQLite reports a `SEARCH ... USING INTEGER PRIMARY KEY`,
 * PostgreSQL an index scan of `q_events_pkey` with the cursor as its index
 * condition, MariaDB a `range` access on `PRIMARY` with no filesort. Each
 * table holds enough rows, with fresh statistics, that a full scan is never
 * the cheaper plan.
 */

import assert from 'node:assert/strict';
import { before, it } from 'node:test';

import {
  createQueryLedger,
  insertAll,
  query,
  withQueryLedger,
  type JsailsDataSource,
  type Row,
  type SqlValue,
} from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import { EVENT_MODELS, Event, type EventRow } from './fixtures/event-model.js';
import { openDataSource, suiteLifecycle } from './fixtures/open-data-source.js';

const ROWS = 20_000;
const BATCH = 500;

void forEachDriver('keyset batch plan', ({ driver }) => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openDataSource(lifecycle, EVENT_MODELS);
    const base = Date.UTC(2024, 0, 1);
    await insertAll<EventRow>(
      Event,
      Array.from({ length: ROWS }, (_, index) => ({
        at: new Date(base + (index % 997) * 60_000),
        rank: index % 5 === 0 ? null : index % 7,
        label: `event ${index}`,
      })),
    );
    const raw = unguarded(dataSource);
    if (driver === 'postgres') await raw.sql`ANALYZE q_events`;
    else if (driver === 'mariadb') await raw.sql`ANALYZE TABLE q_events`;
    else await raw.sql`ANALYZE`;
  });

  /** The second statement of a walk of `walk`, and the last row of its first batch. */
  async function secondBatch(
    walk: (each: (rows: EventRow[]) => void) => Promise<void>,
  ): Promise<{ sql: string; last: EventRow }> {
    const ledger = createQueryLedger({ detail: true });
    let last: EventRow | undefined;
    await withQueryLedger(ledger, () =>
      walk((rows) => {
        last ??= rows[rows.length - 1];
      }),
    );
    const record = ledger.records[1];
    assert.ok(record !== undefined && last !== undefined, 'the walk ran a second batch');
    return { sql: record.sql, last };
  }

  async function explain(sql: string, params: readonly SqlValue[]): Promise<readonly Row[]> {
    const conn = await unguarded(dataSource).lease();
    try {
      const prefix = driver === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN ';
      return (await conn.query(prefix + sql, params)).rows;
    } finally {
      await conn.release();
    }
  }

  const planText = (rows: readonly Row[]): string =>
    rows.map((row) => String(row['detail'] ?? row['QUERY PLAN'] ?? '')).join('\n');

  it('reads each batch after the first through the primary key', async () => {
    const { sql, last } = await secondBatch((each) =>
      query<EventRow>(Event).inBatches(BATCH, (rows) => {
        each(rows);
      }),
    );
    assert.match(sql, /WHERE .*id.* > /);
    const plan = await explain(sql, [last.id, BATCH]);
    if (driver === 'sqlite') {
      assert.match(planText(plan), /SEARCH q_events USING INTEGER PRIMARY KEY \(rowid>\?\)/);
      assert.doesNotMatch(planText(plan), /TEMP B-TREE/);
    } else if (driver === 'postgres') {
      assert.match(planText(plan), /Index Scan using q_events_pkey on q_events/);
      assert.match(planText(plan), /Index Cond: \(id > /);
      assert.doesNotMatch(planText(plan), /Sort|Seq Scan/);
    } else {
      const [access] = plan;
      assert.equal(access?.['key'], 'PRIMARY');
      assert.equal(access?.['type'], 'range');
      assert.doesNotMatch(String(access?.['Extra'] ?? ''), /filesort/);
    }
  });

  it('reads each batch in timestamp order through the (at, id) index', async () => {
    const { sql, last } = await secondBatch((each) =>
      query<EventRow>(Event)
        .orderBy('at')
        .inBatches(BATCH, (rows) => {
          each(rows);
        }),
    );
    const stored = await unguarded(dataSource).sql`SELECT at FROM q_events WHERE id = ${last.id}`;
    const at = stored.rows[0]?.['at'] as SqlValue;
    // MariaDB's expanded form binds the leading range bound and each branch's values.
    const params: SqlValue[] =
      driver === 'mariadb' ? [at, at, at, last.id, BATCH] : [at, last.id, BATCH];
    const plan = await explain(sql, params);
    if (driver === 'sqlite') {
      assert.match(planText(plan), /SEARCH q_events USING INDEX \w*at\w*/);
      assert.doesNotMatch(planText(plan), /TEMP B-TREE/);
    } else if (driver === 'postgres') {
      assert.match(planText(plan), /Index Scan using \w+ on q_events/);
      assert.doesNotMatch(planText(plan), /Sort|Seq Scan|q_events_pkey/);
    } else {
      const [access] = plan;
      assert.match(String(access?.['key']), /at/);
      assert.equal(access?.['type'], 'range');
      assert.doesNotMatch(String(access?.['Extra'] ?? ''), /filesort/);
    }
  });
});
