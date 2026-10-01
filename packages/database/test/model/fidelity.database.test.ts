/**
 * The fidelity rule, as a property test on the run's driver (SQLite in the
 * default suite, MariaDB and PostgreSQL in the database suite's legs): for
 * every portable type, a table created from `physicalTable` stores a seeded
 * stream of values and edge cases such that
 *
 * - each value reads back, through the codec, as the value written;
 * - `ORDER BY` the column gives exactly the application order
 *   (`compareValues`, ties broken by the row key), millisecond timestamp
 *   neighbours included;
 * - `WHERE column = ?` finds exactly the rows whose value is equal in the
 *   application, so case, trailing spaces and byte prefixes stay distinct.
 *
 * `JSAILS_FIDELITY_SEED` replays a failing run; the seed is in every message.
 */

import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'node:test';

import type { Engine, Row, SqlValue, Statement } from '../../src/engine/index.js';
import {
  column,
  compareValues,
  defineTable,
  describeType,
  isOrdered,
  physicalTable,
  portableCodec,
  type ColumnState,
  type PortableType,
  type TableState,
} from '../../src/model/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { exec, openMatrixEngine } from '../conformance/engine/fixtures/matrix-engine.js';
import { fidelityValues, random } from './fixtures/fidelity-values.js';

const SEED = Number(process.env.JSAILS_FIDELITY_SEED ?? 20261121);
const COUNT = 150;

const TYPES: readonly PortableType[] = [
  { kind: 'id' },
  { kind: 'string', length: 12 },
  { kind: 'text' },
  { kind: 'integer' },
  { kind: 'bigint' },
  { kind: 'decimal', precision: 12, scale: 3 },
  { kind: 'decimal', precision: 18, scale: 0 },
  { kind: 'decimal', precision: 38, scale: 10 },
  { kind: 'float' },
  { kind: 'boolean' },
  { kind: 'timestamp' },
  { kind: 'date' },
  { kind: 'time' },
  { kind: 'json' },
  { kind: 'uuid' },
  { kind: 'binary', length: 24 },
  { kind: 'binary' },
];

function quote(engine: Engine, name: string): string {
  return engine.dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`;
}

/** Test-only DDL for a lowered table; the schema emitter (DAT-06) owns the real one. */
function columnSql(engine: Engine, state: ColumnState): string {
  let sql = `${quote(engine, state.name)} ${state.type}`;
  if (state.collation !== undefined) {
    sql +=
      engine.dialect === 'mariadb'
        ? ` CHARACTER SET utf8mb4 COLLATE ${state.collation}`
        : ` COLLATE "${state.collation}"`;
  }
  sql += state.nullable ? ' NULL' : ' NOT NULL';
  if (state.check === 'json') sql += ` CHECK (json_valid(${quote(engine, state.name)}))`;
  return sql;
}

function createSql(engine: Engine, table: TableState): string {
  const columns = table.columns.map((state) => columnSql(engine, state));
  const key = table.primaryKey.map((name) => quote(engine, name)).join(', ');
  return `CREATE TABLE ${quote(engine, table.name)} (${columns.join(', ')}, PRIMARY KEY (${key}))`;
}

async function run(engine: Engine, statement: Statement): Promise<readonly Row[]> {
  const { sql, params } = engine.compile(statement);
  const conn = await engine.lease();
  try {
    return (await conn.query(sql, params)).rows;
  } finally {
    await conn.release();
  }
}

function same(type: PortableType, a: unknown, b: unknown): boolean {
  if (type.kind === 'json') return isDeepStrictEqual(a, b);
  return compareValues(type, a, b) === 0;
}

function show(type: PortableType, value: unknown): string {
  if (value instanceof Uint8Array) return `bytes(${value.length})`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return `${value}n`;
  if (type.kind === 'text' && typeof value === 'string' && value.length > 40) {
    return `text(${value.length})`;
  }
  return JSON.stringify(value);
}

function slug(type: PortableType): string {
  return describeType(type)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_$/, '');
}

forEachDriver('portable type fidelity', () => {
  for (const [position, type] of TYPES.entries()) {
    describe(describeType(type), () => {
      it('round-trips, orders and compares as the application does', async (t) => {
        const engine = await openMatrixEngine(t);
        const label = `${describeType(type)} on ${engine.dialect}, seed ${SEED}`;
        const table = defineTable({
          table: `fidelity_${slug(type)}`,
          primaryKey: 'k',
          columns: { k: column.integer(), v: { type, nullable: true } },
        });
        const state = physicalTable(table, engine.dialect);
        await exec(engine, createSql(engine, state));

        const codec = portableCodec(type, engine.dialect, 'v');
        const values = fidelityValues(type, random(SEED + position), COUNT);
        const encoded: SqlValue[] = values.map((value) => codec.encode(value as never));
        const tableName = state.name;
        for (let start = 0; start < values.length; start += 50) {
          const rows = encoded
            .slice(start, start + 50)
            .map((value, offset) => [start + offset, value]);
          await run(engine, { kind: 'insert', table: tableName, columns: ['k', 'v'], rows });
        }
        await run(engine, {
          kind: 'insert',
          table: tableName,
          columns: ['k', 'v'],
          rows: [[values.length, null]],
        });

        const stored = await run(engine, {
          kind: 'select',
          from: { table: tableName },
          columns: [{ column: 'k' }, { column: 'v' }],
          orderBy: [{ column: 'k' }],
        });
        assert.equal(stored.length, values.length + 1, label);
        for (const row of stored) {
          const key = Number(row.k);
          if (key === values.length) {
            assert.equal(row.v, null, `${label}: NULL stays NULL`);
            continue;
          }
          const decoded = codec.decode(row.v as SqlValue);
          assert.ok(
            same(type, decoded, values[key]),
            `${label}: wrote ${show(type, values[key])}, read ${show(type, decoded)}`,
          );
        }

        if (!isOrdered(type)) return;
        const ordered = await run(engine, {
          kind: 'select',
          from: { table: tableName },
          columns: [{ column: 'k' }],
          where: { op: 'null', column: 'v', negate: true },
          orderBy: [{ column: 'v' }, { column: 'k' }],
        });
        const expected = values
          .map((value, key) => ({ value, key }))
          .sort((a, b) => compareValues(type, a.value, b.value) || a.key - b.key)
          .map((entry) => entry.key);
        const actual = ordered.map((row) => Number(row.k));
        const first = actual.findIndex((key, index) => key !== expected[index]);
        assert.equal(
          first,
          -1,
          `${label}: database order differs at position ${first}: ` +
            `${show(type, values[actual[first] ?? 0])} before ${show(type, values[expected[first] ?? 0])}`,
        );

        const probes = values.slice(0, 24);
        for (const probe of probes) {
          const found = await run(engine, {
            kind: 'select',
            from: { table: tableName },
            columns: [{ column: 'k' }],
            where: {
              op: 'compare',
              column: 'v',
              comparison: '=',
              value: codec.encode(probe as never),
            },
            orderBy: [{ column: 'k' }],
          });
          const want = values.flatMap((value, key) => (same(type, value, probe) ? [key] : []));
          assert.deepEqual(
            found.map((row) => Number(row.k)),
            want,
            `${label}: WHERE v = ${show(type, probe)}`,
          );
        }
      });
    });
  }
});
