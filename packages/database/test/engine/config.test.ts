/**
 * The `database()` options schema: URLs and fields resolve to a frozen
 * config, the environment wins over code, secrets come from the environment
 * only, and every refusal names the option without echoing its value.
 */

import assert from 'node:assert/strict';
import { isAbsolute, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';

import {
  MEMORY_DATABASE,
  resolveDatabaseConfig,
  type DatabaseOptions,
} from '../../src/engine/index.js';

function refuses(
  options: unknown,
  env: Record<string, string>,
  field: string,
  secret?: string,
): void {
  assert.throws(
    () => resolveDatabaseConfig(options as DatabaseOptions, { env }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const typed = error as Error & { code?: string; context?: Record<string, unknown> };
      assert.equal(typed.code, 'invalid_config');
      assert.equal(typed.context?.field, field);
      if (secret !== undefined) {
        assert.ok(!typed.message.includes(secret));
        assert.ok(!JSON.stringify(typed.context).includes(secret));
      }
      return true;
    },
  );
}

describe('resolveDatabaseConfig', () => {
  it('reads a PostgreSQL URL from DATABASE_URL, with its password', () => {
    const config = resolveDatabaseConfig(
      {},
      {
        env: { DATABASE_URL: 'postgres://app:s%40cret@db.internal:6543/shop?sslmode=verify-full' },
      },
    );
    assert.equal(config.dialect, 'postgres');
    assert.deepEqual(
      { ...config.connection },
      { host: 'db.internal', port: 6543, user: 'app', database: 'shop', ssl: { mode: 'verify' } },
    );
    assert.equal(config.connection?.password, 's@cret');
    assert.ok(Object.isFrozen(config));
    assert.deepEqual(config.pool, { max: 10 });
    assert.equal(config.acquireTimeoutMs, 10_000);
    assert.equal(config.statementTimeoutMs, 30_000);
  });

  it('never prints the password', () => {
    const config = resolveDatabaseConfig(
      {},
      { env: { DATABASE_URL: 'mariadb://app:hunter2@db/shop' } },
    );
    assert.equal(config.connection?.password, 'hunter2');
    assert.ok(!JSON.stringify(config).includes('hunter2'));
    assert.ok(!inspect(config, { depth: 5 }).includes('hunter2'));
  });

  it('reads mariadb:// and mysql:// as MariaDB, with default ports', () => {
    for (const scheme of ['mariadb', 'mysql']) {
      const config = resolveDatabaseConfig({}, { env: { DATABASE_URL: `${scheme}://u@h/d` } });
      assert.equal(config.dialect, 'mariadb');
      assert.equal(config.connection?.port, 3306);
      assert.equal(config.connection?.password, undefined);
    }
    assert.equal(
      resolveDatabaseConfig({}, { env: { DATABASE_URL: 'postgresql://u@h/d' } }).connection?.port,
      5432,
    );
  });

  it('lets the environment URL win over the options', () => {
    const config = resolveDatabaseConfig(
      { file: 'dev.sqlite' },
      { env: { DATABASE_URL: 'postgres://u:p@h/d' } },
    );
    assert.equal(config.dialect, 'postgres');
  });

  it('resolves a SQLite file against the root, and keeps :memory:', () => {
    const root = resolve('/srv/app');
    const relative = resolveDatabaseConfig({ file: join('data', 'app.sqlite') }, { env: {}, root });
    assert.equal(relative.file, join(root, 'data', 'app.sqlite'));
    assert.ok(isAbsolute(relative.file ?? ''));
    assert.equal(
      resolveDatabaseConfig({ file: MEMORY_DATABASE }, { env: {} }).file,
      MEMORY_DATABASE,
    );
    const fromUrl = resolveDatabaseConfig({}, { env: { DATABASE_URL: 'sqlite:db.sqlite' }, root });
    assert.equal(fromUrl.file, join(root, 'db.sqlite'));
    assert.equal(
      resolveDatabaseConfig({}, { env: { DATABASE_URL: 'sqlite::memory:' } }).file,
      MEMORY_DATABASE,
    );
    assert.equal(resolveDatabaseConfig({ file: 'x.db' }, { env: {} }).connection, undefined);
  });

  it('builds a server from fields, taking the password from DATABASE_PASSWORD', () => {
    const config = resolveDatabaseConfig(
      {
        dialect: 'mariadb',
        host: 'db',
        user: 'app',
        database: 'shop',
        ssl: 'require',
        pool: { max: 3 },
      },
      { env: { DATABASE_PASSWORD: 'pw' } },
    );
    assert.equal(config.connection?.port, 3306);
    assert.equal(config.connection?.password, 'pw');
    assert.deepEqual(config.connection?.ssl, { mode: 'require' });
    assert.equal(config.pool.max, 3);
  });

  it('accepts a URL without a password in code, completed by the password variable', () => {
    const config = resolveDatabaseConfig(
      { url: 'postgres://app@db/shop', passwordEnv: 'SHOP_DB_PASSWORD' },
      { env: { SHOP_DB_PASSWORD: 'pw' } },
    );
    assert.equal(config.connection?.password, 'pw');
  });

  it('refuses a password written into the options URL', () => {
    refuses({ url: 'postgres://app:hunter2@db/shop' }, {}, 'url', 'hunter2');
  });

  it('reads a named URL variable and a migration URL', () => {
    const config = resolveDatabaseConfig(
      { urlEnv: 'SHOP_URL' },
      {
        env: {
          SHOP_URL: 'postgres://app:pw@pooler/shop',
          DATABASE_MIGRATION_URL: 'postgres://owner:opw@direct:5433/shop',
        },
      },
    );
    assert.equal(config.connection?.host, 'pooler');
    assert.equal(config.migration?.host, 'direct');
    assert.equal(config.migration?.user, 'owner');
    assert.equal(config.migration?.password, 'opw');
  });

  it('refuses a migration URL of another dialect, or for SQLite', () => {
    refuses(
      {},
      { DATABASE_URL: 'postgres://u@h/d', DATABASE_MIGRATION_URL: 'mariadb://u@h/d' },
      'DATABASE_MIGRATION_URL',
    );
    refuses(
      { file: 'x.db' },
      { DATABASE_MIGRATION_URL: 'postgres://u@h/d' },
      'DATABASE_MIGRATION_URL',
    );
  });

  it('refuses nothing configured, naming the variable to set', () => {
    refuses({}, {}, 'DATABASE_URL');
  });

  it('refuses malformed URLs without echoing them', () => {
    refuses({}, { DATABASE_URL: 'not a url with hunter2' }, 'DATABASE_URL', 'hunter2');
    refuses({}, { DATABASE_URL: 'mssql://u:hunter2@h/d' }, 'DATABASE_URL', 'hunter2');
    refuses({}, { DATABASE_URL: 'postgres://u:hunter2@h/' }, 'DATABASE_URL', 'hunter2');
    refuses(
      {},
      { DATABASE_URL: 'postgres://u:hunter2@h/d?schema=x' },
      'DATABASE_URL.query',
      'hunter2',
    );
    refuses(
      {},
      { DATABASE_URL: 'postgres://u:hunter2@h/d?sslmode=prefer' },
      'DATABASE_URL.sslmode',
      'hunter2',
    );
    refuses({}, { DATABASE_URL: 'sqlite:' }, 'DATABASE_URL');
  });

  it('refuses unknown options and mistyped values, by name', () => {
    refuses({ file: 'x', cache: true }, {}, 'cache');
    refuses({ file: 'x', pool: { max: 0 } }, {}, 'pool.max');
    refuses({ file: 'x', pool: { min: 1 } }, {}, 'pool.min');
    refuses({ file: 'x', pool: 4 }, {}, 'pool');
    refuses({ file: 'x', statementTimeoutMs: -1 }, {}, 'statementTimeoutMs');
    refuses({ file: 'x', acquireTimeoutMs: 1.5 }, {}, 'acquireTimeoutMs');
    refuses({ file: 'x', connectTimeoutMs: 0 }, {}, 'connectTimeoutMs');
    refuses({ file: 'x', ssl: 'prefer' }, {}, 'ssl');
    refuses({ file: 'x', urlEnv: 'not-a-name' }, {}, 'urlEnv');
    refuses({ dialect: 'mysql', host: 'h' }, {}, 'dialect');
    refuses({ dialect: 'postgres', user: 'u', database: 'd' }, {}, 'host');
    refuses({ dialect: 'postgres', host: 'h', database: 'd' }, {}, 'user');
    refuses({ dialect: 'postgres', host: 'h', user: 'u' }, {}, 'database');
    refuses({ dialect: 'postgres', host: 'h', user: 'u', database: 'd', port: 70000 }, {}, 'port');
  });

  it('refuses two ways of naming the database in code', () => {
    refuses({ url: 'postgres://u@h/d', host: 'other' }, {}, 'host');
    refuses({ url: 'postgres://u@h/d', file: 'x.sqlite' }, {}, 'file');
    refuses({ url: 'postgres://u@h/d', dialect: 'postgres' }, {}, 'dialect');
    refuses({ file: 'x.sqlite', host: 'h' }, {}, 'host');
    refuses({ file: 'x.sqlite', dialect: 'postgres' }, {}, 'dialect');
    refuses({ host: 'h', user: 'u', database: 'd' }, {}, 'dialect');
  });

  it('reads sqlite: URLs as paths, never as a host', () => {
    // `sqlite:///srv/app.sqlite` on POSIX, `sqlite:///C:\srv\app.sqlite` on Windows.
    const absolute = resolve('/', 'srv', 'app.sqlite');
    const url = `sqlite://${absolute.startsWith('/') ? '' : '/'}${absolute}`;
    assert.equal(resolveDatabaseConfig({}, { env: { DATABASE_URL: url } }).file, absolute);
    refuses({}, { DATABASE_URL: 'sqlite://app.sqlite' }, 'DATABASE_URL');
    refuses({}, { DATABASE_URL: 'sqlite:///' }, 'DATABASE_URL');
  });
});
