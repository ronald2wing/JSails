/**
 * The cross-process schema lock: per-driver acquire/release, the timeout, and
 * release on failure, against a recording query runner.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueryRunner } from 'typeorm';

import type { SchemaEditorDriver } from '../../src/migrations/schema-editor.js';
import { withSchemaLock, type SchemaLockDataSource } from '../../src/migrations/schema-lock.js';
import { MigrationError } from '../../src/migrations/schema-types.js';

/** A lock shared by every fake connection, standing in for the database server. */
class FakeServer {
  holder: number | undefined;
  log: string[] = [];
  #nextSession = 0;

  dataSource(driver: SchemaEditorDriver, database = 'app'): SchemaLockDataSource {
    return {
      isInitialized: true,
      jsailsDriver: driver,
      createQueryRunner: () => this.#runner(this.#nextSession++, database),
    };
  }

  #runner(session: number, database: string): QueryRunner {
    const runner = {
      connect: async () => {
        this.log.push(`connect ${session}`);
      },
      release: async () => {
        this.log.push(`release ${session}`);
      },
      query: async (sql: string, params?: unknown[]) => {
        this.log.push(`${session}: ${sql}${params ? ` ${JSON.stringify(params)}` : ''}`);
        if (sql.startsWith('SELECT DATABASE()')) return [{ name: database }];
        if (/pg_try_advisory_lock|GET_LOCK/.test(sql)) {
          if (this.holder === undefined || this.holder === session) {
            this.holder = session;
            return [{ locked: sql.includes('GET_LOCK') ? 1 : true }];
          }
          return [{ locked: sql.includes('GET_LOCK') ? 0 : false }];
        }
        if (/pg_advisory_unlock|RELEASE_LOCK/.test(sql) && this.holder === session) {
          this.holder = undefined;
        }
        return [{ released: 1 }];
      },
    };
    return runner as unknown as QueryRunner;
  }
}

describe('withSchemaLock', () => {
  for (const driver of ['postgres', 'mysql', 'mariadb'] as const) {
    it(`${driver}: holds the lock for the callback and releases it after`, async () => {
      const server = new FakeServer();
      const result = await withSchemaLock(server.dataSource(driver), async () => {
        assert.equal(server.holder, 0);
        return 'done';
      });
      assert.equal(result, 'done');
      assert.equal(server.holder, undefined);
      assert.equal(server.log.at(-1), 'release 0');
    });

    it(`${driver}: releases the lock and the connection when the callback throws`, async () => {
      const server = new FakeServer();
      await assert.rejects(
        withSchemaLock(server.dataSource(driver), async () => {
          throw new Error('plan failed');
        }),
        /plan failed/,
      );
      assert.equal(server.holder, undefined);
      assert.equal(server.log.at(-1), 'release 0');
    });

    it(`${driver}: a second push waits for the first, then runs`, async () => {
      const server = new FakeServer();
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = withSchemaLock(server.dataSource(driver), async () => {
        order.push('first start');
        await firstMayFinish;
        order.push('first end');
      });
      // Let the first acquire before the second asks.
      await new Promise((resolve) => setImmediate(resolve));
      const second = withSchemaLock(
        server.dataSource(driver),
        async () => {
          order.push('second');
        },
        { timeoutSeconds: 5, pollIntervalMs: 5 },
      );
      if (driver !== 'postgres') {
        // GET_LOCK waits server-side; the fake answers at once, so it times out.
        await assert.rejects(
          second,
          (err: unknown) => err instanceof MigrationError && err.code === 'lock_timeout',
        );
        releaseFirst();
        await first;
        assert.deepEqual(order, ['first start', 'first end']);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, ['first start']);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(order, ['first start', 'first end', 'second']);
    });
  }

  it('postgres: gives up with lock_timeout and never runs the callback', async () => {
    const server = new FakeServer();
    server.holder = 999;
    let ran = false;
    await assert.rejects(
      withSchemaLock(
        server.dataSource('postgres'),
        async () => {
          ran = true;
        },
        { timeoutSeconds: 0.02, pollIntervalMs: 5 },
      ),
      (err: unknown) => err instanceof MigrationError && err.code === 'lock_timeout',
    );
    assert.equal(ran, false);
    assert.equal(server.holder, 999);
    assert.equal(server.log.at(-1), 'release 0');
  });

  it('mysql: the lock name is scoped to the database, not the whole server', async () => {
    const server = new FakeServer();
    await withSchemaLock(server.dataSource('mysql', 'one'), async () => {});
    await withSchemaLock(server.dataSource('mysql', 'two'), async () => {});
    const names = server.log
      .filter((line) => line.includes('GET_LOCK'))
      .map((line) => JSON.parse(line.slice(line.indexOf('['))) as [string, number]);
    assert.equal(names.length, 2);
    assert.notEqual(names[0]![0], names[1]![0]);
    assert.ok(names.every(([name]) => name.length <= 64 && !name.includes('one')));
  });

  it('sqlite runs the callback directly, with no connection of its own', async () => {
    const server = new FakeServer();
    assert.equal(await withSchemaLock(server.dataSource('sqlite'), async () => 7), 7);
    assert.deepEqual(server.log, []);
  });

  it('refuses an uninitialized data source', async () => {
    const server = new FakeServer();
    const dataSource = { ...server.dataSource('postgres'), isInitialized: false };
    await assert.rejects(
      withSchemaLock(dataSource, async () => {}),
      (err: unknown) => err instanceof MigrationError && err.code === 'not_initialized',
    );
  });
});
