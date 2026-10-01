/**
 * One test worker, as a process of its own: `worker-databases.database.test.ts`
 * runs this script twice at once with different `NODE_TEST_WORKER_ID`s. It
 * opens a test data source on the database-suite server for the base name in
 * `JSAILS_TEST_DATABASE_BASE` (the worker id comes from the environment, as
 * under `node --test`), counts the rows it starts with, commits one row,
 * checks the guard on its own connection, and prints what it saw as one line
 * of JSON.
 */

import { resolveDatabaseConfig } from '../../../src/engine/index.js';
import { assertTestDatabase, connectedDatabase } from '../../../src/schema/index.js';
import { createTestDataSource, matrixServer, matrixServerUrl } from '../../../src/testing/index.js';
import { unguarded } from '../../../src/unguarded/index.js';
import { Category } from './testing-models.js';
import { rowCount } from './table-snapshot.js';

const server = matrixServer();
const config = resolveDatabaseConfig(
  {},
  { env: { DATABASE_URL: matrixServerUrl(server, server.database) } },
);
const ds = await createTestDataSource([Category], {
  database: { config, name: process.env.JSAILS_TEST_DATABASE_BASE ?? '' },
});
try {
  const rowsAtOpen = await rowCount(ds, Category);
  await Category.create({ name: `worker ${process.env.NODE_TEST_WORKER_ID ?? ''}` });
  const conn = await unguarded(ds).lease();
  let connected: string;
  try {
    await assertTestDatabase(conn);
    connected = await connectedDatabase(conn);
  } finally {
    await conn.release();
  }
  process.stdout.write(`${JSON.stringify({ database: ds.database, connected, rowsAtOpen })}\n`);
} finally {
  await ds.close();
}
