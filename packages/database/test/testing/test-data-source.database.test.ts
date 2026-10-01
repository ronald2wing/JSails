/**
 * A kept server test database across runs (the MariaDB and PostgreSQL legs):
 *
 * - rows a killed run or a committing test left behind never block the next
 *   run's push: a new required column, a unique index over duplicate values,
 *   and a model removed while its rows still reference a kept table all
 *   apply, and the run starts from empty tables;
 * - a configuration with a separate migration connection creates, marks,
 *   empties, pushes and drops through that connection alone, so app
 *   credentials that cannot create anything never take part.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { it } from 'node:test';

import {
  createEngine,
  resolveDatabaseConfig,
  type DatabaseConfig,
  type SqlValue,
} from '../../src/engine/index.js';
import { column, defineModel } from '../../src/model/index.js';
import { ApplicationRecord } from '../../src/record/index.js';
import { quoteName } from '../../src/schema/emit.js';
import { assertTestDatabase, introspect } from '../../src/schema/index.js';
import {
  createTestDataSource,
  forEachDriver,
  matrixServer,
  matrixServerUrl,
} from '../../src/testing/index.js';
import { rowCount } from './fixtures/table-snapshot.js';

class ParentV1 extends ApplicationRecord {
  declare id: number;
  declare title: string;
}

class ChildV1 extends ApplicationRecord {
  declare id: number;
  declare parentId: number;
  declare note: string;
}

class ParentV2 extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare slug: string;
}

defineModel(ParentV1, { table: 'td_parents', columns: { title: column.string(40) } });
defineModel(ChildV1, {
  table: 'td_children',
  columns: { note: column.string(40) },
  relations: { parent: { kind: 'belongsTo', target: () => ParentV1 } },
});
// A required column with no default and a unique index, both of which a
// table with rows (two of them sharing a title) would refuse.
defineModel(ParentV2, {
  table: 'td_parents',
  columns: { title: column.string(40), slug: column.string(40) },
  indexes: [{ columns: ['title'], unique: true }],
});

type ServerDialect = 'mariadb' | 'postgres';

async function administer(
  config: DatabaseConfig,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<readonly unknown[]> {
  const engine = await createEngine(config, { purpose: 'migration' });
  try {
    const conn = await engine.lease();
    try {
      return (await conn.query(sql, params)).rows;
    } finally {
      await conn.release();
    }
  } finally {
    await engine.close();
  }
}

async function databaseExists(
  config: DatabaseConfig,
  dialect: ServerDialect,
  name: string,
): Promise<boolean> {
  const rows = await administer(
    config,
    dialect === 'postgres'
      ? 'SELECT 1 AS found FROM pg_database WHERE datname = $1'
      : 'SELECT 1 AS found FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [name],
  );
  return rows.length > 0;
}

/** A fresh base name, whose `<base>_test` database is dropped after the test. */
function freshBase(
  t: { after(fn: () => Promise<void>): void },
  admin: DatabaseConfig,
  dialect: ServerDialect,
): string {
  const base = `jsails_m_${randomBytes(6).toString('hex')}`;
  t.after(async () => {
    const quoted = quoteName(dialect, `${base}_test`);
    await administer(
      admin,
      dialect === 'postgres'
        ? `DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`
        : `DROP DATABASE IF EXISTS ${quoted}`,
    );
  });
  return base;
}

function adminConfig(): DatabaseConfig {
  const server = matrixServer();
  return resolveDatabaseConfig(
    {},
    { env: { DATABASE_URL: matrixServerUrl(server, server.database) } },
  );
}

void forEachDriver(
  'kept server test databases',
  ({ driver }) => {
    const dialect: ServerDialect = driver === 'postgres' ? 'postgres' : 'mariadb';

    it('empties leftover rows before the push, so no change the plan makes is refused', async (t) => {
      const admin = adminConfig();
      const base = freshBase(t, admin, dialect);
      const database = { config: admin, name: base, workerId: null };

      // An earlier run that committed rows and was not cleaned up after.
      const first = await createTestDataSource([ParentV1, ChildV1], { database });
      try {
        const parent = await ParentV1.create({ title: 'same' });
        await ParentV1.create({ title: 'same' });
        await ChildV1.create({ parentId: parent.id, note: 'left behind' });
      } finally {
        await first.close();
      }

      const second = await createTestDataSource([ParentV2], { database });
      try {
        assert.equal(second.database, `${base}_test`, 'the kept database is reused');
        assert.equal(await rowCount(second, ParentV2), 0, 'the run starts from empty tables');
        await ParentV2.create({ title: 'same', slug: 'same' });
        await assert.rejects(
          ParentV2.create({ title: 'same', slug: 'again' }),
          'the unique index was added',
        );
      } finally {
        await second.close();
      }

      const engine = await createEngine(
        resolveDatabaseConfig(
          {},
          { env: { DATABASE_URL: matrixServerUrl(matrixServer(), `${base}_test`) } },
        ),
        { purpose: 'migration' },
      );
      try {
        const conn = await engine.lease();
        try {
          const names = (await introspect(conn, dialect)).tables.map((table) => table.name);
          assert.ok(names.includes('td_parents'));
          assert.ok(!names.includes('td_children'), 'the removed model was dropped');
          await assertTestDatabase(conn);
        } finally {
          await conn.release();
        }
      } finally {
        await engine.close();
      }
    });

    it('prepares, reuses and drops through the migration connection alone', async (t) => {
      const admin = adminConfig();
      const base = freshBase(t, admin, dialect);
      const server = matrixServer();
      // App credentials that cannot connect at all: any step of preparing
      // the database that used them would fail.
      const config = resolveDatabaseConfig(
        {},
        {
          env: {
            DATABASE_URL: matrixServerUrl(
              { ...server, username: 'jsails_m_no_such_user' },
              server.database,
            ),
            DATABASE_MIGRATION_URL: matrixServerUrl(server, server.database),
          },
        },
      );
      assert.notEqual(config.migration, undefined, 'the config has a migration connection');

      const created = await createTestDataSource([ParentV1], {
        database: { config, name: base, workerId: null },
      });
      assert.equal(created.database, `${base}_test`);
      await created.close();
      assert.equal(await databaseExists(admin, dialect, `${base}_test`), true, 'kept');

      const reused = await createTestDataSource([ParentV2], {
        database: { config, name: base, workerId: null, drop: true },
      });
      await reused.close();
      assert.equal(
        await databaseExists(admin, dialect, `${base}_test`),
        false,
        'dropped on close with drop: true',
      );
    });
  },
  { drivers: ['mariadb', 'postgres'] },
);
