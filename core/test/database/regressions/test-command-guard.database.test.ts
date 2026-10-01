/**
 * Audit finding "`jsails test` non-test-database guard checks
 * options.database, but a `url` overrides it at connect time", against a real
 * server: options naming a `*_test` database with a `url` that selects another
 * database must not reach the destructive reconcile. M0 made the guard ask the
 * server which database it is connected to; DAT-06 adds the server-verified
 * test guard to the schema core. SQLite has no url, and the M0 unit test
 * (core/test/cli/test-command-guard.test.ts) covers its file check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { reconcileTestDatabase, TestDatabaseError } from '../../../src/cli/commands/test.js';
import { JsailsDataSource } from '../../../src/database/data-source.js';
import {
  createServerDatabase,
  lastInFirstOut,
  matrixDriver,
  matrixServer,
  serverUrl,
} from './matrix-database.js';

@Entity('regression_guarded')
class Guarded extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;
}

const driver = matrixDriver();

describe(
  'jsails test database guard',
  { skip: driver === 'sqlite' && 'a SQLite configuration has no url' },
  () => {
    it('refuses a url that selects a non-test database behind a *_test database name', async (t) => {
      const server = matrixServer();
      const cleanup = lastInFirstOut(t);
      const production = await createServerDatabase(cleanup, 'prod');
      const dataSource = new JsailsDataSource({
        type: server.type,
        url: serverUrl(server, production),
        database: 'shop_test',
        entities: [Guarded],
      });
      cleanup.after(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
      });

      await assert.rejects(
        reconcileTestDatabase(dataSource, {}),
        (error: unknown) =>
          error instanceof TestDatabaseError && error.code === 'non_test_database',
      );
      const live = await dataSource.getLiveSchema();
      assert.deepEqual(
        live.tables.map((table) => table.name),
        [],
        'the reconcile wrote to the non-test database',
      );
    });
  },
);
