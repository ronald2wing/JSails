/**
 * The driver matrix's environment handling, which needs no server: the
 * driver a run targets, value-free errors for a broken database-suite
 * environment, skip reasons, forEachDriver's limits and environment, cleanup
 * order, and an isolated SQLite database.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { DATABASE_DRIVERS } from '../../src/index.js';
import {
  driverSkipReason,
  DriverMatrixError,
  forEachDriver,
  lastInFirstOut,
  matrixDriver,
  matrixServer,
  matrixServerUrl,
  openMatrixDataSource,
} from '../../src/testing/index.js';

const execFileAsync = promisify(execFile);

const SERVER_ENV = {
  JSAILS_TEST_SUITE: 'database',
  DATABASE_TYPE: 'postgres',
  DATABASE_HOST: 'db.internal',
  DATABASE_PORT: '6543',
  DATABASE_USER: 'app',
  DATABASE_PASSWORD: 's3cret-value',
  DATABASE_NAME: 'app_test',
};

function invalidEnvironment(error: unknown): boolean {
  return (
    error instanceof DriverMatrixError &&
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

describe('matrixDriver', () => {
  it('is SQLite outside the database suite, whatever DATABASE_TYPE says', () => {
    assert.equal(matrixDriver({}), 'sqlite');
    assert.equal(matrixDriver({ DATABASE_TYPE: 'postgres' }), 'sqlite');
    assert.equal(
      matrixDriver({ JSAILS_TEST_SUITE: 'default', DATABASE_TYPE: 'mariadb' }),
      'sqlite',
    );
  });

  it('is the server DATABASE_TYPE names in the database suite', () => {
    assert.equal(
      matrixDriver({ JSAILS_TEST_SUITE: 'database', DATABASE_TYPE: 'mariadb' }),
      'mariadb',
    );
    assert.equal(
      matrixDriver({ JSAILS_TEST_SUITE: 'database', DATABASE_TYPE: 'postgres' }),
      'postgres',
    );
  });

  it('fails a database suite without a supported server, MySQL included', () => {
    for (const type of [undefined, '', 'mysql', 'sqlite', 'oracle']) {
      assert.throws(
        () => matrixDriver({ JSAILS_TEST_SUITE: 'database', DATABASE_TYPE: type }),
        invalidEnvironment,
      );
    }
  });

  it('lists the three supported drivers, and no MySQL', () => {
    assert.deepEqual(DATABASE_DRIVERS, ['sqlite', 'mariadb', 'postgres']);
  });
});

describe('matrixServer', () => {
  it('reads the server settings', () => {
    assert.deepEqual(matrixServer(SERVER_ENV), {
      type: 'postgres',
      host: 'db.internal',
      port: 6543,
      username: 'app',
      password: 's3cret-value',
      database: 'app_test',
    });
  });

  it('defaults the port per server', () => {
    const withoutPort = { ...SERVER_ENV, DATABASE_PORT: undefined };
    assert.equal(matrixServer(withoutPort).port, 5432);
    assert.equal(matrixServer({ ...withoutPort, DATABASE_TYPE: 'mariadb' }).port, 3306);
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

  it('rejects a port that is not a port number', () => {
    for (const port of ['0', '65536', '54x', ' 5432', '-1', '5432.0']) {
      assert.throws(() => matrixServer({ ...SERVER_ENV, DATABASE_PORT: port }), invalidEnvironment);
    }
  });

  it('refuses a SQLite run', () => {
    assert.throws(() => matrixServer({}), invalidEnvironment);
  });
});

describe('matrixServerUrl', () => {
  it('encodes the credentials and the database name', () => {
    const server = matrixServer({ ...SERVER_ENV, DATABASE_PASSWORD: 'p@ss/word' });
    assert.equal(
      matrixServerUrl(server, 'jsails_m_1_test'),
      'postgres://app:p%40ss%2Fword@db.internal:6543/jsails_m_1_test',
    );
    assert.match(
      matrixServerUrl({ ...server, type: 'mariadb' }, 'x'),
      /^mysql:\/\/app:p%40ss%2Fword@db\.internal:6543\/x$/,
    );
  });
});

describe('driverSkipReason', () => {
  it('runs a suite on every driver by default', () => {
    for (const driver of DATABASE_DRIVERS) assert.equal(driverSkipReason(driver), false);
  });

  it('states why a suite limited to other drivers is skipped', () => {
    assert.equal(driverSkipReason('mariadb', ['mariadb', 'postgres']), false);
    assert.equal(
      driverSkipReason('sqlite', ['mariadb', 'postgres']),
      'runs on mariadb, postgres; this run uses sqlite',
    );
  });
});

describe('forEachDriver limited to other drivers', () => {
  it('reports the suite skipped with the reason, and never runs its body', async () => {
    // node:test refuses a nested run() inside a test file, so the fixture runs
    // in a process of its own; NODE_TEST_CONTEXT would make it report to this
    // runner instead of printing its own TAP.
    const fixture = fileURLToPath(new URL('./fixtures/limited-suite.js', import.meta.url));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout } = await execFileAsync(process.execPath, ['--test-reporter=tap', fixture], {
      env,
    });

    const results = stdout.split(/\r?\n/).filter((line) => /^\s*(?:not )?ok \d/.test(line));
    assert.deepEqual(results, [
      'ok 1 - limited to the servers # SKIP runs on mariadb, postgres; this run uses sqlite',
    ]);
  });
});

void forEachDriver(
  'forEachDriver with a passed environment',
  (context) => {
    it('targets the driver that environment names', () => {
      assert.equal(context.driver, 'postgres');
    });

    it('opens data sources from that environment, not process.env', async () => {
      await assert.rejects(
        context.open(manualLifecycle(), { entities: [] }),
        (error: unknown) =>
          invalidEnvironment(error) && (error as Error).message.includes('DATABASE_HOST'),
      );
    });
  },
  { env: { JSAILS_TEST_SUITE: 'database', DATABASE_TYPE: 'postgres' } },
);

describe('lastInFirstOut', () => {
  it('runs its callbacks newest first, inside one callback of the outer lifecycle', async () => {
    const outer = manualLifecycle();
    const order: string[] = [];
    const inner = lastInFirstOut(outer);
    inner.after(() => order.push('drop the database'));
    inner.after(async () => {
      await Promise.resolve();
      order.push('close the connection');
    });

    assert.deepEqual(order, []);
    await outer.run();
    assert.deepEqual(order, ['close the connection', 'drop the database']);
  });
});

describe('openMatrixDataSource on SQLite', () => {
  @Entity('matrix_notes')
  class Note extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100 })
    body!: string;
  }

  it('opens a database of its own with the tables created, and removes it afterwards', async () => {
    const lifecycle = manualLifecycle();
    const dataSource = await openMatrixDataSource(lifecycle, { entities: [Note], env: {} });
    const location = (dataSource.options as { location: string }).location;

    assert.equal(dataSource.jsailsDriver, 'sqlite');
    await dataSource.getRepository(Note).save({ body: 'hello' });
    assert.equal(await dataSource.getRepository(Note).count(), 1);

    await lifecycle.run();
    assert.equal(dataSource.isInitialized, false);
    assert.equal(existsSync(dirname(location)), false);
  });

  it('gives each data source a different database', async () => {
    const lifecycle = manualLifecycle();
    const first = await openMatrixDataSource(lifecycle, { entities: [Note], env: {} });
    const second = await openMatrixDataSource(lifecycle, { entities: [Note], env: {} });
    try {
      await first.getRepository(Note).save({ body: 'only in the first' });
      assert.equal(await second.getRepository(Note).count(), 0);
    } finally {
      await lifecycle.run();
    }
  });

  it('leaves the tables absent with migrate: false', async () => {
    const lifecycle = manualLifecycle();
    const dataSource = await openMatrixDataSource(lifecycle, {
      entities: [Note],
      migrate: false,
      env: {},
    });
    try {
      assert.deepEqual((await dataSource.getLiveSchema()).tables, []);
    } finally {
      await lifecycle.run();
    }
  });

  it('removes its database when building the data source throws', async () => {
    const lifecycle = manualLifecycle();
    // os.tmpdir() reads these on every call, so the matrix database lands in
    // a directory this test owns and can check is empty afterwards.
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
