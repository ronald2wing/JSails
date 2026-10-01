/**
 * `createTestDataSource` on SQLite, per-worker names, and the matrix's test
 * database: a temp-file database passes the guard, starts empty, and its
 * directory is gone after `close()` (the Windows leg runs this file, where
 * an open file cannot be unlinked); `:memory:` creates its tables through
 * the data source; malformed options are refused; and every per-worker name
 * passes the guard's identity check.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, it } from 'node:test';

import { assertTestDatabase, isTestDatabaseName } from '../../src/schema/index.js';
import { runWithTenant } from '../../src/statement/index.js';
import {
  createTestDataSource,
  matrixTestDatabase,
  testDatabaseName,
  TestingErrors,
  type TestServerDatabase,
} from '../../src/testing/index.js';
import { unguarded } from '../../src/unguarded/index.js';
import { Author, Category, Post, TESTING_MODELS } from './fixtures/testing-models.js';
import { rowCount } from './fixtures/table-snapshot.js';

const isTesting =
  (code: string) =>
  (error: unknown): boolean =>
    TestingErrors.is(error, code as never);

describe('createTestDataSource', () => {
  it('opens a temp-file SQLite test database and removes it on close', async () => {
    const ds = await createTestDataSource(TESTING_MODELS);
    const directory = dirname(ds.database);
    try {
      assert.equal(basename(ds.database), 'app_test.sqlite');
      assert.ok(existsSync(ds.database), 'the database is a file');
      const conn = await unguarded(ds).lease();
      try {
        await assertTestDatabase(conn);
      } finally {
        await conn.release();
      }
      await runWithTenant(1, async () => {
        const author = await Author.create({ name: 'ada' });
        await Post.create({ authorId: author.id, title: 'a' });
      });
      assert.equal(await rowCount(ds, Post), 1);
    } finally {
      await ds.close();
    }
    assert.equal(existsSync(directory), false, 'close removed the directory and the WAL files');
    assert.equal(await ds.close(), undefined, 'a second close returns the first');
  });

  it('opens a :memory: database with its tables created', async () => {
    const ds = await createTestDataSource([Category], { database: 'memory' });
    try {
      assert.equal(ds.database, ':memory:');
      await Category.create({ name: 'root' });
      assert.equal(await rowCount(ds, Category), 1);
    } finally {
      await ds.close();
    }
  });

  it('refuses a model bound to another open data source', async () => {
    const first = await createTestDataSource([Category], { database: 'memory' });
    try {
      await assert.rejects(createTestDataSource([Category]), {
        code: 'data_source.already_bound',
      });
    } finally {
      await first.close();
    }
  });

  it('refuses malformed options', async () => {
    await assert.rejects(createTestDataSource('models' as never), isTesting('invalid_options'));
    await assert.rejects(
      createTestDataSource([], { unknown: true } as never),
      isTesting('invalid_options'),
    );
    await assert.rejects(
      createTestDataSource([], { database: 'disk' as never }),
      isTesting('invalid_options'),
    );
    const sqlite = matrixTestDatabase({});
    assert.equal(sqlite, 'file');
    await assert.rejects(
      createTestDataSource([], { database: { config: {} } as never }),
      isTesting('invalid_options'),
    );
    const server = matrixTestDatabase({
      JSAILS_TEST_SUITE: 'database',
      DATABASE_TYPE: 'postgres',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_USER: 'jsails',
      DATABASE_PASSWORD: 'secret',
      DATABASE_NAME: 'jsails',
    }) as TestServerDatabase;
    await assert.rejects(
      createTestDataSource([], { database: { ...server, extra: 1 } as never }),
      isTesting('invalid_options'),
    );
    await assert.rejects(
      createTestDataSource([], { database: { ...server, drop: 'yes' } as never }),
      isTesting('invalid_options'),
    );
    await assert.rejects(
      createTestDataSource([], { database: { ...server, workerId: 'a/b' } }),
      isTesting('invalid_database_name'),
    );
  });
});

describe('matrixTestDatabase', () => {
  it('is a fresh file on SQLite and a dropped random database on a server', () => {
    assert.equal(matrixTestDatabase({}), 'file');
    const env = {
      JSAILS_TEST_SUITE: 'database',
      DATABASE_TYPE: 'mariadb',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '33331',
      DATABASE_USER: 'jsails',
      DATABASE_PASSWORD: 'p@ss word',
      DATABASE_NAME: 'jsails',
    };
    const first = matrixTestDatabase(env) as TestServerDatabase;
    const second = matrixTestDatabase(env) as TestServerDatabase;
    assert.equal(first.config.dialect, 'mariadb');
    assert.equal(first.config.connection?.database, 'jsails');
    assert.equal(first.config.connection?.password, 'p@ss word');
    assert.equal(first.config.connection?.port, 33331);
    assert.match(first.name ?? '', /^jsails_m_[0-9a-f]{12}$/);
    assert.notEqual(first.name, second.name);
    assert.equal(first.workerId, null);
    assert.equal(first.drop, true);
  });
});

describe('testDatabaseName', () => {
  it('names one database per worker, each a test name', () => {
    assert.equal(testDatabaseName('app', null), 'app_test');
    assert.equal(testDatabaseName('app', 3), 'app_w3_test');
    assert.equal(testDatabaseName('app', '12'), 'app_w12_test');
    assert.equal(testDatabaseName('app_test', '2'), 'app_w2_test');
    assert.equal(testDatabaseName('App_Testing', null), 'App_test');
    assert.equal(testDatabaseName('shop_tests', 'a1'), 'shop_wa1_test');
    for (const name of ['app_test', 'app_w3_test', 'App_test', 'shop_wa1_test']) {
      assert.ok(isTestDatabaseName(name), `${name} passes the guard's identity check`);
    }
  });

  it('takes the worker from NODE_TEST_WORKER_ID by default', () => {
    const worker = process.env.NODE_TEST_WORKER_ID;
    assert.equal(
      testDatabaseName('app'),
      worker === undefined ? 'app_test' : `app_w${worker}_test`,
    );
  });

  it('refuses a malformed base, worker id or length', () => {
    for (const base of ['', 'app-db', 'app db', '_test']) {
      assert.throws(() => testDatabaseName(base, null), isTesting('invalid_database_name'));
    }
    assert.throws(() => testDatabaseName(42 as never, null), isTesting('invalid_database_name'));
    for (const worker of ['a/b', '', 'x'.repeat(17), 1.5]) {
      assert.throws(() => testDatabaseName('app', worker), isTesting('invalid_database_name'));
    }
    assert.throws(() => testDatabaseName('a'.repeat(59), '1'), isTesting('invalid_database_name'));
    assert.equal(testDatabaseName('a'.repeat(58), null).length, 63);
  });
});
