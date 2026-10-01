/**
 * `FileDataSource`: a read-only data source over seeded rows, for tests,
 * demos and read-only catalogs. It is an in-memory SQLite data source: the
 * declared tables are created, each model's rows (given in code, or read from
 * a JSON file) are loaded through `insertAll`, the same codecs and checks as
 * any insert (no hooks or effects: seeded rows, counters included, are taken
 * as given), and the database is then switched to `query_only`, so every
 * write fails with `DatabaseError('read_only')`. Queries and records work as
 * on any data source; it is not a sandbox, only a guard against accidental
 * writes.
 *
 * A JSON file holds an array of row objects. JSON has no dates, big integers
 * or bytes, so a `timestamp` value may be an ISO 8601 string, a `bigint` a
 * decimal string or a safe integer, and a `binary` value a base64 string.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MEMORY_DATABASE, resolveDatabaseConfig } from '../engine/config.js';
import type { SealProvider } from '../codec/seal-provider.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget, ResolvedColumn } from '../model/model-spec.js';
import { createTableStatements } from '../schema/emit.js';
import { declaredTables } from '../schema/declared-tables.js';
import { dataSourceContext } from '../query/query-context.js';
import { transaction } from '../transaction/run-transaction.js';
import { internalsOf, JsailsDataSource, modelName } from './data-source.js';
import { DataSourceErrors } from './record-errors.js';
import { insertRows, runsOfSameShape } from './set-writes.js';

/** One seeded model: its rows in code, or a JSON file holding them. */
export type FileDataSourceModel =
  | { readonly model: ModelTarget; readonly rows: readonly Readonly<Record<string, unknown>>[] }
  | { readonly model: ModelTarget; readonly file: string };

/** What {@link FileDataSource.open} takes. */
export interface FileDataSourceOptions {
  /** The seeded models, loaded in this order (parents before children). */
  readonly models: readonly FileDataSourceModel[];
  /** The directory relative seed files resolve against; the working directory when unset. */
  readonly root?: string;
  /** Builds the seal layer of encrypted columns. */
  readonly seal?: SealProvider;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const INTEGER_TEXT = /^-?\d+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function seedValue(column: ResolvedColumn, value: unknown, model: string): unknown {
  const invalid = (): never => {
    throw new DataSourceErrors.Error('invalid_options', { field: `${model}.rows` });
  };
  if (value === null) return null;
  switch (column.type.kind) {
    case 'timestamp': {
      if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return invalid();
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? invalid() : date;
    }
    case 'bigint':
      if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
      if (typeof value === 'string' && INTEGER_TEXT.test(value)) return BigInt(value);
      return invalid();
    case 'binary':
      if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) {
        return invalid();
      }
      return new Uint8Array(Buffer.from(value, 'base64'));
    default:
      return value;
  }
}

async function seedRows(
  entry: FileDataSourceModel,
  root: string | undefined,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const name = modelName(entry.model);
  if ('rows' in entry) {
    if (!Array.isArray(entry.rows)) {
      throw new DataSourceErrors.Error('invalid_options', { field: `${name}.rows` });
    }
    return entry.rows;
  }
  if (typeof entry.file !== 'string' || entry.file === '') {
    throw new DataSourceErrors.Error('invalid_options', { field: `${name}.file` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(root ?? '.', entry.file), 'utf8'));
  } catch (error) {
    // The file's text may be anything; only the fact that it failed is kept.
    throw new DataSourceErrors.Error(
      'invalid_options',
      { field: `${name}.file` },
      { cause: error },
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  ) {
    throw new DataSourceErrors.Error('invalid_options', { field: `${name}.file` });
  }
  const columns = modelDefinition(entry.model)?.spec.columns ?? [];
  return (parsed as Record<string, unknown>[]).map((row) => {
    const values: Record<string, unknown> = {};
    for (const [property, value] of Object.entries(row)) {
      const column = columns.find((candidate) => candidate.property === property);
      values[property] = column === undefined ? value : seedValue(column, value, name);
    }
    return values;
  });
}

/** A read-only, in-memory data source over seeded rows. */
export class FileDataSource extends JsailsDataSource {
  /**
   * Create the declared tables in a new in-memory database, load every
   * model's rows, and make the database read-only. The models are bound to
   * it until it is closed.
   *
   * @throws `data_source.invalid_options` for malformed seeds, and every
   *   failure of the loads (codecs, constraints).
   */
  static async open(options: FileDataSourceOptions): Promise<FileDataSource> {
    if (options === null || typeof options !== 'object' || !Array.isArray(options.models)) {
      throw new DataSourceErrors.Error('invalid_options', { field: 'models' });
    }
    for (const entry of options.models) {
      if (entry === null || typeof entry !== 'object') {
        throw new DataSourceErrors.Error('invalid_options', { field: 'models' });
      }
      modelName(entry.model);
    }
    const models = options.models.map((entry) => entry.model);
    const seeds = await Promise.all(options.models.map((entry) => seedRows(entry, options.root)));
    const dataSource = new FileDataSource({
      config: resolveDatabaseConfig({ file: MEMORY_DATABASE }, { env: {} }),
      models,
      ...(options.seal === undefined ? {} : { seal: options.seal }),
    });
    try {
      const internals = internalsOf(dataSource);
      const engine = await internals.engine();
      const context = dataSourceContext(dataSource);
      await transaction(dataSource, async () => {
        const conn = await engine.lease();
        try {
          for (const table of declaredTables(models, 'sqlite')) {
            for (const statement of createTableStatements(table, 'sqlite')) {
              await conn.query(statement, [], { origin: 'schema' });
            }
          }
        } finally {
          await conn.release();
        }
        for (const [index, model] of models.entries()) {
          const codecs = internals.catalog.codecs(model);
          for (const run of runsOfSameShape(seeds[index] ?? [])) {
            await insertRows(context, codecs, run, { skipHooks: true, skipEffects: true });
          }
        }
      });
      const conn = await engine.lease();
      try {
        await conn.query('PRAGMA query_only = ON', [], { origin: 'schema' });
      } finally {
        await conn.release();
      }
      return dataSource;
    } catch (error) {
      await dataSource.close();
      throw error;
    }
  }
}
