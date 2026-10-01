/**
 * Critic prediction "on MariaDB, two apps configured by `url` on one server
 * share the lock name `jsails_schema_<sha256('')>` and block each other's
 * pushes" (core/src/migrations/schema-lock.ts digests `options.database`, which
 * a `url` configuration leaves empty). `GET_LOCK` names are server-wide, so the
 * name must come from the database the connection uses. The live counterpart
 * is schema-lock.database.test.ts. DAT-06 names the lock from the connected
 * database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueryRunner } from 'typeorm';

import { withSchemaLock, type SchemaLockDataSource } from '../../../src/migrations/schema-lock.js';

/** A MariaDB data source configured by `url` that records the lock names it asks for. */
function urlConfigured(url: string, names: string[]): SchemaLockDataSource {
  const runner = {
    connect: async () => undefined,
    release: async () => undefined,
    query: async (sql: string, parameters?: unknown[]) => {
      if (sql.startsWith('SELECT GET_LOCK')) names.push(String(parameters?.[0]));
      return [{ locked: 1 }];
    },
  };
  return {
    isInitialized: true,
    jsailsDriver: 'mariadb',
    options: { url } as { database?: unknown },
    createQueryRunner: () => runner as unknown as QueryRunner,
  };
}

describe('MariaDB schema lock name', () => {
  it('differs for url-configured connections to different databases', async () => {
    const shop: string[] = [];
    const blog: string[] = [];

    await withSchemaLock(urlConfigured('mysql://app:secret@db:3306/shop', shop), async () => {});
    await withSchemaLock(urlConfigured('mysql://app:secret@db:3306/blog', blog), async () => {});

    assert.equal(shop.length, 1);
    assert.equal(blog.length, 1);
    assert.notEqual(shop[0], blog[0], 'two databases on one server share one lock name');
  });
});
