/**
 * The regression opener's environment handling and cleanup, which need no
 * server: it must behave like `@jsails/database`'s driver matrix (the run picks
 * the driver, a broken database-suite environment fails value-free, an empty
 * DATABASE_PORT means the default port) until DAT-15 merges the two.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import {
  lastInFirstOut,
  MatrixEnvironmentError,
  matrixDriver,
  matrixServer,
  openMatrixDataSource,
  serverUrl,
} from './matrix-database.js';

const SERVER_ENV = {
  JSAILS_TEST_SUITE: 'database',
  DATABASE_TYPE: 'mariadb',
  DATABASE_HOST: 'db.internal',
  DATABASE_PORT: '6543',
  DATABASE_USER: 'app',
  DATABASE_PASSWORD: 's3cret-value',
  DATABASE_NAME: 'app_test',
};

function invalidEnvironment(error: unknown): boolean {
  return (
    error instanceof MatrixEnvironmentError &&
    error.code === 'invalid_environment' &&
    !error.message.includes('s3cret-value') &&
    !error.message.includes('db.internal')
  );
}

/** A lifecycle the test runs by hand, to observe what cleanup did. */
function manualLifecycle(): { after(callback: () => unknown): void; run(): Promise<void> } {
  const callbacks: (() => unknown)[] = [];
  return {
    after: (callback) => {
      callbacks.push(callback);
    },
    run: async () => {
      for (const callback of callbacks) await callback();
    },
  };
}

describe('regression matrix environment', () => {
  it('is SQLite outside the database suite, whatever DATABASE_TYPE says', () => {
    assert.equal(matrixDriver({}), 'sqlite');
    assert.equal(
      matrixDriver({ JSAILS_TEST_SUITE: 'default', DATABASE_TYPE: 'postgres' }),
      'sqlite',
    );
  });

  it('is the server DATABASE_TYPE names in the database suite, and never MySQL', () => {
    assert.equal(matrixDriver(SERVER_ENV), 'mariadb');
    assert.equal(matrixDriver({ ...SERVER_ENV, DATABASE_TYPE: 'postgres' }), 'postgres');
    for (const type of [undefined, '', 'mysql', 'sqlite']) {
      assert.throws(() => matrixDriver({ ...SERVER_ENV, DATABASE_TYPE: type }), invalidEnvironment);
    }
  });

  it('reads the server settings', () => {
    assert.deepEqual(matrixServer(SERVER_ENV), {
      type: 'mariadb',
      host: 'db.internal',
      port: 6543,
      username: 'app',
      password: 's3cret-value',
      database: 'app_test',
    });
  });

  it('uses the default port when DATABASE_PORT is unset or empty', () => {
    for (const port of [undefined, '']) {
      const env = { ...SERVER_ENV, DATABASE_PORT: port };
      assert.equal(matrixServer(env).port, 3306);
      assert.equal(matrixServer({ ...env, DATABASE_TYPE: 'postgres' }).port, 5432);
    }
  });

  it('rejects a port that is not a port number', () => {
    for (const port of ['0', '65536', '54x', ' 5432', '-1', '5432.0']) {
      assert.throws(() => matrixServer({ ...SERVER_ENV, DATABASE_PORT: port }), invalidEnvironment);
    }
  });

  it('names every missing variable without echoing any value', () => {
    assert.throws(
      () => matrixServer({ ...SERVER_ENV, DATABASE_HOST: '', DATABASE_NAME: undefined }),
      (error: unknown) =>
        invalidEnvironment(error) &&
        (error as Error).message.includes('DATABASE_HOST') &&
        (error as Error).message.includes('DATABASE_NAME') &&
        !(error as Error).message.includes('DATABASE_USER'),
    );
  });

  it('refuses a SQLite run', () => {
    assert.throws(() => matrixServer({}), invalidEnvironment);
  });

  it('encodes the credentials and the database name into a URL', () => {
    const server = matrixServer({ ...SERVER_ENV, DATABASE_PASSWORD: 'p@ss/word' });
    assert.equal(
      serverUrl(server, 'jsails_m_1_test'),
      'mysql://app:p%40ss%2Fword@db.internal:6543/jsails_m_1_test',
    );
    assert.match(serverUrl({ ...server, type: 'postgres' }, 'x'), /^postgres:\/\//);
  });
});

describe('regression matrix cleanup', () => {
  @Entity('matrix_regression_notes')
  class Note extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    body!: string;
  }

  it('runs lastInFirstOut callbacks newest first, inside one outer callback', async () => {
    const outer = manualLifecycle();
    const order: string[] = [];
    const inner = lastInFirstOut(outer);
    inner.after(() => order.push('drop the database'));
    inner.after(() => order.push('close the connection'));

    await outer.run();
    assert.deepEqual(order, ['close the connection', 'drop the database']);
  });

  it('opens a SQLite database of its own and removes it afterwards', async () => {
    const lifecycle = manualLifecycle();
    const dataSource = await openMatrixDataSource(lifecycle, { entities: [Note], env: {} });
    const location = (dataSource.options as { location: string }).location;

    await dataSource.getRepository(Note).save({ body: 'hello' });
    assert.equal(await dataSource.getRepository(Note).count(), 1);

    await lifecycle.run();
    assert.equal(dataSource.isInitialized, false);
    assert.equal(existsSync(dirname(location)), false);
  });

  it('removes its database when building the data source throws', async () => {
    const lifecycle = manualLifecycle();
    // os.tmpdir() reads these on every call, so the opener's database lands
    // in a directory this test owns and can check is empty afterwards.
    const parent = mkdtempSync(join(tmpdir(), 'jsails-matrix-cleanup-'));
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    Object.assign(process.env, { TMPDIR: parent, TMP: parent, TEMP: parent });
    try {
      const entities = {
        [Symbol.iterator](): Iterator<Function> {
          throw new Error('the entity list cannot be read');
        },
      } as unknown as readonly Function[];
      await assert.rejects(
        openMatrixDataSource(lifecycle, { entities, env: {} }),
        /the entity list cannot be read/,
      );
      assert.equal(readdirSync(parent).length, 1);

      await lifecycle.run();
      assert.deepEqual(readdirSync(parent), []);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
