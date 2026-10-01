/**
 * Statement rendering, offline: the exact SQL and parameters of every shape
 * on each dialect, the refusals, and identifier quoting and placeholders
 * pinned to TypeORM's own driver functions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataSource } from 'typeorm';

import {
  BIND_LIMITS,
  compileStatement,
  quoteIdentifier,
  type Dialect,
  type Statement,
} from '../../src/engine/index.js';
import { NodeSqliteDatabase } from '../../src/engine/sqlite/node-sqlite-adapter.js';

const DIALECTS: readonly Dialect[] = ['postgres', 'mariadb', 'sqlite'];

interface Case {
  readonly name: string;
  readonly statement: Statement;
  readonly sql: Readonly<Record<Dialect, string>>;
  readonly params: readonly unknown[];
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
        'SELECT DISTINCT "p"."id", "title" AS "heading" FROM "posts" AS "p" WHERE ("status" = $1) AND ("author_id" IN ($2, $3)) AND ("deleted_at" IS NULL) ORDER BY "created_at" DESC LIMIT $4 OFFSET $5',
      mariadb:
        'SELECT DISTINCT `p`.`id`, `title` AS `heading` FROM `posts` AS `p` WHERE (`status` = ?) AND (`author_id` IN (?, ?)) AND (`deleted_at` IS NULL) ORDER BY `created_at` DESC LIMIT ? OFFSET ?',
      sqlite:
        'SELECT DISTINCT "p"."id", "title" AS "heading" FROM "posts" AS "p" WHERE ("status" = ?) AND ("author_id" IN (?, ?)) AND ("deleted_at" IS NULL) ORDER BY "created_at" DESC LIMIT ? OFFSET ?',
    },
    params: ['live', 1, 2, 10, 20],
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
        'SELECT "jsails_w"."id", "jsails_w"."post_id" FROM (SELECT "id" AS "id", "post_id" AS "post_id", "post_id" AS "jsails_p0", ROW_NUMBER() OVER (PARTITION BY "post_id" ORDER BY "created_at" DESC) AS "jsails_rn" FROM "comments" WHERE "post_id" IN ($1, $2)) AS "jsails_w" WHERE "jsails_w"."jsails_rn" <= $3 ORDER BY "jsails_w"."jsails_p0", "jsails_w"."jsails_rn"',
      mariadb:
        'SELECT `jsails_w`.`id`, `jsails_w`.`post_id` FROM (SELECT `id` AS `id`, `post_id` AS `post_id`, `post_id` AS `jsails_p0`, ROW_NUMBER() OVER (PARTITION BY `post_id` ORDER BY `created_at` DESC) AS `jsails_rn` FROM `comments` WHERE `post_id` IN (?, ?)) AS `jsails_w` WHERE `jsails_w`.`jsails_rn` <= ? ORDER BY `jsails_w`.`jsails_p0`, `jsails_w`.`jsails_rn`',
      sqlite:
        'SELECT "jsails_w"."id", "jsails_w"."post_id" FROM (SELECT "id" AS "id", "post_id" AS "post_id", "post_id" AS "jsails_p0", ROW_NUMBER() OVER (PARTITION BY "post_id" ORDER BY "created_at" DESC) AS "jsails_rn" FROM "comments" WHERE "post_id" IN (?, ?)) AS "jsails_w" WHERE "jsails_w"."jsails_rn" <= ? ORDER BY "jsails_w"."jsails_p0", "jsails_w"."jsails_rn"',
    },
    params: [1, 2, 3],
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
        assert.deepEqual(compiled.params, testCase.params, dialect);
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
    for (const statement of [updateReturning, limitedInSelect]) {
      assert.throws(() => compileStatement(statement, 'mariadb'), {
        code: 'unsupported_statement',
      });
      compileStatement(statement, 'postgres');
      compileStatement(statement, 'sqlite');
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
