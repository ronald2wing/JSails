/**
 * The tenant policy, without a database: a table of every IR position a
 * tenant-scoped table can take (main table, alias, inner and left join, a
 * join reached through a link table, EXISTS, NOT EXISTS, IN, nested and
 * negated subqueries, a subquery in a join's ON, the inner select of a
 * window limit, keyset pages, and the targets of update, delete, insert and
 * upsert), compiled on all three dialects, with the tenant condition asserted
 * at each position in the SQL and by the coverage checker. Then each refusal:
 * a missing scope (empty reads, throwing writes), another tenant's row or
 * SET, an upsert that could reach another tenant's row, an unknown table, and
 * the opt-out with its ledger origin.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Dialect, Statement } from '../../src/engine/index.js';
import {
  applyPolicies,
  compileGuarded,
  createStatementCatalog,
  findUnscopedReferences,
  ir,
  runWithTenant,
  StatementErrors,
  TENANT_UNSCOPED_ORIGIN,
  TenantScopeErrors,
  withoutTenantScope,
  type TenantScopeState,
} from '../../src/index.js';
import { MODELS } from './fixtures/tenant-models.js';

const { and, col, compareColumns, deleteFrom, eq, exists, inList, inSelect, insert, join } = ir;
const { not, or, rowCompare, select, table, update } = ir;

const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres', 'mariadb'];
const TENANT = 7;
const SCOPED: TenantScopeState = Object.freeze({ tenantId: TENANT, unscoped: false });
const NONE: TenantScopeState = Object.freeze({ tenantId: undefined, unscoped: false });
const UNSCOPED: TenantScopeState = Object.freeze({ tenantId: TENANT, unscoped: true });

const catalogs = new Map(
  DIALECTS.map((dialect) => [dialect, createStatementCatalog({ dialect, models: MODELS })]),
);

function catalog(dialect: Dialect = 'sqlite') {
  return catalogs.get(dialect) as ReturnType<typeof createStatementCatalog>;
}

const ids = [{ column: 'id' }] as const;

interface PositionCase {
  readonly name: string;
  readonly statement: Statement;
  /** Qualifiers whose tenant column must carry the condition, one per tenant-scoped reference. */
  readonly scoped: readonly string[];
  /** The policy's SQL on SQLite, verbatim. */
  readonly sqlite: string;
}

const POSITIONS: readonly PositionCase[] = [
  {
    name: 'the main table of a select',
    statement: select('st_posts'),
    scoped: ['st_posts'],
    sqlite: 'SELECT * FROM "st_posts" WHERE "st_posts"."tenant_id" = ?',
  },
  {
    name: 'an aliased main table, ahead of its own condition',
    statement: select(table('st_posts', 'p'), { where: eq(col('p', 'slug'), 'a') }),
    scoped: ['p'],
    sqlite: 'SELECT * FROM "st_posts" AS "p" WHERE ("p"."tenant_id" = ?) AND ("p"."slug" = ?)',
  },
  {
    name: 'an inner join, in its ON',
    statement: select(table('st_posts', 'p'), {
      joins: [
        join(table('st_comments', 'c'), compareColumns(col('c', 'post_id'), '=', col('p', 'id'))),
      ],
    }),
    scoped: ['p', 'c'],
    sqlite:
      'SELECT * FROM "st_posts" AS "p" INNER JOIN "st_comments" AS "c" ON ("c"."tenant_id" = ?) AND ("c"."post_id" = "p"."id") WHERE "p"."tenant_id" = ?',
  },
  {
    name: 'a left join from a global table',
    statement: select(table('st_authors', 'a'), {
      joins: [
        join(
          table('st_posts', 'p'),
          compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
          'left',
        ),
      ],
    }),
    scoped: ['p'],
    sqlite:
      'SELECT * FROM "st_authors" AS "a" LEFT JOIN "st_posts" AS "p" ON ("p"."tenant_id" = ?) AND ("p"."author_id" = "a"."id")',
  },
  {
    name: 'a through join over a link table to a global table',
    statement: select(table('st_tags', 't'), {
      columns: [{ column: col('t', 'name') }, { column: col('pt', 'post_id') }],
      joins: [
        join(table('st_post_tags', 'pt'), compareColumns(col('pt', 'tag_id'), '=', col('t', 'id'))),
      ],
      where: inList(col('pt', 'post_id'), [1, 2]),
    }),
    scoped: ['pt'],
    sqlite:
      'SELECT "t"."name", "pt"."post_id" FROM "st_tags" AS "t" INNER JOIN "st_post_tags" AS "pt" ON ("pt"."tenant_id" = ?) AND ("pt"."tag_id" = "t"."id") WHERE "pt"."post_id" IN (?, ?)',
  },
  {
    name: 'an EXISTS subquery under a global table',
    statement: select(table('st_authors', 'a'), {
      where: exists(
        select(table('st_posts', 'p'), {
          columns: ids,
          where: compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
        }),
      ),
    }),
    scoped: ['p'],
    sqlite:
      'SELECT * FROM "st_authors" AS "a" WHERE EXISTS (SELECT "id" FROM "st_posts" AS "p" WHERE ("p"."tenant_id" = ?) AND ("p"."author_id" = "a"."id"))',
  },
  {
    name: 'a NOT EXISTS subquery',
    statement: select(table('st_posts', 'p'), {
      where: exists(
        select(table('st_comments', 'c'), {
          columns: ids,
          where: compareColumns(col('c', 'post_id'), '=', col('p', 'id')),
        }),
        true,
      ),
    }),
    scoped: ['p', 'c'],
    sqlite:
      'SELECT * FROM "st_posts" AS "p" WHERE ("p"."tenant_id" = ?) AND (NOT EXISTS (SELECT "id" FROM "st_comments" AS "c" WHERE ("c"."tenant_id" = ?) AND ("c"."post_id" = "p"."id")))',
  },
  {
    name: 'an IN subquery',
    statement: select('st_tags', {
      where: inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] })),
    }),
    scoped: ['st_post_tags'],
    sqlite:
      'SELECT * FROM "st_tags" WHERE "id" IN (SELECT "tag_id" FROM "st_post_tags" WHERE "st_post_tags"."tenant_id" = ?)',
  },
  {
    name: 'a subquery nested in a subquery',
    statement: select(table('st_authors', 'a'), {
      where: exists(
        select(table('st_posts', 'p'), {
          columns: ids,
          where: and(
            compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
            exists(
              select(table('st_comments', 'c'), {
                columns: ids,
                where: compareColumns(col('c', 'post_id'), '=', col('p', 'id')),
              }),
            ),
          ),
        }),
      ),
    }),
    scoped: ['p', 'c'],
    sqlite:
      'SELECT * FROM "st_authors" AS "a" WHERE EXISTS (SELECT "id" FROM "st_posts" AS "p" WHERE ("p"."tenant_id" = ?) AND ("p"."author_id" = "a"."id") AND (EXISTS (SELECT "id" FROM "st_comments" AS "c" WHERE ("c"."tenant_id" = ?) AND ("c"."post_id" = "p"."id"))))',
  },
  {
    name: 'a subquery under OR and NOT',
    statement: select('st_tags', {
      where: or(
        eq('name', 'x'),
        not(inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] }))),
      ),
    }),
    scoped: ['st_post_tags'],
    sqlite:
      'SELECT * FROM "st_tags" WHERE ("name" = ?) OR (NOT ("id" IN (SELECT "tag_id" FROM "st_post_tags" WHERE "st_post_tags"."tenant_id" = ?)))',
  },
  {
    name: "a subquery in a join's ON",
    statement: select(table('st_authors', 'a'), {
      joins: [
        join(
          table('st_tags', 't'),
          inSelect(col('t', 'id'), select('st_post_tags', { columns: [{ column: 'tag_id' }] })),
        ),
      ],
    }),
    scoped: ['st_post_tags'],
    sqlite:
      'SELECT * FROM "st_authors" AS "a" INNER JOIN "st_tags" AS "t" ON "t"."id" IN (SELECT "tag_id" FROM "st_post_tags" WHERE "st_post_tags"."tenant_id" = ?)',
  },
  {
    name: 'the inner select of a window limit',
    statement: select(table('st_comments', 'c'), {
      columns: [{ column: col('c', 'id') }, { column: col('c', 'post_id'), as: 'post_id' }],
      where: inList(col('c', 'post_id'), [1, 2]),
      orderBy: [{ column: col('c', 'id'), direction: 'desc' }],
      windowLimit: { partitionBy: [col('c', 'post_id')], limit: 3 },
    }),
    scoped: ['c'],
    sqlite:
      'SELECT "jsails_w"."id", "jsails_w"."post_id" FROM (SELECT "c"."id" AS "id", "c"."post_id" AS "post_id", "c"."post_id" AS "jsails_p0", ROW_NUMBER() OVER (PARTITION BY "c"."post_id" ORDER BY "c"."id" DESC) AS "jsails_rn" FROM "st_comments" AS "c" WHERE ("c"."tenant_id" = ?) AND ("c"."post_id" IN (?, ?))) AS "jsails_w" WHERE "jsails_w"."jsails_rn" <= ? ORDER BY "jsails_w"."jsails_p0", "jsails_w"."jsails_rn"',
  },
  {
    name: 'a keyset page with a row lock',
    statement: select('st_posts', {
      where: rowCompare(['views', 'id'], '>', [10, 3]),
      orderBy: [{ column: 'views' }, { column: 'id' }],
      limit: 50,
      lock: { mode: 'update' },
    }),
    scoped: ['st_posts'],
    sqlite:
      'SELECT * FROM "st_posts" WHERE ("st_posts"."tenant_id" = ?) AND (("views", "id") > (?, ?)) ORDER BY "views" ASC, "id" ASC LIMIT ?',
  },
  {
    name: 'the target of an update, and a subquery in its WHERE',
    statement: update(
      'st_posts',
      [{ column: 'views', add: 1 }],
      exists(
        select(table('st_comments', 'c'), {
          columns: ids,
          where: compareColumns(col('c', 'post_id'), '=', col('st_posts', 'id')),
        }),
      ),
    ),
    scoped: ['st_posts', 'c'],
    sqlite:
      'UPDATE "st_posts" SET "views" = "views" + ? WHERE ("st_posts"."tenant_id" = ?) AND (EXISTS (SELECT "id" FROM "st_comments" AS "c" WHERE ("c"."tenant_id" = ?) AND ("c"."post_id" = "st_posts"."id")))',
  },
  {
    name: 'a scalar subquery in an update SET term (a counter recount)',
    statement: update(
      'st_posts',
      [
        {
          column: 'views',
          select: select(table('st_comments', 'c'), {
            columns: [{ aggregate: 'count', as: 'n' }],
            where: compareColumns(col('c', 'post_id'), '=', col('st_posts', 'id')),
          }),
        },
      ],
      inList('id', [1, 2]),
    ),
    scoped: ['c', 'st_posts'],
    sqlite:
      'UPDATE "st_posts" SET "views" = (SELECT COUNT(*) AS "n" FROM "st_comments" AS "c" WHERE ("c"."tenant_id" = ?) AND ("c"."post_id" = "st_posts"."id")) WHERE ("st_posts"."tenant_id" = ?) AND ("id" IN (?, ?))',
  },
  {
    name: 'an update of every row of a tenant table',
    statement: update('st_posts', [{ column: 'status', value: 'live' }], ir.TRUE),
    scoped: ['st_posts'],
    sqlite: 'UPDATE "st_posts" SET "status" = ? WHERE "st_posts"."tenant_id" = ?',
  },
  {
    name: 'an update of a global table filtered by a tenant subquery',
    statement: update(
      'st_tags',
      [{ column: 'name', value: 'x' }],
      inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] }), true),
    ),
    scoped: ['st_post_tags'],
    sqlite:
      'UPDATE "st_tags" SET "name" = ? WHERE "id" NOT IN (SELECT "tag_id" FROM "st_post_tags" WHERE "st_post_tags"."tenant_id" = ?)',
  },
  {
    name: 'the target of a delete',
    statement: deleteFrom('st_comments', inList('post_id', [1, 2])),
    scoped: ['st_comments'],
    sqlite:
      'DELETE FROM "st_comments" WHERE ("st_comments"."tenant_id" = ?) AND ("post_id" IN (?, ?))',
  },
  {
    name: 'a string tenant column',
    statement: select('st_notes'),
    scoped: ['st_notes'],
    sqlite: 'SELECT * FROM "st_notes" WHERE "st_notes"."org" = ?',
  },
];

function tenantColumn(qualifier: string): string {
  return qualifier === 'st_notes' ? 'org' : 'tenant_id';
}

function quote(dialect: Dialect, name: string): string {
  return dialect === 'mariadb' ? `\`${name}\`` : `"${name}"`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('the tenant policy at every IR position', () => {
  for (const position of POSITIONS) {
    it(position.name, () => {
      for (const dialect of DIALECTS) {
        const compiled = compileGuarded(catalog(dialect), position.statement, SCOPED);
        if (dialect === 'sqlite') assert.equal(compiled.sql, position.sqlite);
        const placeholder = dialect === 'postgres' ? '\\$\\d+' : '\\?';
        for (const qualifier of position.scoped) {
          const condition = new RegExp(
            `${escapeRegExp(`${quote(dialect, qualifier)}.${quote(dialect, tenantColumn(qualifier))}`)} = ${placeholder}`,
          );
          assert.match(compiled.sql, condition, `${dialect}: ${qualifier} carries the tenant`);
        }
        const tenantParams = compiled.params.filter(
          (param) => param === TENANT || param === String(TENANT),
        );
        assert.equal(tenantParams.length, position.scoped.length, `${dialect}: one per reference`);
        assert.equal(compiled.origin, undefined);
        const guarded = applyPolicies(position.statement, {
          tables: catalog(dialect),
          scope: SCOPED,
        });
        assert.deepEqual(findUnscopedReferences(guarded, catalog(dialect), SCOPED), []);
        assert.ok(
          findUnscopedReferences(position.statement, catalog(dialect), SCOPED).length > 0,
          'the statement as written is not covered',
        );
      }
    });
  }

  it('stamps an insert that does not name the tenant', () => {
    const statement = insert(
      'st_posts',
      ['title', 'slug'],
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    );
    const compiled = compileGuarded(catalog(), statement, SCOPED);
    assert.equal(
      compiled.sql,
      'INSERT INTO "st_posts" ("title", "slug", "tenant_id") VALUES (?, ?, ?), (?, ?, ?)',
    );
    assert.deepEqual(compiled.params, ['a', 'b', 7, 'c', 'd', 7]);
    const guarded = applyPolicies(statement, { tables: catalog(), scope: SCOPED });
    assert.deepEqual(findUnscopedReferences(guarded, catalog(), SCOPED), []);
  });

  it('stamps an insert of default values', () => {
    const statement = insert('st_comments', [], [[]]);
    const compiled = compileGuarded(catalog(), statement, SCOPED);
    assert.equal(compiled.sql, 'INSERT INTO "st_comments" ("tenant_id") VALUES (?)');
  });

  it('keeps an insert that names the current tenant, as a bigint too', () => {
    const statement = insert('st_posts', ['title', 'tenant_id'], [['a', 7n]]);
    const compiled = compileGuarded(catalog(), statement, SCOPED);
    assert.equal(compiled.sql, 'INSERT INTO "st_posts" ("title", "tenant_id") VALUES (?, ?)');
  });

  it('guards an upsert on every dialect and keeps its conflict target', () => {
    const statement = insert('st_posts', ['title', 'slug'], [['a', 'b']], {
      onConflict: { target: ['tenant_id', 'slug'], action: 'update', update: ['title'] },
    });
    const sql = Object.fromEntries(
      DIALECTS.map((dialect) => [dialect, compileGuarded(catalog(dialect), statement, SCOPED).sql]),
    );
    assert.deepEqual(sql, {
      sqlite:
        'INSERT INTO "st_posts" ("title", "slug", "tenant_id") VALUES (?, ?, ?) ON CONFLICT ("tenant_id", "slug") DO UPDATE SET "title" = EXCLUDED."title" WHERE "st_posts"."tenant_id" IS EXCLUDED."tenant_id"',
      postgres:
        'INSERT INTO "st_posts" ("title", "slug", "tenant_id") VALUES ($1, $2, $3) ON CONFLICT ("tenant_id", "slug") DO UPDATE SET "title" = EXCLUDED."title" WHERE "st_posts"."tenant_id" IS NOT DISTINCT FROM EXCLUDED."tenant_id"',
      mariadb:
        'INSERT INTO `st_posts` (`title`, `slug`, `tenant_id`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `title` = IF(`tenant_id` <=> VALUES(`tenant_id`), VALUES(`title`), `title`)',
    });
    const nothing = insert('st_posts', ['title', 'slug'], [['a', 'b']], {
      onConflict: { target: ['tenant_id', 'slug'], action: 'nothing' },
    });
    assert.equal(
      compileGuarded(catalog(), nothing, SCOPED).sql,
      'INSERT INTO "st_posts" ("title", "slug", "tenant_id") VALUES (?, ?, ?) ON CONFLICT ("tenant_id", "slug") DO NOTHING',
    );
  });

  it('refuses a guarded upsert with RETURNING on MariaDB only', () => {
    const statement = insert('st_posts', ['title', 'slug'], [['a', 'b']], {
      onConflict: { target: ['tenant_id', 'slug'], action: 'update', update: ['title'] },
      returning: ['id'],
    });
    assert.throws(
      () => compileGuarded(catalog('mariadb'), statement, SCOPED),
      (error: unknown) => (error as { code?: string }).code === 'unsupported_statement',
    );
    assert.match(compileGuarded(catalog('postgres'), statement, SCOPED).sql, /RETURNING "id"$/);
  });
});

describe('the tenant policy without a tenant', () => {
  it('empties the whole read when it references a tenant-scoped table anywhere', () => {
    const statement = POSITIONS[8]?.statement as Statement;
    const compiled = compileGuarded(catalog(), statement, NONE);
    assert.equal(compiled.sql, 'SELECT * FROM "st_authors" AS "a" WHERE 1 = 0');
    assert.deepEqual(compiled.params, []);
    const guarded = applyPolicies(statement, { tables: catalog(), scope: NONE });
    assert.deepEqual(findUnscopedReferences(guarded, catalog(), NONE), []);
  });

  // Emptying only the tenant-scoped reference would make each of these true
  // for every outer row: an author "without posts", a tag "never linked",
  // every author kept by the left join.
  const negated: readonly [string, Statement, string][] = [
    [
      'a NOT EXISTS over a tenant table',
      select(table('st_authors', 'a'), {
        where: and(
          eq(col('a', 'id'), 5),
          exists(
            select(table('st_posts', 'p'), {
              columns: ids,
              where: compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
            }),
            true,
          ),
        ),
      }),
      'SELECT * FROM "st_authors" AS "a" WHERE 1 = 0',
    ],
    [
      'a NOT IN over a tenant table',
      select('st_tags', {
        where: inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] }), true),
      }),
      'SELECT * FROM "st_tags" WHERE 1 = 0',
    ],
    [
      'a NOT around an IN over a tenant table',
      select('st_tags', {
        where: not(inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] }))),
      }),
      'SELECT * FROM "st_tags" WHERE 1 = 0',
    ],
    [
      'a left join of a tenant table',
      POSITIONS[3]?.statement as Statement,
      'SELECT * FROM "st_authors" AS "a" LEFT JOIN "st_posts" AS "p" ON "p"."author_id" = "a"."id" WHERE 1 = 0',
    ],
  ];
  for (const [name, statement, sql] of negated) {
    it(`empties ${name}`, () => {
      const compiled = compileGuarded(catalog(), statement, NONE);
      assert.equal(compiled.sql, sql);
      assert.deepEqual(compiled.params, []);
      for (const dialect of DIALECTS) compileGuarded(catalog(dialect), statement, NONE);
      const guarded = applyPolicies(statement, { tables: catalog(), scope: NONE });
      assert.deepEqual(findUnscopedReferences(guarded, catalog(), NONE), []);
    });
  }

  it('has the checker report a read emptied only at its tenant-scoped reference', () => {
    // The shape a rewrite that emptied each reference alone would produce.
    const statement = select(table('st_authors', 'a'), {
      where: exists(select(table('st_posts', 'p'), { columns: ids, where: ir.FALSE }), true),
    });
    assert.deepEqual(
      findUnscopedReferences(statement, catalog(), NONE).map((gap) => [gap.qualifier, gap.gap]),
      [['p', 'missing_condition']],
    );
    const write = update(
      'st_tags',
      [{ column: 'name', value: 'x' }],
      inSelect(
        'id',
        select('st_post_tags', { columns: [{ column: 'tag_id' }], where: ir.FALSE }),
        true,
      ),
    );
    assert.equal(findUnscopedReferences(write, catalog(), NONE).length, 1);
    const emptied = update('st_posts', [{ column: 'views', add: 1 }], ir.FALSE);
    assert.deepEqual(findUnscopedReferences(emptied, catalog(), NONE), []);
  });

  it('leaves a read of global tables alone', () => {
    const compiled = compileGuarded(catalog(), select('st_tags'), NONE);
    assert.equal(compiled.sql, 'SELECT * FROM "st_tags"');
  });

  for (const position of POSITIONS.filter((candidate) => candidate.statement.kind !== 'select')) {
    it(`refuses ${position.name}`, () => {
      assert.throws(
        () => compileGuarded(catalog(), position.statement, NONE),
        (error: unknown) => TenantScopeErrors.is(error, 'no_tenant'),
      );
    });
  }

  it('refuses an insert', () => {
    assert.throws(
      () => compileGuarded(catalog(), insert('st_comments', ['body'], [['x']]), NONE),
      (error: unknown) => TenantScopeErrors.is(error, 'no_tenant'),
    );
  });

  it('reads the ambient scope: runWithTenant scopes, nothing outside it reads anything', () => {
    const statement = select('st_posts');
    assert.match(compileGuarded(catalog(), statement).sql, /WHERE 1 = 0$/);
    const inside = runWithTenant(TENANT, () => compileGuarded(catalog(), statement));
    assert.deepEqual(inside.params, [TENANT]);
  });
});

describe('the tenant policy refuses what could reach another tenant', () => {
  it('an insert row naming another tenant', () => {
    assert.throws(
      () =>
        compileGuarded(
          catalog(),
          insert(
            'st_posts',
            ['title', 'tenant_id'],
            [
              ['a', 7],
              ['b', 8],
            ],
          ),
          SCOPED,
        ),
      (error: unknown) => TenantScopeErrors.is(error, 'tenant_mismatch'),
    );
  });

  it('a write naming the tenant column twice, whichever occurrence differs', () => {
    const twice = insert('st_posts', ['tenant_id', 'title', 'tenant_id'], [[7, 'a', 8]]);
    assert.throws(
      () => applyPolicies(twice, { tables: catalog(), scope: SCOPED }),
      (error: unknown) => TenantScopeErrors.is(error, 'tenant_mismatch'),
    );
    assert.deepEqual(
      findUnscopedReferences(twice, catalog(), SCOPED).map((gap) => gap.gap),
      ['unstamped_row'],
    );
    const moved = update(
      'st_posts',
      [
        { column: 'tenant_id', value: 7 },
        { column: 'tenant_id', value: 8 },
      ],
      ir.TRUE,
    );
    assert.throws(
      () => applyPolicies(moved, { tables: catalog(), scope: SCOPED }),
      (error: unknown) => TenantScopeErrors.is(error, 'tenant_assignment'),
    );
    const scopedMove = Object.freeze({
      ...moved,
      where: eq(col('st_posts', 'tenant_id'), TENANT),
    }) satisfies Statement;
    assert.deepEqual(
      findUnscopedReferences(scopedMove, catalog(), SCOPED).map((gap) => gap.gap),
      ['tenant_assignment'],
    );
    // Even naming the current tenant twice is refused, by the renderer.
    for (const dialect of DIALECTS) {
      assert.throws(
        () =>
          compileGuarded(
            catalog(dialect),
            insert('st_posts', ['tenant_id', 'title', 'tenant_id'], [[7, 'a', 7]]),
            SCOPED,
          ),
        (error: unknown) => (error as { code?: string }).code === 'invalid_statement',
      );
    }
  });

  it('an update moving rows to another tenant, or incrementing the tenant', () => {
    for (const set of [
      [{ column: 'tenant_id', value: 8 }],
      [{ column: 'tenant_id', add: 1 }],
      [
        {
          column: 'tenant_id',
          select: select('st_comments', { columns: [{ column: 'tenant_id' }] }),
        },
      ],
    ] as const) {
      assert.throws(
        () => compileGuarded(catalog(), update('st_posts', set, ir.TRUE), SCOPED),
        (error: unknown) => TenantScopeErrors.is(error, 'tenant_assignment'),
      );
    }
    const same = compileGuarded(
      catalog(),
      update('st_posts', [{ column: 'tenant_id', value: 7 }], ir.TRUE),
      SCOPED,
    );
    assert.equal(
      same.sql,
      'UPDATE "st_posts" SET "tenant_id" = ? WHERE "st_posts"."tenant_id" = ?',
    );
  });

  it('an upsert whose conflict target lacks the tenant column', () => {
    for (const action of ['update', 'nothing'] as const) {
      const onConflict =
        action === 'update'
          ? { target: ['slug'], action, update: ['title'] }
          : { target: ['slug'], action };
      assert.throws(
        () =>
          compileGuarded(
            catalog(),
            insert('st_posts', ['title', 'slug'], [['a', 'b']], { onConflict }),
            SCOPED,
          ),
        (error: unknown) => TenantScopeErrors.is(error, 'upsert_without_tenant'),
      );
    }
  });

  it('an upsert that updates the tenant column', () => {
    assert.throws(
      () =>
        compileGuarded(
          catalog(),
          insert('st_posts', ['title', 'slug'], [['a', 'b']], {
            onConflict: {
              target: ['tenant_id', 'slug'],
              action: 'update',
              update: ['title', 'tenant_id'],
            },
          }),
          SCOPED,
        ),
      (error: unknown) => TenantScopeErrors.is(error, 'tenant_assignment'),
    );
  });

  it('a tenant id the tenant column cannot store', () => {
    for (const tenantId of ['seven', 1.5, 2 ** 40]) {
      assert.throws(
        () => compileGuarded(catalog(), select('st_posts'), { tenantId, unscoped: false }),
        (error: unknown) => TenantScopeErrors.is(error, 'invalid_tenant'),
      );
    }
    assert.deepEqual(
      compileGuarded(catalog(), select('st_posts'), { tenantId: '12', unscoped: false }).params,
      [12],
      'a numeric string is the same tenant as its number',
    );
    assert.deepEqual(
      compileGuarded(catalog(), select('st_notes'), { tenantId: 12, unscoped: false }).params,
      ['12'],
    );
  });

  it('runWithTenant refuses an empty or non-finite id', () => {
    for (const tenantId of ['', Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => runWithTenant(tenantId, () => undefined),
        (error: unknown) => TenantScopeErrors.is(error, 'invalid_tenant_id'),
      );
    }
  });
});

describe('the closed table list and the opt-out', () => {
  it('refuses a table no model declares, scoped or not', () => {
    for (const scope of [SCOPED, NONE, UNSCOPED]) {
      assert.throws(
        () =>
          compileGuarded(
            catalog(),
            select('st_tags', { where: exists(select('st_secrets', { columns: ids })) }),
            scope,
          ),
        (error: unknown) => StatementErrors.is(error, 'unknown_table'),
      );
    }
    // A name no identifier could be keeps the code and is not echoed.
    for (const name of ['st posts', 'x'.repeat(200)]) {
      assert.throws(
        () => compileGuarded(catalog(), select(name), SCOPED),
        (error: unknown) =>
          StatementErrors.is(error, 'unknown_table') && error.context.table !== name,
      );
    }
  });

  it('withoutTenantScope leaves the statement as written and marks its ledger origin', () => {
    const statement = select('st_posts');
    const compiled = withoutTenantScope(() => compileGuarded(catalog(), statement));
    assert.equal(compiled.sql, 'SELECT * FROM "st_posts"');
    assert.equal(compiled.origin, TENANT_UNSCOPED_ORIGIN);
    assert.deepEqual(findUnscopedReferences(statement, catalog(), UNSCOPED), []);
    const global = withoutTenantScope(() => compileGuarded(catalog(), select('st_tags')));
    assert.equal(global.origin, undefined, 'a global table needs no opt-out');
    const back = withoutTenantScope(() =>
      runWithTenant(TENANT, () => compileGuarded(catalog(), statement)),
    );
    assert.deepEqual(back.params, [TENANT], 'runWithTenant switches the scope back on');
  });

  it('is pure: the input stays as it was and the output is frozen', () => {
    const statement = {
      kind: 'select',
      from: { table: 'st_posts' },
      columns: '*',
      where: { op: 'compare', column: 'slug', comparison: '=', value: 'a' },
    } as const satisfies Statement;
    const before = JSON.stringify(statement);
    const guarded = applyPolicies(statement, { tables: catalog(), scope: SCOPED });
    assert.equal(JSON.stringify(statement), before);
    assert.equal(Object.isFrozen(statement), false, 'the caller keeps an unfrozen input');
    assert.ok(Object.isFrozen(guarded));
    assert.notEqual(guarded, statement);
  });
});
