/**
 * Dialect selection for the auth database, without a live server: mysql2 and
 * pg pools connect lazily, and SQLite runs in memory.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { JsailsDataSource } from 'jsails';
import { createPool } from 'mysql2';

import {
  loadPostgresDriver,
  mysqlPoolOptions,
  openAuthDatabase,
  resolveAuthDatabase,
  type AuthDatabaseSource,
} from '../src/auth-database.js';
import { AuthInstanceError } from '../src/instance-error.js';

const SIZING = { connectionLimit: 3, queueLimit: 7 } as const;

const MARIADB_ENV = {
  DATABASE_HOST: 'db.internal',
  DATABASE_USER: 'auth',
  DATABASE_PASSWORD: 'p4ss-secret',
  DATABASE_NAME: 'app',
} as const;

/** Assert a value-free AuthInstanceError with `code` that never echoes `secrets`. */
function rejectsWith(code: string, secrets: readonly string[] = []) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AuthInstanceError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    const serialized = JSON.stringify(error);
    for (const secret of secrets) {
      assert.ok(!error.message.includes(secret), 'the message must not echo input');
      assert.ok(!serialized.includes(secret), 'the serialized error must not echo input');
    }
    return true;
  };
}

describe('resolveAuthDatabase from the environment', () => {
  it('keeps the MariaDB default when DATABASE_TYPE is unset or empty', () => {
    const expected = {
      dialect: 'mysql',
      connection: {
        host: 'db.internal',
        user: 'auth',
        password: 'p4ss-secret',
        database: 'app',
        port: 3306,
      },
    };
    assert.deepEqual(resolveAuthDatabase(undefined, MARIADB_ENV), expected);
    assert.deepEqual(
      resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_TYPE: '' }),
      expected,
    );
    assert.deepEqual(
      resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_TYPE: 'mariadb' }),
      expected,
    );
    assert.deepEqual(
      resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_TYPE: 'mysql' }),
      expected,
    );
  });

  it('selects postgres with its default port', () => {
    const resolved = resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_TYPE: 'postgres' });
    assert.ok(resolved.dialect === 'postgres');
    assert.equal(resolved.connection.port, 5432);
    const custom = resolveAuthDatabase(undefined, {
      ...MARIADB_ENV,
      DATABASE_TYPE: 'postgres',
      DATABASE_PORT: '6543',
    });
    assert.ok(custom.dialect === 'postgres');
    assert.equal(custom.connection.port, 6543);
  });

  it('names a missing variable without its value', () => {
    assert.throws(
      () => resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_NAME: '' }),
      (error: unknown) =>
        rejectsWith('missing_env')(error) &&
        error instanceof Error &&
        error.message.includes('DATABASE_NAME'),
    );
  });

  it('refuses a bad port and an unknown type without echoing them', () => {
    assert.throws(
      () => resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_PORT: '99999x' }),
      rejectsWith('invalid_env', ['99999x']),
    );
    assert.throws(
      () => resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_TYPE: 'oracle-secret' }),
      rejectsWith('unsupported_database', ['oracle-secret']),
    );
  });
});

describe('resolveAuthDatabase from an explicit config', () => {
  it('maps TypeORM-named fields onto a server connection', () => {
    const resolved = resolveAuthDatabase({
      type: 'postgres',
      host: 'pg.internal',
      username: 'auth',
      password: 'p4ss-secret',
      database: 'auth',
      ssl: true,
    });
    assert.deepEqual(resolved, {
      dialect: 'postgres',
      connection: {
        host: 'pg.internal',
        user: 'auth',
        password: 'p4ss-secret',
        database: 'auth',
        port: 5432,
        ssl: true,
      },
    });
  });

  it('accepts a URL in place of the individual fields', () => {
    const resolved = resolveAuthDatabase({ type: 'mariadb', url: 'mysql://u:p@h/db' });
    assert.deepEqual(resolved, {
      dialect: 'mysql',
      connection: { url: 'mysql://u:p@h/db' },
    });
  });

  it('keeps the port in a URL instead of filling the dialect default', async () => {
    const resolved = resolveAuthDatabase({ type: 'mariadb', url: 'mysql://u:p@h:3307/db' });
    assert.deepEqual(resolved, {
      dialect: 'mysql',
      connection: { url: 'mysql://u:p@h:3307/db' },
    });
    assert.ok(resolved.dialect === 'mysql');
    // mysql2 lets the URL fill an option only while that option is unset.
    const options = mysqlPoolOptions(resolved.connection, SIZING);
    assert.equal('port' in options, false);
    const pool = createPool(options);
    // mysql2 types `config` as the options it was given; at runtime it is the
    // parsed pool config, whose `connectionConfig` holds the effective port.
    const parsed = pool.config as unknown as { connectionConfig: { port: number } };
    assert.equal(parsed.connectionConfig.port, 3307);
    await new Promise<void>((resolve) => {
      pool.end(() => resolve());
    });
  });

  it('refuses a URL combined with an individual connection field', () => {
    for (const field of ['host', 'port', 'username', 'password', 'database'] as const) {
      const value = field === 'port' ? 3307 : 'p4ss-secret';
      assert.throws(
        () =>
          resolveAuthDatabase({
            type: 'postgres',
            url: 'postgres://h/db',
            [field]: value,
          } as unknown as AuthDatabaseSource),
        (error: unknown) =>
          rejectsWith('invalid_database', ['p4ss-secret', 'postgres://h/db'])(error) &&
          error instanceof Error &&
          error.message.includes(field),
      );
    }
  });

  it('refuses a malformed URL without echoing it', () => {
    const source = { type: 'mysql', url: 'mysql://u:p4ss-secret@[bad/db' } as const;
    assert.throws(
      () => resolveAuthDatabase(source),
      rejectsWith('invalid_database', ['p4ss-secret']),
    );
    assert.throws(
      () =>
        openAuthDatabase(
          { dialect: 'mysql', connection: { url: 'mysql://u:p4ss-secret@[bad/db' } },
          SIZING,
        ),
      rejectsWith('invalid_database', ['p4ss-secret']),
    );
  });

  it('accepts a mysql2 TLS profile name on mariadb/mysql only', () => {
    const resolved = resolveAuthDatabase({
      type: 'mysql',
      host: 'h',
      username: 'u',
      database: 'd',
      ssl: 'Amazon RDS',
    });
    assert.ok(resolved.dialect === 'mysql');
    assert.equal(resolved.connection.ssl, 'Amazon RDS');
    assert.throws(
      () =>
        resolveAuthDatabase({
          type: 'postgres',
          host: 'h',
          username: 'u',
          database: 'd',
          ssl: 'Amazon RDS',
        }),
      rejectsWith('invalid_database', ['Amazon RDS']),
    );
  });

  it('ignores the environment when a config is given', () => {
    const resolved = resolveAuthDatabase(
      { type: 'sqlite', location: ':memory:' },
      { DATABASE_TYPE: 'postgres' },
    );
    assert.deepEqual(resolved, { dialect: 'sqlite', location: ':memory:' });
  });

  it('names the missing or mistyped field, never its value', () => {
    assert.throws(
      () => resolveAuthDatabase({ type: 'mysql', host: 'h', username: 'u' }),
      (error: unknown) =>
        rejectsWith('invalid_database')(error) &&
        error instanceof Error &&
        error.message.includes('database'),
    );
    assert.throws(
      () =>
        resolveAuthDatabase({
          type: 'mysql',
          host: 'h',
          username: 'u',
          database: 'd',
          port: 70000,
          password: 'p4ss-secret',
        }),
      rejectsWith('invalid_database', ['70000', 'p4ss-secret']),
    );
    assert.throws(
      () => resolveAuthDatabase({ type: 'sqlite', location: '' }),
      rejectsWith('invalid_database'),
    );
    assert.throws(
      () => resolveAuthDatabase({ type: 'mssql' } as unknown as AuthDatabaseSource),
      rejectsWith('unsupported_database', ['mssql']),
    );
    assert.throws(
      () => resolveAuthDatabase({} as unknown as AuthDatabaseSource),
      rejectsWith('invalid_database'),
    );
  });
});

describe('resolveAuthDatabase from a JsailsDataSource', () => {
  it('reuses a server data source connection settings', () => {
    const dataSource = new JsailsDataSource({
      type: 'mariadb',
      host: 'db.internal',
      port: 3307,
      username: 'app',
      password: 'p4ss-secret',
      database: 'app',
    });
    assert.deepEqual(resolveAuthDatabase(dataSource), {
      dialect: 'mysql',
      connection: {
        host: 'db.internal',
        user: 'app',
        password: 'p4ss-secret',
        database: 'app',
        port: 3307,
      },
    });
  });

  it('refuses to share a sqljs data source file', () => {
    assert.throws(
      () => resolveAuthDatabase({ options: { type: 'sqljs', location: '/srv/app.sqlite' } }),
      rejectsWith('unsupported_database', ['/srv/app.sqlite']),
    );
  });
});

describe('openAuthDatabase', () => {
  it('builds a typed Kysely database over a lazy mysql2 pool', async () => {
    const opened = openAuthDatabase(resolveAuthDatabase(undefined, MARIADB_ENV), SIZING);
    assert.ok('type' in opened.database && 'db' in opened.database);
    assert.equal(opened.database.type, 'mysql');
    await opened.destroy();
  });

  it('builds a typed Kysely database over a lazy pg pool', async () => {
    const opened = openAuthDatabase(
      resolveAuthDatabase(undefined, { ...MARIADB_ENV, DATABASE_TYPE: 'postgres' }),
      SIZING,
    );
    assert.ok('type' in opened.database);
    assert.equal(opened.database.type, 'postgres');
    await opened.destroy();
  });

  it('sizes the pg pool from connectionLimit and passes the settings through', () => {
    let received: Readonly<Record<string, unknown>> | undefined;
    class FakePool {
      readonly options: object;
      constructor(config: Readonly<Record<string, unknown>>) {
        received = config;
        this.options = config;
      }
      connect(): Promise<never> {
        return Promise.reject(new Error('not connected'));
      }
      end(): Promise<void> {
        return Promise.resolve();
      }
    }
    openAuthDatabase(
      resolveAuthDatabase({ type: 'postgres', url: 'postgres://h/db', ssl: { ca: 'x' } }),
      SIZING,
      () => ({ Pool: FakePool }),
    );
    assert.deepEqual(received, {
      max: 3,
      connectionString: 'postgres://h/db',
      ssl: { ca: 'x' },
    });
  });

  it('names pg when the driver is missing', () => {
    const missing = (): never => {
      throw Object.assign(new Error("Cannot find module 'pg' from /secret/path"), {
        code: 'MODULE_NOT_FOUND',
      });
    };
    assert.throws(
      () => loadPostgresDriver(missing),
      (error: unknown) =>
        rejectsWith('missing_driver', ['/secret/path'])(error) &&
        error instanceof Error &&
        /\bpg\b/.test(error.message),
    );
    assert.throws(() => loadPostgresDriver(() => ({})), rejectsWith('missing_driver'));
    assert.throws(
      () =>
        openAuthDatabase(
          resolveAuthDatabase({ type: 'postgres', url: 'postgres://h/db' }),
          SIZING,
          missing,
        ),
      rejectsWith('missing_driver'),
    );
  });

  it('opens a node:sqlite database and closes it idempotently', async () => {
    const opened = openAuthDatabase({ dialect: 'sqlite', location: ':memory:' }, SIZING);
    assert.ok(opened.database instanceof DatabaseSync);
    await opened.destroy();
    await opened.destroy();
  });

  it('reports an unopenable SQLite file without its path', () => {
    assert.throws(
      () =>
        openAuthDatabase(
          { dialect: 'sqlite', location: '/nonexistent-secret-dir/auth.sqlite' },
          SIZING,
        ),
      rejectsWith('invalid_database', ['nonexistent-secret-dir']),
    );
  });
});
