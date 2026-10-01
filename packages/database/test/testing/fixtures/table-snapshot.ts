/**
 * Raw reads for the testing surface's suites: a text snapshot of every row of
 * a data source's tables, and a row count, both through `unguarded` (every
 * tenant, no codecs), so a rolled-back write shows as a difference whatever
 * path made it.
 */

import { physicalTable, type ModelTarget } from '../../../src/model/index.js';
import type { JsailsDataSource } from '../../../src/record/index.js';
import { quoteName } from '../../../src/schema/emit.js';
import { unguarded } from '../../../src/unguarded/index.js';

function text(rows: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify(rows, (_, value: unknown) => {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    if (typeof value === 'bigint') return value.toString();
    // MariaDB and PostgreSQL report integers of some types as strings.
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
    return value;
  });
}

/** Every row of every table of `dataSource`'s models, as text. */
export async function snapshot(dataSource: JsailsDataSource): Promise<string> {
  const conn = await unguarded(dataSource).lease();
  try {
    const tables: string[] = [];
    for (const model of dataSource.models) {
      const table = physicalTable(model, dataSource.dialect);
      const name = quoteName(dataSource.dialect, table.name);
      const order = table.primaryKey.map((column) => quoteName(dataSource.dialect, column));
      const { rows } = await conn.query(`SELECT * FROM ${name} ORDER BY ${order.join(', ')}`);
      tables.push(`${table.name} ${text(rows)}`);
    }
    return tables.join('\n');
  } finally {
    await conn.release();
  }
}

/** The number of rows of `model`'s table, every tenant's. */
export async function rowCount(dataSource: JsailsDataSource, model: ModelTarget): Promise<number> {
  const table = quoteName(dataSource.dialect, physicalTable(model, dataSource.dialect).name);
  const conn = await unguarded(dataSource).lease();
  try {
    const { rows } = await conn.query(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(rows[0]?.n);
  } finally {
    await conn.release();
  }
}
