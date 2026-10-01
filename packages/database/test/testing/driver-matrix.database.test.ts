/**
 * The driver matrix against the run's real database: on each CI leg it opens
 * an isolated database on that server, round-trips a row, keeps two data
 * sources apart, and removes the database afterwards. In the default suite it
 * runs on SQLite.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { JsailsDataSource } from 'jsails/database';

import { forEachDriver, matrixServer, type MatrixLifecycle } from '../../src/testing/index.js';

@Entity('matrix_items')
class Item extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;
}

/** A lifecycle the test runs by hand, to observe what cleanup did. */
function manualLifecycle(): MatrixLifecycle & { run(): Promise<void> } {
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

/** The databases named `name` on the run's server. */
async function serverDatabasesNamed(name: string): Promise<number> {
  const server = matrixServer();
  const admin = new JsailsDataSource({ ...server, entities: [] });
  await admin.initialize();
  try {
    const rows: unknown[] =
      server.type === 'postgres'
        ? await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
        : await admin.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [
            name,
          ]);
    return rows.length;
  } finally {
    await admin.destroy();
  }
}

forEachDriver('driver matrix', ({ driver, open }) => {
  it('targets the driver this run names', () => {
    const expected =
      process.env.JSAILS_TEST_SUITE === 'database' ? process.env.DATABASE_TYPE : 'sqlite';
    assert.equal(driver, expected);
  });

  it('opens a database of its own with the tables created and removes it afterwards', async () => {
    const lifecycle = manualLifecycle();
    const dataSource = await open(lifecycle, { entities: [Item] });
    const database = dataSource.options.database;

    assert.equal(dataSource.jsailsDriver, driver);
    await dataSource.getRepository(Item).save({ name: 'round trip' });
    const [stored] = await dataSource.getRepository(Item).find();
    assert.equal(stored?.name, 'round trip');
    if (driver !== 'sqlite') {
      assert.match(String(database), /^jsails_m_[0-9a-f]{12}_test$/);
      assert.equal(await serverDatabasesNamed(String(database)), 1);
    }

    await lifecycle.run();
    assert.equal(dataSource.isInitialized, false);
    if (driver !== 'sqlite') assert.equal(await serverDatabasesNamed(String(database)), 0);
  });

  it('keeps two data sources apart', async (t) => {
    const first = await open(t, { entities: [Item] });
    const second = await open(t, { entities: [Item] });

    await first.getRepository(Item).save({ name: 'only in the first' });

    assert.equal(await second.getRepository(Item).count(), 0);
  });
});
