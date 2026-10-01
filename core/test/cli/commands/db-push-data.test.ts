/**
 * `db:push` phase-2 integration: data migrations run after schema
 * reconciliation, on every push, in declaration order, with no ledger.
 *
 * Uses a real sqljs (WASM SQLite) database through a temporary compiled config
 * module — the same `runDbPush` path a user exercises, minus the network. The
 * config module is written to disk and imported at runtime, exactly as
 * `loadDataSourceConfig`/`loadDataMigrationRegistry` do in production.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';

import { runDbDiff, runDbPush, type DbPushDeps } from '../../../src/cli/commands/db.js';
import {
  executeSchemaPlan,
  PartialSchemaPlanError,
} from '../../../src/migrations/schema-executor.js';
import { withSchemaLock, type SchemaLockDataSource } from '../../../src/migrations/schema-lock.js';

/** The environment the in-process commands run in. */
const COMMAND_ENV = { JSAILS_ENV: 'test', NODE_ENV: 'test' } as const;

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'db-push-data-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface SqlDatabase {
  exec(sql: string): { values: unknown[][] }[];
  close(): void;
}

async function readSqliteRow(dbPath: string, sql: string): Promise<unknown[][]> {
  const require = createRequire(import.meta.url);
  const initSqlJs = require('sql.js') as (config?: unknown) => Promise<unknown>;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = (await initSqlJs({ locateFile: () => wasmPath })) as {
    Database: new (data: Uint8Array) => SqlDatabase;
  };
  const db = new SQL.Database(readFileSync(dbPath));
  try {
    return db.exec(sql)[0]?.values ?? [];
  } finally {
    db.close();
  }
}

/**
 * Write a compiled config module exporting a sqljs `JsailsDataSource` (one
 * `widgets` table) plus a `dataMigrations` map. `migrations` is the raw JS
 * source for the map body. Returns the config and sqljs file paths.
 */
function writeConfig(name: string, migrations: string): { configPath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpRoot, `${name}-`));
  const dbPath = join(dir, 'data.db');
  const typeormEntry = pathToFileURL(createRequire(import.meta.url).resolve('typeorm')).href;
  const dataSourceModule = fileURLToPath(
    new URL('../../../src/database/data-source.js', import.meta.url),
  );
  const dataModule = fileURLToPath(new URL('../../../src/migrations/data.js', import.meta.url));
  const transactionModule = fileURLToPath(
    new URL('../../../src/database/transaction.js', import.meta.url),
  );
  const content = [
    `import { appendFileSync } from 'node:fs';`,
    `import { transaction } from ${JSON.stringify(pathToFileURL(transactionModule).href)};`,
    `import { JsailsDataSource } from ${JSON.stringify(pathToFileURL(dataSourceModule).href)};`,
    `import { EntitySchema } from ${JSON.stringify(typeormEntry)};`,
    `import { defineDataMigration } from ${JSON.stringify(pathToFileURL(dataModule).href)};`,
    `const Widget = new EntitySchema({ name: 'Widget', tableName: 'widgets', columns: { id: { type: Number, primary: true, generated: true }, name: { type: String, length: 100, nullable: false } } });`,
    `const Note = new EntitySchema({ name: 'Note', tableName: 'notes', columns: { id: { type: Number, primary: true, generated: true }, body: { type: String, length: 200, nullable: true }, kind: { type: String, length: 20, nullable: false } } });`,
    `export const dataMigrations = { ${migrations} };`,
    `export default new JsailsDataSource({ type: 'sqljs', location: ${JSON.stringify(dbPath)}, entities: [Widget, Note] });`,
    '',
  ].join('\n');
  const configPath = join(dir, 'jsails.database.js');
  writeFileSync(configPath, content, 'utf8');
  return { configPath, dbPath };
}

describe('db:push phase 2 — data migrations', () => {
  it('applies the schema, then runs data migrations in declaration order', async () => {
    // Two migrations insert into the declared `notes` table in order. The first
    // inserts rowid 1, the second rowid 2, so declaration order is observable.
    const insert = (kind: string): string =>
      `await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('${kind}')");`;

    const { configPath, dbPath } = writeConfig(
      'order',
      [
        `first: defineDataMigration({ name: 'first', up: async (ctx) => { ${insert('a')} }, down: async () => {} }),`,
        `second: defineDataMigration({ name: 'second', up: async (ctx) => { ${insert('b')} }, down: async () => {} }),`,
      ].join('\n'),
    );

    const code = await runDbPush(
      configPath,
      { dryRun: false, allowDestructive: false },
      COMMAND_ENV,
    );
    assert.equal(code, 0, 'push succeeds');

    const rows = await readSqliteRow(dbPath, 'SELECT kind FROM notes ORDER BY id');
    assert.deepEqual(
      rows.map((row) => row[0]),
      ['a', 'b'],
      'migrations ran in declaration order after schema creation',
    );
  });

  it('runs data migrations on every push (no ledger, idempotent by contract)', async () => {
    // A guarded backfill: inserts a row only when none of that kind exists, so a
    // second push is a no-op even though `up` runs again.
    const { configPath, dbPath } = writeConfig(
      'idempotent',
      `seed: defineDataMigration({ name: 'seed', up: async (ctx) => {
        await ctx.queryRunner.query("INSERT INTO notes (kind) SELECT 'seed' WHERE NOT EXISTS (SELECT 1 FROM notes WHERE kind = 'seed')");
      }, down: async () => {} }),`,
    );

    const first = await runDbPush(
      configPath,
      { dryRun: false, allowDestructive: false },
      COMMAND_ENV,
    );
    assert.equal(first, 0, 'first push succeeds');
    const second = await runDbPush(
      configPath,
      { dryRun: false, allowDestructive: false },
      COMMAND_ENV,
    );
    assert.equal(second, 0, 'second push succeeds');

    const rows = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'seed'");
    assert.equal(rows[0]?.[0], 1, 'idempotent guard keeps a single row across two pushes');
  });

  it('runs data migrations even when the schema is already up to date', async () => {
    // The migration is deliberately non-idempotent so the row count proves it ran
    // on both pushes, including the second where the schema needs no change.
    const { configPath, dbPath } = writeConfig(
      'uptodate',
      `bump: defineDataMigration({ name: 'bump', up: async (ctx) => {
        await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('tick')");
      }, down: async () => {} }),`,
    );

    assert.equal(
      await runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
      0,
    );
    assert.equal(
      await runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
      0,
    );

    const rows = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'tick'");
    assert.equal(rows[0]?.[0], 2, 'phase 2 runs regardless of up-to-date schema (no ledger)');
  });

  it('rolls back a failing transactional migration, keeping earlier commits', async () => {
    const insert = (kind: string): string =>
      `await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('${kind}')");`;

    const { configPath, dbPath } = writeConfig(
      'txrollback',
      [
        `first: defineDataMigration({ name: 'first', up: async (ctx) => { ${insert('kept')} }, down: async () => {} }),`,
        `second: defineDataMigration({ name: 'second', up: async (ctx) => { ${insert('rolled')}; throw new Error('boom'); }, down: async () => {} }),`,
      ].join('\n'),
    );

    await assert.rejects(
      runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
      /boom/,
    );

    const kept = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'kept'");
    assert.equal(kept[0]?.[0], 1, 'the earlier migration stays committed');
    const rolled = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'rolled'");
    assert.equal(rolled[0]?.[0], 0, 'the failing migration is rolled back');
  });

  it('leaves a non-transactional migration partially applied on failure', async () => {
    const { configPath, dbPath } = writeConfig(
      'txoptout',
      `boom: defineDataMigration({ name: 'boom', transactional: false, up: async (ctx) => {
        await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('partial')");
        throw new Error('boom');
      }, down: async () => {} }),`,
    );

    await assert.rejects(
      runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
      /boom/,
    );

    const rows = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'partial'");
    assert.equal(rows[0]?.[0], 1, 'transactional: false makes no atomicity promise');
  });

  it('orders by dependencies before declaration order', async () => {
    const insert = (kind: string): string =>
      `await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('${kind}')");`;

    const { configPath, dbPath } = writeConfig(
      'deps',
      [
        `child: defineDataMigration({ name: 'child', dependencies: ['parent'], up: async (ctx) => { ${insert('child')} }, down: async () => {} }),`,
        `parent: defineDataMigration({ name: 'parent', up: async (ctx) => { ${insert('parent')} }, down: async () => {} }),`,
      ].join('\n'),
    );

    assert.equal(
      await runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
      0,
    );
    const rows = await readSqliteRow(dbPath, 'SELECT kind FROM notes ORDER BY id');
    assert.deepEqual(
      rows.map((row) => row[0]),
      ['parent', 'child'],
      'dependency order wins over declaration order',
    );
  });

  it(
    'lets a transactional migration write through the data source and nested transactions',
    {
      timeout: 20_000,
    },
    async () => {
      // On sqljs the migration holds the one connection from its BEGIN; a write
      // through the data source's manager, DataSource.query, or a nested
      // transaction() must join that hold rather than wait for its commit.
      const marker = join(tmpRoot, `scope-commit-${Date.now()}.txt`);
      const { configPath, dbPath } = writeConfig(
        'scope',
        `joined: defineDataMigration({ name: 'joined', up: async (ctx) => {
        const ds = ctx.queryRunner.connection;
        await ds.getRepository('Note').save({ kind: 'repo' });
        await ds.query("INSERT INTO notes (kind) VALUES ('query')");
        await transaction(ds, async (tx) => {
          await tx.manager.getRepository('Note').save({ kind: 'nested' });
          tx.afterCommit(() => appendFileSync(${JSON.stringify(marker)}, 'commit\\n'));
          tx.afterRollback(() => appendFileSync(${JSON.stringify(marker)}, 'rollback\\n'));
        });
      }, down: async () => {} }),`,
      );

      assert.equal(
        await runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
        0,
      );
      const rows = await readSqliteRow(dbPath, 'SELECT kind FROM notes ORDER BY id');
      assert.deepEqual(
        rows.map((row) => row[0]),
        ['repo', 'query', 'nested'],
      );
      assert.equal(readFileSync(marker, 'utf8'), 'commit\n', 'afterCommit runs once, after commit');
    },
  );

  it(
    'rolls back data-source writes with the migration and runs afterRollback',
    {
      timeout: 20_000,
    },
    async () => {
      const marker = join(tmpRoot, `scope-rollback-${Date.now()}.txt`);
      const { configPath, dbPath } = writeConfig(
        'scoperollback',
        `doomed: defineDataMigration({ name: 'doomed', up: async (ctx) => {
        const ds = ctx.queryRunner.connection;
        await ds.getRepository('Note').save({ kind: 'doomed' });
        await transaction(ds, async (tx) => {
          tx.afterCommit(() => appendFileSync(${JSON.stringify(marker)}, 'commit\\n'));
          tx.afterRollback(() => appendFileSync(${JSON.stringify(marker)}, 'rollback\\n'));
        });
        throw new Error('boom');
      }, down: async () => {} }),`,
      );

      await assert.rejects(
        runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV),
        /boom/,
      );
      const rows = await readSqliteRow(dbPath, "SELECT COUNT(*) FROM notes WHERE kind = 'doomed'");
      assert.equal(rows[0]?.[0], 0, 'the write through the data source rolled back');
      assert.equal(readFileSync(marker, 'utf8'), 'rollback\n');
    },
  );

  it('db:diff --sql prints driver SQL without applying the plan', async () => {
    const { configPath, dbPath } = writeConfig('sqlpreview', '');
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const code = await runDbDiff(configPath, { sql: true }, COMMAND_ENV);
      assert.equal(code, 0);
    } finally {
      console.log = original;
    }

    const output = lines.join('\n');
    assert.match(output, /-- create_table widgets/);
    assert.match(output, /CREATE TABLE "widgets"/);
    assert.throws(() => readFileSync(dbPath), /ENOENT/, 'preview did not create the database');
  });

  it('dry-run prints what it would run and applies nothing', async () => {
    // The migration appends to a marker file, so its non-execution is observable
    // even though a dry run never creates (or reads) the database file.
    const marker = join(tmpRoot, `dryrun-marker-${Date.now()}.txt`);
    const { configPath } = writeConfig(
      'dryrun',
      `nope: defineDataMigration({ name: 'nope', up: async () => {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(${JSON.stringify(marker)}, 'ran\\n');
      }, down: async () => {} }),`,
    );

    const code = await runDbPush(
      configPath,
      { dryRun: true, allowDestructive: false },
      COMMAND_ENV,
    );
    assert.equal(code, 0, 'dry run succeeds');

    // The marker file was never created: phase 2 did not run under --dry-run.
    assert.throws(() => readFileSync(marker, 'utf8'), /ENOENT/, 'dry run runs no data migration');
  });
});

/** Collect console output for the duration of `fn`. */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T | undefined; error: unknown; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '));
  try {
    return { result: await fn(), error: undefined, out, err };
  } catch (error) {
    return { result: undefined, error, out, err };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('db:push schema lock', () => {
  /** A lock that records whether work ran inside it, delegating to the real one. */
  function recordingLock(): {
    deps: DbPushDeps;
    calls: { initialized: boolean }[];
    executedInsideLock: boolean[];
  } {
    const calls: { initialized: boolean }[] = [];
    const executedInsideLock: boolean[] = [];
    let held = false;
    const deps: DbPushDeps = {
      withSchemaLock: async <T>(dataSource: SchemaLockDataSource, fn: () => Promise<T>) => {
        calls.push({ initialized: dataSource.isInitialized });
        return withSchemaLock(dataSource, async () => {
          held = true;
          try {
            return await fn();
          } finally {
            held = false;
          }
        });
      },
      executeSchemaPlan: async (dataSource, operations) => {
        executedInsideLock.push(held);
        return executeSchemaPlan(dataSource, operations);
      },
    };
    return { deps, calls, executedInsideLock };
  }

  it('applies the plan while holding the lock on an initialized data source', async () => {
    const { configPath, dbPath } = writeConfig('locked', '');
    const { deps, calls, executedInsideLock } = recordingLock();

    const { result } = await captureConsole(() =>
      runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV, deps),
    );

    assert.equal(result, 0);
    assert.deepEqual(calls, [{ initialized: true }], 'one lock, taken after initialize');
    assert.deepEqual(executedInsideLock, [true], 'the plan is applied under the lock');
    const tables = await readSqliteRow(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets'",
    );
    assert.equal(tables.length, 1);
  });

  it('takes the lock for a dry run too', async () => {
    const { configPath } = writeConfig('lockeddry', '');
    const { deps, calls, executedInsideLock } = recordingLock();

    const { result, out } = await captureConsole(() =>
      runDbPush(configPath, { dryRun: true, allowDestructive: false }, COMMAND_ENV, deps),
    );

    assert.equal(result, 0);
    assert.equal(calls.length, 1, 'the dry-run plan is computed under the lock');
    assert.deepEqual(executedInsideLock, [], 'nothing is applied');
    assert.ok(out.includes('create_table widgets'));
  });

  it('prints the applied operations and a re-run hint for a partial plan', async () => {
    const insert = `await ctx.queryRunner.query("INSERT INTO notes (kind) VALUES ('x')");`;
    const marker = join(tmpRoot, `partial-marker-${Date.now()}.txt`);
    const { configPath } = writeConfig(
      'partial',
      `later: defineDataMigration({ name: 'later', up: async (ctx) => {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(${JSON.stringify(marker)}, 'ran\\n');
        ${insert}
      }, down: async () => {} }),`,
    );
    const deps: DbPushDeps = {
      withSchemaLock,
      executeSchemaPlan: async (_dataSource, operations) => {
        const [first, second] = operations;
        assert.ok(first !== undefined && second !== undefined, 'the plan has two operations');
        throw new PartialSchemaPlanError([first], second, operations.length, new Error('driver'));
      },
    };

    const { error, err } = await captureConsole(() =>
      runDbPush(configPath, { dryRun: false, allowDestructive: false }, COMMAND_ENV, deps),
    );

    assert.ok(error instanceof PartialSchemaPlanError, 'the error still fails the command');
    const output = err.join('\n');
    assert.match(output, /1 operation\(s\) were applied before the failure/);
    assert.match(output, /^ {2}create_table /m);
    assert.match(output, /re-run db:push to resume/);
    assert.throws(() => readFileSync(marker, 'utf8'), /ENOENT/, 'data migrations did not run');
  });
});
