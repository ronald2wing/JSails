/**
 * The schema lock and the test-database guard on the run's driver:
 *
 * - two concurrent pushes are mutually exclusive: both finish, and only one
 *   applies the plan; a push that cannot get the lock in time fails with
 *   `schema.lock_timeout` and changes nothing;
 * - on a server, a push whose statements reach different sessions (a
 *   transaction-mode pooler) stops with `schema.pooled_connection` before
 *   any change;
 * - in the `test` environment a push runs only on a database whose
 *   server-reported name is a test name and that carries the harness's
 *   marker, whatever the configured `database` option says;
 * - the harness's step inside a test push runs only once the guard passed,
 *   on the push's own locked connection, and sees the live schema and the
 *   ownership the plan is computed from.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { it } from 'node:test';

import {
  createEngine,
  resolveDatabaseConfig,
  type Conn,
  type DatabaseConfig,
  type Engine,
} from '../../../src/engine/index.js';
import {
  introspect,
  markTestDatabase,
  pushSchema,
  SchemaErrors,
} from '../../../src/schema/index.js';
import {
  pushOnSession,
  pushTestSchema,
  type TestPushStep,
} from '../../../src/schema/push-schema.js';
import { acquireSchemaLock } from '../../../src/schema/session-lock.js';
import { connectedDatabase } from '../../../src/schema/test-guard.js';
import { declaredTables } from '../../../src/schema/declared-tables.js';
import {
  createMatrixDatabase,
  forEachDriver,
  lastInFirstOut,
  matrixDriver,
  matrixServer,
  matrixServerUrl,
} from '../../../src/testing/index.js';
import { matrixEngineConfig } from '../engine/fixtures/matrix-engine.js';
import { CATALOG, Scratch } from './fixtures/schema-models.js';

type Lifecycle = Parameters<typeof matrixEngineConfig>[0];

interface Fresh {
  readonly config: DatabaseConfig;
  open(config?: DatabaseConfig): Promise<Engine>;
}

async function freshDatabase(t: Lifecycle): Promise<Fresh> {
  const ordered = lastInFirstOut(t);
  const config = await matrixEngineConfig(ordered);
  return {
    config,
    async open(other = config) {
      const engine = await createEngine(other);
      ordered.after(() => engine.close());
      return engine;
    },
  };
}

async function tableNames(engine: Engine): Promise<string[]> {
  const conn = await engine.lease();
  try {
    return (await introspect(conn, engine.dialect)).tables.map((table) => table.name);
  } finally {
    await conn.release();
  }
}

/** A connection whose statements alternate between two server sessions, as a transaction pooler's do. */
function alternating(first: Conn, second: Conn): Conn {
  let turn = 0;
  return {
    dialect: first.dialect,
    query: (sql, params, options) =>
      (turn++ % 2 === 0 ? first : second).query(sql, params, options),
    release: async () => {
      await first.release();
      await second.release();
    },
  };
}

forEachDriver('schema lock', () => {
  it('runs two concurrent pushes one after the other', async (t) => {
    const { config, open } = await freshDatabase(t);
    const reports = await Promise.all([
      pushSchema({ config, models: CATALOG }, { environment: 'development' }),
      pushSchema({ config, models: CATALOG }, { environment: 'development' }),
    ]);
    assert.ok(reports.every((report) => report.complete));
    const counts = reports.map((report) => report.applied.length).sort((a, b) => a - b);
    assert.equal(counts[0], 0, 'the second push sees the first one done');
    assert.ok((counts[1] ?? 0) > 0);
    const names = await tableNames(await open());
    assert.ok(names.includes('catalog_types'));
  });

  it('times out while another push holds the lock, and changes nothing', async (t) => {
    const { config, open } = await freshDatabase(t);
    const engine = await open();
    const holder = await engine.lease();
    let release: () => Promise<void>;
    if (engine.dialect === 'sqlite') {
      await holder.query('BEGIN IMMEDIATE');
      release = async () => {
        await holder.query('ROLLBACK');
      };
    } else {
      const lock = await acquireSchemaLock(
        holder,
        engine.dialect,
        await connectedDatabase(holder),
        0,
      );
      release = lock.release;
    }
    try {
      await assert.rejects(
        pushSchema(
          { config, models: [Scratch] },
          { environment: 'development', waitLockSeconds: 0.3 },
        ),
        (error: unknown) => SchemaErrors.is(error, 'lock_timeout'),
      );
    } finally {
      await release();
      await holder.release();
    }
    assert.deepEqual(await tableNames(engine), []);
    const report = await pushSchema({ config, models: [Scratch] }, { environment: 'development' });
    assert.equal(report.complete, true);
  });

  it('stops a push through a transaction-mode pooler before any change', async (t) => {
    if (matrixDriver() === 'sqlite') {
      t.skip('a SQLite push is one transaction on its own connection');
      return;
    }
    const { config, open } = await freshDatabase(t);
    const engine = await open(Object.freeze({ ...config, pool: Object.freeze({ max: 2 }) }));
    const conn = alternating(await engine.lease(), await engine.lease());
    try {
      await assert.rejects(
        pushOnSession(conn, declaredTables([Scratch], engine.dialect), {
          environment: 'development',
          waitLockSeconds: 1,
        }),
        (error: unknown) => SchemaErrors.is(error, 'pooled_connection'),
      );
    } finally {
      await conn.release();
    }
    assert.deepEqual(await tableNames(engine), []);
  });
});

forEachDriver('schema test guard', () => {
  it('refuses a non-test database whatever the database option says', async (t) => {
    const ordered = lastInFirstOut(t);
    let config: DatabaseConfig;
    if (matrixDriver() === 'sqlite') {
      const testConfig = await matrixEngineConfig(ordered);
      assert.ok(testConfig.file !== undefined);
      config = resolveDatabaseConfig(
        { file: join(dirname(testConfig.file), 'engine.sqlite') },
        { env: {} },
      );
    } else {
      // The url names a database of its own with a non-test name (the run's
      // DATABASE_NAME may itself be a test name, as CI's jsails_test is); the
      // option names a test one.
      const server = matrixServer();
      const database = await createMatrixDatabase(ordered, 'prod');
      config = resolveDatabaseConfig(
        {
          dialect: server.type,
          host: server.host,
          port: server.port,
          user: server.username,
          database: 'app_test',
        },
        { env: { DATABASE_URL: matrixServerUrl(server, database) } },
      );
    }
    await assert.rejects(
      pushSchema({ config, models: [Scratch] }, { environment: 'test' }),
      (error: unknown) => SchemaErrors.is(error, 'non_test_database'),
    );
  });

  it('refuses a test-named database the harness did not mark, and pushes to a marked one', async (t) => {
    const { config, open } = await freshDatabase(t);
    await assert.rejects(
      pushSchema({ config, models: [Scratch] }, { environment: 'test' }),
      (error: unknown) => SchemaErrors.is(error, 'unmarked_test_database'),
    );
    const engine = await open();
    assert.deepEqual(await tableNames(engine), [], 'the refused push created nothing');

    const conn = await engine.lease();
    try {
      await markTestDatabase(conn);
    } finally {
      await conn.release();
    }
    const report = await pushSchema({ config, models: [Scratch] }, { environment: 'test' });
    assert.equal(report.complete, true);
  });

  it("runs a test push's step after the guard, on the locked connection, before the plan", async (t) => {
    const { config, open } = await freshDatabase(t);
    const steps: TestPushStep[] = [];
    const record = (step: TestPushStep): Promise<void> => {
      steps.push(step);
      return step.verify();
    };
    await assert.rejects(
      pushTestSchema({ config, models: [Scratch] }, {}, record),
      (error: unknown) => SchemaErrors.is(error, 'unmarked_test_database'),
    );
    assert.equal(steps.length, 0, 'the step never runs on a database the guard refused');
    await assert.rejects(
      pushTestSchema({ config, models: [Scratch] }, {}, undefined as never),
      (error: unknown) => SchemaErrors.is(error, 'invalid_options'),
    );
    await assert.rejects(
      pushTestSchema({ config, models: [Scratch] }, null as never, record),
      (error: unknown) => SchemaErrors.is(error, 'invalid_options'),
    );

    const engine = await open();
    const conn = await engine.lease();
    try {
      await markTestDatabase(conn);
    } finally {
      await conn.release();
    }
    const first = await pushTestSchema({ config, models: [Scratch] }, {}, record);
    assert.equal(first.complete, true);
    const [before] = steps;
    assert.ok(before !== undefined);
    assert.equal(before.owner, 'app');
    assert.equal(before.dialect, engine.dialect);
    assert.deepEqual(
      before.declared.map((table) => table.name),
      ['catalog_scratch'],
    );
    assert.ok(
      !before.live.tables.some((table) => table.name === 'catalog_scratch'),
      'the step runs before the plan applies anything',
    );

    await pushTestSchema({ config, models: [Scratch] }, {}, record);
    const after = steps[1];
    assert.ok(after !== undefined);
    assert.ok(after.live.tables.some((table) => table.name === 'catalog_scratch'));
    assert.equal(after.ownership.get('catalog_scratch'), 'app');
  });
});
