/**
 * Critic prediction "on MariaDB, two apps configured by `url` share one schema
 * lock name", seen from the side that loses data: the MySQL/MariaDB lock name
 * digests `options.database`, which is empty when the connection is configured
 * by `url`. A push configured by `url` and one configured by `database` against
 * the same database therefore take different locks and run at the same time.
 * PostgreSQL's advisory lock is per database, so it serializes them; SQLite
 * runs in one process and takes no lock. DAT-06 replaces the lock with a
 * verified session lock named from the connected database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsailsDataSource } from '../../../src/database/data-source.js';
import { withSchemaLock } from '../../../src/migrations/schema-lock.js';
import { MigrationError } from '../../../src/migrations/schema-types.js';
import {
  createServerDatabase,
  lastInFirstOut,
  matrixDriver,
  matrixServer,
  serverUrl,
  type MatrixLifecycle,
} from './matrix-database.js';

const driver = matrixDriver();

async function connect(
  lifecycle: MatrixLifecycle,
  options: ConstructorParameters<typeof JsailsDataSource>[0],
): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource(options);
  await dataSource.initialize();
  lifecycle.after(() => dataSource.destroy());
  return dataSource;
}

describe('schema lock', { skip: driver === 'sqlite' && 'SQLite takes no schema lock' }, () => {
  it('a url-configured push waits for a database-configured push to the same database', async (t) => {
    const server = matrixServer();
    const cleanup = lastInFirstOut(t);
    const database = await createServerDatabase(cleanup);
    const byName = await connect(cleanup, {
      type: server.type,
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      database,
    });
    const byUrl = await connect(cleanup, { type: server.type, url: serverUrl(server, database) });

    let second: unknown;
    await withSchemaLock(byName, async () => {
      second = await withSchemaLock(byUrl, async () => 'acquired', {
        timeoutSeconds: 0,
        pollIntervalMs: 10,
      }).catch((error: unknown) => error);
    });

    assert.ok(
      second instanceof MigrationError && second.code === 'lock_timeout',
      'the url-configured push took the schema lock while the other push held it',
    );
  });
});
