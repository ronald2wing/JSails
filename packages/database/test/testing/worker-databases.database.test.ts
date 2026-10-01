/**
 * Per-worker test databases on a server (the MariaDB and PostgreSQL legs):
 * two worker processes started at once with `NODE_TEST_WORKER_ID` 1 and 2
 * each get a database of their own, created, marked and checked by the
 * guard; a later run of a worker reuses its database and starts from empty
 * tables; a database the harness created and could not prepare is dropped;
 * and a database of a worker's name that the harness did not create is
 * refused.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'node:test';

import {
  createEngine,
  resolveDatabaseConfig,
  type DatabaseConfig,
  type SqlValue,
} from '../../src/engine/index.js';
import { column, defineTable } from '../../src/model/index.js';
import { quoteName } from '../../src/schema/emit.js';
import {
  createTestDataSource,
  forEachDriver,
  matrixServer,
  matrixServerUrl,
  testDatabaseName,
} from '../../src/testing/index.js';
import { Category } from './fixtures/testing-models.js';

const run = promisify(execFile);
const WORKER_SCRIPT = fileURLToPath(new URL('./fixtures/worker-database.js', import.meta.url));

interface WorkerReport {
  readonly database: string;
  readonly connected: string;
  readonly rowsAtOpen: number;
}

/** Run the worker script as test worker `worker`, for databases named from `base`. */
async function runWorker(worker: string, base: string): Promise<WorkerReport> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_TEST_WORKER_ID: worker,
    JSAILS_TEST_DATABASE_BASE: base,
  };
  // The script is a plain process, not a child of this test runner.
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await run(process.execPath, [WORKER_SCRIPT], { env });
  return JSON.parse(stdout.trim()) as WorkerReport;
}

async function administer(
  config: DatabaseConfig,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<readonly unknown[]> {
  const engine = await createEngine(config, { purpose: 'migration' });
  try {
    const conn = await engine.lease();
    try {
      return (await conn.query(sql, params)).rows;
    } finally {
      await conn.release();
    }
  } finally {
    await engine.close();
  }
}

async function databaseExists(
  config: DatabaseConfig,
  dialect: 'mariadb' | 'postgres',
  name: string,
): Promise<boolean> {
  const rows = await administer(
    config,
    dialect === 'postgres'
      ? 'SELECT 1 AS found FROM pg_database WHERE datname = $1'
      : 'SELECT 1 AS found FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [name],
  );
  return rows.length > 0;
}

void forEachDriver(
  'per-worker test databases',
  ({ driver }) => {
    it('gives parallel workers databases of their own, each passing the guard', async (t) => {
      const server = matrixServer();
      const admin = resolveDatabaseConfig(
        {},
        { env: { DATABASE_URL: matrixServerUrl(server, server.database) } },
      );
      const dialect = driver === 'postgres' ? 'postgres' : 'mariadb';
      const base = `jsails_m_${randomBytes(6).toString('hex')}`;
      const names = ['1', '2', '8', '9'].map((worker) => testDatabaseName(base, worker));
      t.after(async () => {
        for (const name of names) {
          const quoted = quoteName(dialect, name);
          await administer(
            admin,
            dialect === 'postgres'
              ? `DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`
              : `DROP DATABASE IF EXISTS ${quoted}`,
          );
        }
      });

      // Both workers finish before anything is judged, so the cleanup below
      // never runs while one of them is still creating its database.
      const settled = await Promise.allSettled([runWorker('1', base), runWorker('2', base)]);
      const [first, second] = settled.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      assert.ok(first !== undefined && second !== undefined);
      assert.equal(first.database, `${base}_w1_test`);
      assert.equal(second.database, `${base}_w2_test`);
      assert.equal(first.connected, first.database, 'worker 1 is connected to its own database');
      assert.equal(second.connected, second.database, 'worker 2 is connected to its own database');
      assert.deepEqual([first.rowsAtOpen, second.rowsAtOpen], [0, 0]);

      const again = await runWorker('1', base);
      assert.equal(again.database, first.database, 'a later run reuses the worker database');
      assert.equal(again.rowsAtOpen, 0, 'the committed row of the earlier run was emptied');

      const Duplicate = defineTable({
        table: 'ts_categories',
        columns: { title: column.string(10) },
      });
      await assert.rejects(
        createTestDataSource([Category, Duplicate], {
          database: { config: admin, name: base, workerId: '8' },
        }),
        { code: 'schema.duplicate_table' },
      );
      assert.equal(
        await databaseExists(admin, dialect, names[2] ?? ''),
        false,
        'a database the harness created and could not prepare is dropped',
      );

      await administer(admin, `CREATE DATABASE ${quoteName(dialect, names[3] ?? '')}`);
      await assert.rejects(
        createTestDataSource([Category], {
          database: { config: admin, name: base, workerId: '9' },
        }),
        { code: 'schema.unmarked_test_database' },
      );
    });
  },
  { drivers: ['mariadb', 'postgres'] },
);
