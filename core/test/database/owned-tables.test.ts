/**
 * createOwnedTables' driver-independent contract: initialization, the lazy
 * getter, an empty table list, the `hasTable` fallback for a driver without
 * a catalog query, and the PostgreSQL probe of a driver that leaves `schema`
 * unset (TypeORM's own driver always sets it on connect, so no live database
 * reaches that branch). The catalog probe itself runs on every matrix driver
 * in regressions/owned-tables.database.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, DataSource, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { createOwnedTables } from '../../src/database/owned-tables.js';

@Entity('owned_unit')
class OwnedUnit extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;
}

class Failure extends Error {}

function makeError(failure: string, table: string | undefined): Error {
  return new Failure(`${failure}: ${table ?? ''}`);
}

/** A plain TypeORM source, as a package store may be handed; it creates its table on initialize. */
function memorySource(): DataSource {
  return new DataSource({ type: 'sqljs', entities: [OwnedUnit], synchronize: true });
}

/** A data source of a driver with no catalog query, answering `hasTable` from `present`. */
function fallbackSource(present: ReadonlySet<string>, asked: string[]): DataSource {
  const runner = {
    connect: async () => undefined,
    release: async () => undefined,
    hasTable: async (name: string) => {
      asked.push(name);
      return present.has(name);
    },
    query: () => Promise.reject(new Error('the fallback must not send a catalog query')),
  };
  return {
    isInitialized: true,
    options: { type: 'mssql' },
    createQueryRunner: () => runner,
  } as unknown as DataSource;
}

/** An initialized PostgreSQL source whose driver leaves `schema` unset, recording each query. */
function schemalessPostgresSource(
  present: readonly string[],
  sent: { sql: string; parameters: unknown[] }[],
): DataSource {
  const runner = {
    connect: async () => undefined,
    release: async () => undefined,
    hasTable: () => Promise.reject(new Error('postgres must use the catalog query')),
    query: async (sql: string, parameters: unknown[]) => {
      sent.push({ sql, parameters });
      return present.map((name) => ({ name }));
    },
  };
  return {
    isInitialized: true,
    options: { type: 'postgres' },
    driver: { schema: undefined },
    createQueryRunner: () => runner,
  } as unknown as DataSource;
}

describe('createOwnedTables', () => {
  it('reports not_initialized without connecting by default', async () => {
    const source = memorySource();
    const tables = createOwnedTables({ dataSource: source, tables: ['owned_unit'], makeError });

    await assert.rejects(tables.open(), { message: 'not_initialized: ' });
    assert.equal(source.isInitialized, false);
  });

  it('initializes a lazily resolved source when asked to', async (t) => {
    const source = memorySource();
    t.after(() => source.destroy());
    let resolved = 0;
    const tables = createOwnedTables({
      dataSource: () => {
        resolved += 1;
        return source;
      },
      tables: ['owned_unit'],
      initialize: true,
      makeError,
    });

    assert.equal(await tables.open(), source);
    assert.equal(await tables.open(), source);
    assert.equal(source.isInitialized, true);
    assert.equal(resolved, 1, 'a memoized open resolved the source again');
  });

  it('opens with no tables to verify without a query runner', async () => {
    const source = {
      isInitialized: true,
      options: { type: 'sqljs' },
      createQueryRunner: () => {
        throw new Error('no query runner is needed for an empty table list');
      },
    } as unknown as DataSource;
    const tables = createOwnedTables({ dataSource: source, tables: [], makeError });

    assert.equal(await tables.open(), source);
  });

  it('falls back to hasTable, one table at a time, on another driver', async () => {
    const asked: string[] = [];
    const source = fallbackSource(new Set(['first']), asked);
    const tables = createOwnedTables({
      dataSource: source,
      tables: ['first', 'second'],
      makeError,
    });

    await assert.rejects(tables.open(), { message: 'missing_table: second' });
    assert.deepEqual(asked, ['first', 'second']);
  });

  it("probes PostgreSQL's current_schema() when the driver leaves schema unset", async () => {
    const sent: { sql: string; parameters: unknown[] }[] = [];
    const source = schemalessPostgresSource(['first'], sent);
    const tables = createOwnedTables({
      dataSource: source,
      tables: ['first', 'second'],
      makeError,
    });

    await assert.rejects(tables.open(), { message: 'missing_table: second' });
    assert.equal(sent.length, 1);
    const [query] = sent;
    assert.match(query?.sql ?? '', /table_schema = current_schema\(\)/);
    assert.match(query?.sql ?? '', /table_name IN \(\$1, \$2\)/);
    assert.deepEqual(query?.parameters, ['first', 'second']);
  });
});
