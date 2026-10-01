/**
 * The `jsails test` connected-database guard: the destructive reconcile runs
 * only when the database the server reports, not the one the options name,
 * passes the test-name rule.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import {
  assertConnectedToTestDatabase,
  connectedDatabaseName,
  reconcileTestDatabase,
  runTestCommand,
  TestDatabaseErrors,
  type ConnectedDataSource,
} from '../../src/cli/commands/test.js';
import { JsailsDataSource } from '../../src/database/data-source.js';

@Entity('guard_widgets')
class GuardWidget {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  label!: string;
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-test-guard-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A connected server data source whose options ask for one database while the server uses another. */
function serverDataSource(
  type: string,
  requested: string,
  reported: unknown,
): ConnectedDataSource & { readonly queries: string[] } {
  const queries: string[] = [];
  return {
    options: { type, database: requested } as { type: string },
    driver: { options: { database: requested } },
    queries,
    query: async (sql: string) => {
      queries.push(sql);
      return [{ name: reported }];
    },
  };
}

describe('connectedDatabaseName', () => {
  it('asks postgres for current_database()', async () => {
    const dataSource = serverDataSource('postgres', 'shop_test', 'shop');
    assert.equal(await connectedDatabaseName(dataSource), 'shop');
    assert.deepEqual(dataSource.queries, ['SELECT current_database() AS name']);
  });

  it('asks mariadb and mysql for DATABASE()', async () => {
    for (const type of ['mariadb', 'mysql']) {
      const dataSource = serverDataSource(type, 'shop_test', 'shop_test');
      assert.equal(await connectedDatabaseName(dataSource), 'shop_test');
      assert.deepEqual(dataSource.queries, ['SELECT DATABASE() AS name']);
    }
  });

  it('reads the file the sqljs driver loaded', async () => {
    const location = join(tmpRoot, 'name_test.sqlite');
    const dataSource = new JsailsDataSource({ type: 'sqljs', location, entities: [] });
    assert.equal(await connectedDatabaseName(dataSource), location);
  });

  it('answers undefined when the server reports no database', async () => {
    assert.equal(
      await connectedDatabaseName(serverDataSource('mariadb', 'x_test', null)),
      undefined,
    );
  });
});

describe('assertConnectedToTestDatabase', () => {
  it('refuses a connection a url pointed at a non-test database, value-free', async () => {
    // options.database passes the name rule; the server says otherwise.
    const dataSource = serverDataSource('postgres', 'shop_test', 'shop');
    await assert.rejects(assertConnectedToTestDatabase(dataSource), (error: unknown) => {
      assert.ok(TestDatabaseErrors.is(error));
      assert.equal(error.code, 'test_database.non_test_database');
      assert.doesNotMatch(error.message, /shop/);
      return true;
    });
  });

  it('refuses a connection that reports no database', async () => {
    await assert.rejects(
      assertConnectedToTestDatabase(serverDataSource('mariadb', 'shop_test', null)),
      (error: unknown) => TestDatabaseErrors.is(error, 'unknown_database'),
    );
  });

  it('accepts a connection the server confirms is a test database', async () => {
    await assertConnectedToTestDatabase(serverDataSource('mariadb', 'shop', 'shop_test'));
  });
});

describe('reconcileTestDatabase connected-database guard', () => {
  const tables = async (dataSource: JsailsDataSource): Promise<string[]> => {
    const rows = await dataSource.query<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guard_widgets'",
    );
    return rows.map((row) => row.name);
  };

  it('refuses before writing when the connected database is not a test database', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'production.sqlite'),
      entities: [GuardWidget],
    });
    try {
      await assert.rejects(reconcileTestDatabase(dataSource, {}), (error: unknown) =>
        TestDatabaseErrors.is(error),
      );
      assert.deepEqual(await tables(dataSource), []);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
  });

  it('reconciles a non-test database only with allowNonTestDatabase', async () => {
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location: join(tmpRoot, 'scratch.sqlite'),
      entities: [GuardWidget],
    });
    try {
      await reconcileTestDatabase(dataSource, { allowNonTestDatabase: true });
      assert.deepEqual(await tables(dataSource), ['guard_widgets']);
    } finally {
      if (dataSource.isInitialized) await dataSource.destroy();
    }
  });
});

describe('runTestCommand NODE_ENV guard', () => {
  it('refuses before loading anything when NODE_ENV names another environment', async () => {
    const err: string[] = [];
    let touched = 0;
    const code = await runTestCommand(
      { noServices: true, watch: false },
      {
        cwd: tmpRoot,
        stdout: () => {},
        stderr: (line) => err.push(line),
        env: { NODE_ENV: 'development' },
        runServices: async () => {
          touched += 1;
          return { kind: 'exited', code: 0 };
        },
        loadDataSource: async () => {
          touched += 1;
          throw new Error('must not load');
        },
        reconcileDataSource: async () => {
          touched += 1;
        },
        runTests: async () => {
          touched += 1;
          return 0;
        },
      },
    );
    assert.equal(code, 1);
    assert.equal(touched, 0);
    assert.match(err.join('\n'), /NODE_ENV=test/);
    assert.ok(!err.join('\n').includes('development'));
  });
});
