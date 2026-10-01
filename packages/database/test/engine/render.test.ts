/**
 * Statement rendering, offline: the exact SQL and parameters of every shape
 * on each dialect, the refusals, and identifier quoting and placeholders
 * pinned to TypeORM's own driver functions.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { DataSource } from 'typeorm';

import {
  BIND_LIMITS,
  compileStatement,
  quoteIdentifier,
  type Dialect,
  type SqlValue,
  type Statement,
} from '../../src/engine/index.js';
import { NodeSqliteDatabase } from '../../src/engine/sqlite/node-sqlite-adapter.js';

const DIALECTS: readonly Dialect[] = ['postgres', 'mariadb', 'sqlite'];

interface Case {
  readonly name: string;
  readonly statement: Statement;
  readonly sql: Readonly<Record<Dialect, string>>;
  /** The parameters on every dialect, or per dialect where PostgreSQL binds an `IN` list as one array. */
  readonly params: readonly unknown[] | Readonly<Record<Dialect, readonly unknown[]>>;
}

const CASES: readonly Case[] = [
  {
    name: 'a select with every clause',
    statement: {
      kind: 'select',
      from: { table: 'posts', alias: 'p' },
      columns: [{ column: { table: 'p', column: 'id' } }, { column: 'title', as: 'heading' }],
      distinct: true,
      where: {
        op: 'and',
        items: [
          { op: 'compare', column: 'status', comparison: '=', value: 'live' },
          { op: 'in', column: 'author_id', values: [1, 2] },
          { op: 'null', column: 'deleted_at' },
        ],
      },
      orderBy: [{ column: 'created_at', direction: 'desc' }],
      limit: 10,
      offset: 20,
    },
    sql: {
      postgres:
        'SELECT DISTINCT "p"."id", "title" AS "heading" FROM "posts" AS "p" WHERE ("status" = $1) AND ("author_id" = ANY($2)) AND ("deleted_at" IS NULL) ORDER BY "created_at" DESC LIMIT $3 OFFSET $4',
      mariadb:
        'SELECT DISTINCT `p`.`id`, `title` AS `heading` FROM `posts` AS `p` WHERE (`status` = ?) AND (`author_id` IN (?, ?)) AND (`deleted_at` IS NULL) ORDER BY `created_at` DESC LIMIT ? OFFSET ?',
      sqlite:
        'SELECT DISTINCT "p"."id", "title" AS "heading" FROM "posts" AS "p" WHERE ("status" = ?) AND ("author_id" IN (?, ?)) AND ("deleted_at" IS NULL) ORDER BY "created_at" DESC LIMIT ? OFFSET ?',
    },
    params: {
      postgres: ['live', '{"1","2"}', 10, 20],
      mariadb: ['live', 1, 2, 10, 20],
      sqlite: ['live', 1, 2, 10, 20],
    },
  },
  {
    name: 'an offset without a limit',
    statement: { kind: 'select', from: { table: 't' }, columns: '*', offset: 5 },
    sql: {
      postgres: 'SELECT * FROM "t" OFFSET $1',
      mariadb: 'SELECT * FROM `t` LIMIT 18446744073709551615 OFFSET ?',
      sqlite: 'SELECT * FROM "t" LIMIT -1 OFFSET ?',
    },
    params: [5],
  },
  {
    name: 'nulls ordering',
    statement: {
      kind: 'select',
      from: { table: 't' },
      columns: '*',
      orderBy: [
        { column: 'a', nulls: 'last' },
        { column: 'b', direction: 'desc', nulls: 'first' },
      ],
    },
    sql: {
      postgres: 'SELECT * FROM "t" ORDER BY "a" ASC NULLS LAST, "b" DESC NULLS FIRST',
      mariadb: 'SELECT * FROM `t` ORDER BY `a` IS NULL ASC, `a` ASC, `b` IS NULL DESC, `b` DESC',
      sqlite: 'SELECT * FROM "t" ORDER BY "a" ASC NULLS LAST, "b" DESC NULLS FIRST',
    },
    params: [],
  },
  {
    name: 'a locking select',
    statement: {
      kind: 'select',
      from: { table: 'jobs' },
      columns: [{ column: 'id' }],
      lock: { mode: 'share', wait: 'skip-locked' },
      limit: 1,
    },
    sql: {
      postgres: 'SELECT "id" FROM "jobs" LIMIT $1 FOR SHARE SKIP LOCKED',
      mariadb: 'SELECT `id` FROM `jobs` LIMIT ? LOCK IN SHARE MODE SKIP LOCKED',
      sqlite: 'SELECT "id" FROM "jobs" LIMIT ?',
    },
    params: [1],
  },
  {
    name: 'aggregates and grouping',
    statement: {
      kind: 'select',
      from: { table: 't' },
      columns: [
        { column: 'k' },
        { aggregate: 'count', as: 'n' },
        { aggregate: 'count', column: 'v', distinct: true, as: 'd' },
        { aggregate: 'sum', column: 'v', as: 's' },
      ],
      groupBy: ['k'],
    },
    sql: {
      postgres:
        'SELECT "k", COUNT(*) AS "n", COUNT(DISTINCT "v") AS "d", SUM("v") AS "s" FROM "t" GROUP BY "k"',
      mariadb:
        'SELECT `k`, COUNT(*) AS `n`, COUNT(DISTINCT `v`) AS `d`, SUM(`v`) AS `s` FROM `t` GROUP BY `k`',
      sqlite:
        'SELECT "k", COUNT(*) AS "n", COUNT(DISTINCT "v") AS "d", SUM("v") AS "s" FROM "t" GROUP BY "k"',
    },
    params: [],
  },
  {
    name: 'a keyset page, EXISTS, NOT IN (SELECT) and LIKE',
    statement: {
      kind: 'select',
      from: { table: 'a' },
      columns: '*',
      where: {
        op: 'and',
        items: [
          { op: 'row-compare', columns: ['x', 'id'], comparison: '>', values: [5, 9] },
          {
            op: 'exists',
            select: {
              kind: 'select',
              from: { table: 'b' },
              columns: [{ column: 'id' }],
              where: {
                op: 'compare-columns',
                left: { table: 'b', column: 'a_id' },
                comparison: '=',
                right: { table: 'a', column: 'id' },
              },
            },
          },
          {
            op: 'in-select',
            columns: ['id'],
            negate: true,
            select: { kind: 'select', from: { table: 'c' }, columns: [{ column: 'a_id' }] },
          },
          { op: 'like', column: 'name', pattern: 'a\\_%' },
          { op: 'not', item: { op: 'false' } },
        ],
      },
    },
    sql: {
      postgres:
        'SELECT * FROM "a" WHERE (("x", "id") > ($1, $2)) AND (EXISTS (SELECT "id" FROM "b" WHERE "b"."a_id" = "a"."id")) AND ("id" NOT IN (SELECT "a_id" FROM "c")) AND ("name" LIKE $3 ESCAPE \'\\\') AND (NOT (1 = 0))',
      mariadb:
        "SELECT * FROM `a` WHERE ((`x`, `id`) > (?, ?)) AND (EXISTS (SELECT `id` FROM `b` WHERE `b`.`a_id` = `a`.`id`)) AND (`id` NOT IN (SELECT `a_id` FROM `c`)) AND (`name` LIKE ? ESCAPE _utf8mb4 X'5C') AND (NOT (1 = 0))",
      sqlite:
        'SELECT * FROM "a" WHERE (("x", "id") > (?, ?)) AND (EXISTS (SELECT "id" FROM "b" WHERE "b"."a_id" = "a"."id")) AND ("id" NOT IN (SELECT "a_id" FROM "c")) AND ("name" LIKE ? ESCAPE \'\\\') AND (NOT (1 = 0))',
    },
    params: [5, 9, 'a\\_%'],
  },
  {
    name: 'empty IN lists and empty AND/OR',
    statement: {
      kind: 'select',
      from: { table: 't' },
      columns: '*',
      where: {
        op: 'or',
        items: [
          { op: 'in', column: 'a', values: [] },
          { op: 'in', column: 'a', values: [], negate: true },
          { op: 'and', items: [] },
          { op: 'or', items: [] },
        ],
      },
    },
    sql: {
      postgres: 'SELECT * FROM "t" WHERE (1 = 0) OR (1 = 1) OR (1 = 1) OR (1 = 0)',
      mariadb: 'SELECT * FROM `t` WHERE (1 = 0) OR (1 = 1) OR (1 = 1) OR (1 = 0)',
      sqlite: 'SELECT * FROM "t" WHERE (1 = 0) OR (1 = 1) OR (1 = 1) OR (1 = 0)',
    },
    params: [],
  },
  {
    name: 'a window limit',
    statement: {
      kind: 'select',
      from: { table: 'comments' },
      columns: [{ column: 'id' }, { column: 'post_id' }],
      where: { op: 'in', column: 'post_id', values: [1, 2] },
      orderBy: [{ column: 'created_at', direction: 'desc' }],
      windowLimit: { partitionBy: ['post_id'], limit: 3 },
    },
    sql: {
      postgres:
        'SELECT "jsails_w"."id", "jsails_w"."post_id" FROM (SELECT "id" AS "id", "post_id" AS "post_id", "post_id" AS "jsails_p0", ROW_NUMBER() OVER (PARTITION BY "post_id" ORDER BY "created_at" DESC) AS "jsails_rn" FROM "comments" WHERE "post_id" = ANY($1)) AS "jsails_w" WHERE "jsails_w"."jsails_rn" <= $2 ORDER BY "jsails_w"."jsails_p0", "jsails_w"."jsails_rn"',
      mariadb:
        'SELECT `jsails_w`.`id`, `jsails_w`.`post_id` FROM (SELECT `id` AS `id`, `post_id` AS `post_id`, `post_id` AS `jsails_p0`, ROW_NUMBER() OVER (PARTITION BY `post_id` ORDER BY `created_at` DESC) AS `jsails_rn` FROM `comments` WHERE `post_id` IN (?, ?)) AS `jsails_w` WHERE `jsails_w`.`jsails_rn` <= ? ORDER BY `jsails_w`.`jsails_p0`, `jsails_w`.`jsails_rn`',
      sqlite:
        'SELECT "jsails_w"."id", "jsails_w"."post_id" FROM (SELECT "id" AS "id", "post_id" AS "post_id", "post_id" AS "jsails_p0", ROW_NUMBER() OVER (PARTITION BY "post_id" ORDER BY "created_at" DESC) AS "jsails_rn" FROM "comments" WHERE "post_id" IN (?, ?)) AS "jsails_w" WHERE "jsails_w"."jsails_rn" <= ? ORDER BY "jsails_w"."jsails_p0", "jsails_w"."jsails_rn"',
    },
    params: { postgres: ['{"1","2"}', 3], mariadb: [1, 2, 3], sqlite: [1, 2, 3] },
  },
  {
    name: 'a multi-row insert returning its keys',
    statement: {
      kind: 'insert',
      table: 'items',
      columns: ['name', 'n'],
      rows: [
        ['a', 1],
        ['b', 2],
      ],
      returning: ['id'],
    },
    sql: {
      postgres: 'INSERT INTO "items" ("name", "n") VALUES ($1, $2), ($3, $4) RETURNING "id"',
      mariadb: 'INSERT INTO `items` (`name`, `n`) VALUES (?, ?), (?, ?) RETURNING `id`',
      sqlite: 'INSERT INTO "items" ("name", "n") VALUES (?, ?), (?, ?) RETURNING "id"',
    },
    params: ['a', 1, 'b', 2],
  },
  {
    name: 'an insert of defaults',
    statement: { kind: 'insert', table: 'items', columns: [], rows: [[]] },
    sql: {
      postgres: 'INSERT INTO "items" DEFAULT VALUES',
      mariadb: 'INSERT INTO `items` () VALUES ()',
      sqlite: 'INSERT INTO "items" DEFAULT VALUES',
    },
    params: [],
  },
  {
    name: 'an upsert that updates',
    statement: {
      kind: 'insert',
      table: 'items',
      columns: ['tenant', 'name', 'n'],
      rows: [[1, 'a', 2]],
      onConflict: { target: ['tenant', 'name'], action: 'update', update: ['n'] },
    },
    sql: {
      postgres:
        'INSERT INTO "items" ("tenant", "name", "n") VALUES ($1, $2, $3) ON CONFLICT ("tenant", "name") DO UPDATE SET "n" = EXCLUDED."n"',
      mariadb:
        'INSERT INTO `items` (`tenant`, `name`, `n`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `n` = VALUES(`n`)',
      sqlite:
        'INSERT INTO "items" ("tenant", "name", "n") VALUES (?, ?, ?) ON CONFLICT ("tenant", "name") DO UPDATE SET "n" = EXCLUDED."n"',
    },
    params: [1, 'a', 2],
  },
  {
    name: 'an upsert guarded by the tenant column',
    statement: {
      kind: 'insert',
      table: 'items',
      columns: ['tenant', 'name', 'n'],
      rows: [[1, 'a', 2]],
      onConflict: {
        target: ['tenant', 'name'],
        action: 'update',
        update: ['name', 'n'],
        guard: ['tenant'],
      },
    },
    sql: {
      postgres:
        'INSERT INTO "items" ("tenant", "name", "n") VALUES ($1, $2, $3) ON CONFLICT ("tenant", "name") DO UPDATE SET "name" = EXCLUDED."name", "n" = EXCLUDED."n" WHERE "items"."tenant" IS NOT DISTINCT FROM EXCLUDED."tenant"',
      mariadb:
        'INSERT INTO `items` (`tenant`, `name`, `n`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `name` = IF(`tenant` <=> VALUES(`tenant`), VALUES(`name`), `name`), `n` = IF(`tenant` <=> VALUES(`tenant`), VALUES(`n`), `n`)',
      sqlite:
        'INSERT INTO "items" ("tenant", "name", "n") VALUES (?, ?, ?) ON CONFLICT ("tenant", "name") DO UPDATE SET "name" = EXCLUDED."name", "n" = EXCLUDED."n" WHERE "items"."tenant" IS EXCLUDED."tenant"',
    },
    params: [1, 'a', 2],
  },
  {
    name: 'a row lock over an inner join, which locks the joined rows too',
    statement: {
      kind: 'select',
      from: { table: 'posts', alias: 'p' },
      columns: '*',
      joins: [
        {
          kind: 'inner',
          table: { table: 'authors', alias: 'a' },
          on: {
            op: 'compare-columns',
            left: { table: 'a', column: 'id' },
            comparison: '=',
            right: { table: 'p', column: 'author_id' },
          },
        },
      ],
      lock: { mode: 'update' },
    },
    sql: {
      postgres:
        'SELECT * FROM "posts" AS "p" INNER JOIN "authors" AS "a" ON "a"."id" = "p"."author_id" FOR UPDATE',
      mariadb:
        'SELECT * FROM `posts` AS `p` INNER JOIN `authors` AS `a` ON `a`.`id` = `p`.`author_id` FOR UPDATE',
      sqlite:
        'SELECT * FROM "posts" AS "p" INNER JOIN "authors" AS "a" ON "a"."id" = "p"."author_id"',
    },
    params: [],
  },
  {
    name: 'a select with an inner and a left join',
    statement: {
      kind: 'select',
      from: { table: 'tags', alias: 't' },
      columns: [{ column: { table: 't', column: 'name' } }],
      joins: [
        {
          kind: 'inner',
          table: { table: 'post_tags', alias: 'pt' },
          on: {
            op: 'compare-columns',
            left: { table: 'pt', column: 'tag_id' },
            comparison: '=',
            right: { table: 't', column: 'id' },
          },
        },
        {
          kind: 'left',
          table: { table: 'posts' },
          on: {
            op: 'and',
            items: [
              {
                op: 'compare-columns',
                left: { table: 'posts', column: 'id' },
                comparison: '=',
                right: { table: 'pt', column: 'post_id' },
              },
              {
                op: 'compare',
                column: { table: 'posts', column: 'live' },
                comparison: '=',
                value: true,
              },
            ],
          },
        },
      ],
      where: { op: 'null', column: { table: 'posts', column: 'id' }, negate: true },
    },
    sql: {
      postgres:
        'SELECT "t"."name" FROM "tags" AS "t" INNER JOIN "post_tags" AS "pt" ON "pt"."tag_id" = "t"."id" LEFT JOIN "posts" ON ("posts"."id" = "pt"."post_id") AND ("posts"."live" = $1) WHERE "posts"."id" IS NOT NULL',
      mariadb:
        'SELECT `t`.`name` FROM `tags` AS `t` INNER JOIN `post_tags` AS `pt` ON `pt`.`tag_id` = `t`.`id` LEFT JOIN `posts` ON (`posts`.`id` = `pt`.`post_id`) AND (`posts`.`live` = ?) WHERE `posts`.`id` IS NOT NULL',
      sqlite:
        'SELECT "t"."name" FROM "tags" AS "t" INNER JOIN "post_tags" AS "pt" ON "pt"."tag_id" = "t"."id" LEFT JOIN "posts" ON ("posts"."id" = "pt"."post_id") AND ("posts"."live" = ?) WHERE "posts"."id" IS NOT NULL',
    },
    params: [true],
  },
  {
    name: 'an upsert that does nothing',
    statement: {
      kind: 'insert',
      table: 'items',
      columns: ['name'],
      rows: [['a']],
      onConflict: { target: ['name'], action: 'nothing' },
    },
    sql: {
      postgres: 'INSERT INTO "items" ("name") VALUES ($1) ON CONFLICT ("name") DO NOTHING',
      mariadb: 'INSERT INTO `items` (`name`) VALUES (?) ON DUPLICATE KEY UPDATE `name` = `name`',
      sqlite: 'INSERT INTO "items" ("name") VALUES (?) ON CONFLICT ("name") DO NOTHING',
    },
    params: ['a'],
  },
  {
    name: 'an update with a value and an increment',
    statement: {
      kind: 'update',
      table: 'items',
      set: [
        { column: 'name', value: 'b' },
        { column: 'n', add: 1 },
      ],
      where: { op: 'compare', column: 'id', comparison: '=', value: 7 },
    },
    sql: {
      postgres: 'UPDATE "items" SET "name" = $1, "n" = "n" + $2 WHERE "id" = $3',
      mariadb: 'UPDATE `items` SET `name` = ?, `n` = `n` + ? WHERE `id` = ?',
      sqlite: 'UPDATE "items" SET "name" = ?, "n" = "n" + ? WHERE "id" = ?',
    },
    params: ['b', 1, 7],
  },
  {
    name: 'an update setting a correlated scalar subquery',
    statement: {
      kind: 'update',
      table: 'items',
      set: [
        {
          column: 'n',
          select: {
            kind: 'select',
            from: { table: 'items', alias: 'c' },
            columns: [{ aggregate: 'count', as: 'k' }],
            where: {
              op: 'compare-columns',
              left: { table: 'c', column: 'parent_id' },
              comparison: '=',
              right: { table: 'items', column: 'id' },
            },
          },
        },
      ],
      where: { op: 'in', column: 'id', values: [1, 2] },
    },
    sql: {
      postgres:
        'UPDATE "items" SET "n" = (SELECT COUNT(*) AS "k" FROM "items" AS "c" WHERE "c"."parent_id" = "items"."id") WHERE "id" = ANY($1)',
      mariadb:
        'UPDATE `items` SET `n` = (SELECT COUNT(*) AS `k` FROM `items` AS `c` WHERE `c`.`parent_id` = `items`.`id`) WHERE `id` IN (?, ?)',
      sqlite:
        'UPDATE "items" SET "n" = (SELECT COUNT(*) AS "k" FROM "items" AS "c" WHERE "c"."parent_id" = "items"."id") WHERE "id" IN (?, ?)',
    },
    params: { postgres: ['{"1","2"}'], mariadb: [1, 2], sqlite: [1, 2] },
  },
  {
    name: 'a delete of every row, returning them',
    statement: { kind: 'delete', table: 'items', where: { op: 'true' }, returning: ['id'] },
    sql: {
      postgres: 'DELETE FROM "items" WHERE 1 = 1 RETURNING "id"',
      mariadb: 'DELETE FROM `items` WHERE 1 = 1 RETURNING `id`',
      sqlite: 'DELETE FROM "items" WHERE 1 = 1 RETURNING "id"',
    },
    params: [],
  },
];

describe('compileStatement', () => {
  for (const testCase of CASES) {
    it(`renders ${testCase.name}`, () => {
      for (const dialect of DIALECTS) {
        const compiled = compileStatement(testCase.statement, dialect);
        assert.equal(compiled.sql, testCase.sql[dialect], dialect);
        const params = Array.isArray(testCase.params)
          ? testCase.params
          : (testCase.params as Readonly<Record<Dialect, readonly unknown[]>>)[dialect];
        assert.deepEqual(compiled.params, params, dialect);
        assert.ok(Object.isFrozen(compiled));
      }
    });
  }

  it('never splices a value into the SQL text', () => {
    const marker = "x'); DROP TABLE users; --";
    for (const dialect of DIALECTS) {
      const { sql, params } = compileStatement(
        {
          kind: 'update',
          table: 'users',
          set: [{ column: 'name', value: marker }],
          where: { op: 'like', column: 'email', pattern: marker },
        },
        dialect,
      );
      assert.ok(!sql.includes('DROP'));
      assert.deepEqual(params, [marker, marker]);
    }
  });

  it('refuses identifiers that are not plain names, without echoing them', () => {
    for (const name of ['a"b', 'a`b', 'a b', '1a', '', 'x'.repeat(64), 'a;b', 'é']) {
      assert.throws(
        () => compileStatement({ kind: 'select', from: { table: name }, columns: '*' }, 'postgres'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: string }).code, 'invalid_statement');
          if (name !== '') assert.ok(!error.message.includes(name));
          return true;
        },
      );
    }
  });

  const refusals: readonly [string, Statement, string][] = [
    [
      'a comparison with null',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        where: { op: 'compare', column: 'a', comparison: '=', value: null },
      },
      'invalid_statement',
    ],
    [
      'null in an IN list',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        where: { op: 'in', column: 'a', values: [1, null] },
      },
      'invalid_statement',
    ],
    [
      'a row comparison of mismatched widths',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        where: { op: 'row-compare', columns: ['a', 'b'], comparison: '>', values: [1] },
      },
      'invalid_statement',
    ],
    [
      'a negative limit',
      { kind: 'select', from: { table: 't' }, columns: '*', limit: -1 },
      'invalid_statement',
    ],
    [
      'a fractional offset',
      { kind: 'select', from: { table: 't' }, columns: '*', offset: 1.5 },
      'invalid_statement',
    ],
    ['no columns', { kind: 'select', from: { table: 't' }, columns: [] }, 'invalid_statement'],
    [
      'SUM(*)',
      { kind: 'select', from: { table: 't' }, columns: [{ aggregate: 'sum', as: 's' }] },
      'invalid_statement',
    ],
    [
      'a window limit without an order',
      {
        kind: 'select',
        from: { table: 't' },
        columns: [{ column: 'a' }],
        windowLimit: { partitionBy: ['a'], limit: 1 },
      },
      'invalid_statement',
    ],
    [
      'a window limit over every column',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        orderBy: [{ column: 'a' }],
        windowLimit: { partitionBy: ['a'], limit: 1 },
      },
      'invalid_statement',
    ],
    [
      'a window limit with a limit',
      {
        kind: 'select',
        from: { table: 't' },
        columns: [{ column: 'a' }],
        orderBy: [{ column: 'a' }],
        limit: 2,
        windowLimit: { partitionBy: ['a'], limit: 1 },
      },
      'invalid_statement',
    ],
    [
      'an insert of no rows',
      { kind: 'insert', table: 't', columns: ['a'], rows: [] },
      'invalid_statement',
    ],
    [
      'a ragged insert',
      { kind: 'insert', table: 't', columns: ['a', 'b'], rows: [[1]] },
      'invalid_statement',
    ],
    [
      'two rows of defaults',
      { kind: 'insert', table: 't', columns: [], rows: [[], []] },
      'invalid_statement',
    ],
    [
      'an upsert without a target',
      {
        kind: 'insert',
        table: 't',
        columns: ['a'],
        rows: [[1]],
        onConflict: { target: [], action: 'nothing' },
      },
      'invalid_statement',
    ],
    [
      'an upsert updating nothing',
      {
        kind: 'insert',
        table: 't',
        columns: ['a'],
        rows: [[1]],
        onConflict: { target: ['a'], action: 'update', update: [] },
      },
      'invalid_statement',
    ],
    [
      'an unknown join kind',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        joins: [{ kind: 'cross' as 'inner', table: { table: 'u' }, on: { op: 'true' } }],
      },
      'invalid_statement',
    ],
    // PostgreSQL cannot lock these shapes row by row (MariaDB runs them and
    // SQLite drops the lock), so every dialect refuses them at compile time.
    [
      'a row lock over a left join',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        joins: [{ kind: 'left', table: { table: 'u' }, on: { op: 'true' } }],
        lock: { mode: 'update' },
      },
      'invalid_statement',
    ],
    [
      'a row lock over DISTINCT',
      {
        kind: 'select',
        from: { table: 't' },
        columns: '*',
        distinct: true,
        lock: { mode: 'share' },
      },
      'invalid_statement',
    ],
    [
      'a row lock over GROUP BY',
      {
        kind: 'select',
        from: { table: 't' },
        columns: [{ column: 'a' }],
        groupBy: ['a'],
        lock: { mode: 'update' },
      },
      'invalid_statement',
    ],
    [
      'a row lock over an aggregate',
      {
        kind: 'select',
        from: { table: 't' },
        columns: [{ aggregate: 'count', as: 'n' }],
        lock: { mode: 'update', wait: 'nowait' },
      },
      'invalid_statement',
    ],
    [
      'an empty upsert guard',
      {
        kind: 'insert',
        table: 't',
        columns: ['a', 'b'],
        rows: [[1, 2]],
        onConflict: { target: ['a'], action: 'update', update: ['b'], guard: [] },
      },
      'invalid_statement',
    ],
    [
      'an insert naming a column twice',
      { kind: 'insert', table: 't', columns: ['a', 'a'], rows: [[1, 2]] },
      'invalid_statement',
    ],
    [
      'an update setting a column twice',
      {
        kind: 'update',
        table: 't',
        set: [
          { column: 'a', value: 1 },
          { column: 'a', add: 1 },
        ],
        where: { op: 'true' },
      },
      'invalid_statement',
    ],
    [
      'an upsert updating a column twice',
      {
        kind: 'insert',
        table: 't',
        columns: ['a', 'b'],
        rows: [[1, 2]],
        onConflict: { target: ['a'], action: 'update', update: ['b', 'b'] },
      },
      'invalid_statement',
    ],
    [
      'an empty RETURNING',
      { kind: 'delete', table: 't', where: { op: 'true' }, returning: [] },
      'invalid_statement',
    ],
    [
      'an update setting nothing',
      { kind: 'update', table: 't', set: [], where: { op: 'true' } },
      'invalid_statement',
    ],
    [
      'an infinite increment',
      { kind: 'update', table: 't', set: [{ column: 'a', add: Infinity }], where: { op: 'true' } },
      'invalid_statement',
    ],
    [
      'a SET subquery of every column',
      {
        kind: 'update',
        table: 't',
        set: [{ column: 'a', select: { kind: 'select', from: { table: 'u' }, columns: '*' } }],
        where: { op: 'true' },
      },
      'invalid_statement',
    ],
    [
      'a SET subquery of two columns',
      {
        kind: 'update',
        table: 't',
        set: [
          {
            column: 'a',
            select: {
              kind: 'select',
              from: { table: 'u' },
              columns: [{ column: 'x' }, { column: 'y' }],
            },
          },
        ],
        where: { op: 'true' },
      },
      'invalid_statement',
    ],
  ];
  for (const [name, statement, code] of refusals) {
    it(`refuses ${name}`, () => {
      for (const dialect of DIALECTS) {
        assert.throws(() => compileStatement(statement, dialect), { code }, dialect);
      }
    });
  }

  it('refuses what MariaDB cannot run, and renders it elsewhere', () => {
    const updateReturning: Statement = {
      kind: 'update',
      table: 't',
      set: [{ column: 'a', value: 1 }],
      where: { op: 'true' },
      returning: ['id'],
    };
    const limitedInSelect: Statement = {
      kind: 'select',
      from: { table: 't' },
      columns: '*',
      where: {
        op: 'in-select',
        columns: ['id'],
        select: { kind: 'select', from: { table: 'u' }, columns: [{ column: 't_id' }], limit: 5 },
      },
    };
    const guardedReturning: Statement = {
      kind: 'insert',
      table: 't',
      columns: ['tenant', 'a'],
      rows: [[1, 2]],
      onConflict: { target: ['tenant', 'a'], action: 'update', update: ['a'], guard: ['tenant'] },
      returning: ['id'],
    };
    for (const statement of [updateReturning, limitedInSelect, guardedReturning]) {
      assert.throws(() => compileStatement(statement, 'mariadb'), {
        code: 'unsupported_statement',
      });
      compileStatement(statement, 'postgres');
      compileStatement(statement, 'sqlite');
    }
  });

  it('refuses on MariaDB a guard column that the upsert also assigns', () => {
    const statement: Statement = {
      kind: 'insert',
      table: 't',
      columns: ['tenant', 'a'],
      rows: [[1, 2]],
      onConflict: { target: ['a'], action: 'update', update: ['tenant', 'a'], guard: ['tenant'] },
    };
    // Each MariaDB assignment reads the row as the earlier ones left it, so
    // assigning the guard would change the test midway.
    assert.throws(() => compileStatement(statement, 'mariadb'), { code: 'invalid_statement' });
    compileStatement(statement, 'postgres');
    compileStatement(statement, 'sqlite');
  });

  it('binds an IN list as one PostgreSQL array, escaped element by element', () => {
    const where = (values: readonly SqlValue[], negate = false): Statement => ({
      kind: 'select',
      from: { table: 't' },
      columns: '*',
      where: { op: 'in', column: 'a', values, ...(negate ? { negate } : {}) },
    });
    const bytes = new Uint8Array([0x0a, 0xff]);
    const mixed = compileStatement(
      where(['plain', 'quo"te', 'back\\slash', 'a,b {c}', '', 12n, 1.5, true, bytes]),
      'postgres',
    );
    assert.equal(mixed.sql, 'SELECT * FROM "t" WHERE "a" = ANY($1)');
    assert.deepEqual(mixed.params, [
      '{"plain","quo\\"te","back\\\\slash","a,b {c}","","12","1.5","true",\\\\x0aff}',
    ]);
    // The text pg itself sends for a JavaScript array of the same values.
    const pgUtils = createRequire(import.meta.url)('pg/lib/utils.js') as {
      prepareValue(value: unknown): unknown;
    };
    assert.equal(
      mixed.params[0],
      pgUtils.prepareValue([
        'plain',
        'quo"te',
        'back\\slash',
        'a,b {c}',
        '',
        12n,
        1.5,
        true,
        bytes,
      ]),
    );
    const negated = compileStatement(where([1, 2], true), 'postgres');
    assert.equal(negated.sql, 'SELECT * FROM "t" WHERE "a" <> ALL($1)');
    assert.deepEqual(negated.params, ['{"1","2"}']);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => compileStatement(where([1, value]), 'postgres'), {
        code: 'invalid_statement',
      });
    }
    assert.throws(() => compileStatement(where([1, null]), 'postgres'), {
      code: 'invalid_statement',
    });
    // A list past every other dialect's bind limit is one parameter there.
    const many = Array.from({ length: BIND_LIMITS.postgres + 1 }, (_, index) => index);
    assert.equal(compileStatement(where(many), 'postgres').params.length, 1);
    for (const dialect of ['mariadb', 'sqlite'] as const) {
      assert.throws(() => compileStatement(where(many), dialect), { code: 'too_many_parameters' });
    }
  });

  it("lets a window select output any name but its own columns' names", () => {
    const windowed = (name: string): Statement => ({
      kind: 'select',
      from: { table: 'c' },
      columns: [{ column: 'id' }, { column: 'post_id', as: name }],
      orderBy: [{ column: 'id' }],
      windowLimit: { partitionBy: ['post_id'], limit: 2 },
    });
    for (const dialect of DIALECTS) {
      assert.match(compileStatement(windowed('jsails_owner'), dialect).sql, /jsails_owner/);
      for (const reserved of ['jsails_w', 'jsails_rn', 'jsails_p0', 'jsails_p12']) {
        assert.throws(() => compileStatement(windowed(reserved), dialect), {
          code: 'invalid_statement',
        });
      }
    }
  });

  it('refuses a statement past the bind limit of its dialect', () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => [index]);
    for (const dialect of DIALECTS) {
      const limit = BIND_LIMITS[dialect];
      compileStatement({ kind: 'insert', table: 't', columns: ['a'], rows: rows(limit) }, dialect);
      assert.throws(
        () =>
          compileStatement(
            { kind: 'insert', table: 't', columns: ['a'], rows: rows(limit + 1) },
            dialect,
          ),
        { code: 'too_many_parameters' },
      );
    }
  });
});

describe('quoting and placeholders match the TypeORM drivers', () => {
  const sources: Readonly<Record<Dialect, DataSource>> = {
    postgres: new DataSource({ type: 'postgres', entities: [] }),
    mariadb: new DataSource({ type: 'mariadb', entities: [] }),
    sqlite: new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      driver: NodeSqliteDatabase,
      entities: [],
    }),
  };

  it('quotes every identifier as the driver escapes it', () => {
    for (const dialect of DIALECTS) {
      for (const name of ['id', 'post_id', 'Mixed_Case9', '_x']) {
        assert.equal(quoteIdentifier(dialect, name), sources[dialect].driver.escape(name), dialect);
      }
    }
  });

  it('numbers placeholders as the driver creates them', () => {
    for (const dialect of DIALECTS) {
      const { sql } = compileStatement(
        { kind: 'insert', table: 't', columns: ['a', 'b', 'c'], rows: [[1, 2, 3]] },
        dialect,
      );
      const expected = [0, 1, 2].map((index) =>
        sources[dialect].driver.createParameter('p', index),
      );
      assert.ok(sql.endsWith(`VALUES (${expected.join(', ')})`), dialect);
    }
  });
});
