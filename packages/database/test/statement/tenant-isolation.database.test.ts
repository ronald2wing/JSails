/**
 * The tenant policy against a real database, on the run's driver (SQLite in
 * the default suite, MariaDB and PostgreSQL in the database suite's legs).
 * Two tenants hold the same rows: posts with the same slugs, their comments
 * and tag links. Every statement goes through the guarded compile, with
 * tenant 1 current, and must return or change no row of tenant 2. That holds
 * for selects, update-all, delete-all and upserts (including MariaDB's
 * conflict on a key outside the stated target, which takes the update path),
 * and for the relation loader's shapes when they are handed both tenants'
 * keys: has-many and belongs-to `IN` lists, the through join over the link
 * table, the per-parent window limit, `EXISTS` and an `IN` subquery. With no
 * tenant, reads come back empty (`NOT EXISTS`, `NOT IN` and left-joined reads
 * of a tenant table included) and writes throw before anything reaches the
 * database. The opt-out sees both tenants under its own ledger origin.
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  createEngine,
  createQueryLedger,
  type Engine,
  type QueryResult,
  type Row,
  type Statement,
  withQueryLedger,
} from '../../src/engine/index.js';
import {
  compileWhere,
  createStatementCatalog,
  encodeInsertRows,
  executeStatement,
  hydrate,
  ir,
  runWithoutTenant,
  runWithTenant,
  TENANT_UNSCOPED_ORIGIN,
  TenantScopeErrors,
  withoutTenantScope,
  type StatementCatalog,
  type Values,
} from '../../src/index.js';
import type { ModelTarget } from '../../src/model/index.js';
import { pushSchema } from '../../src/schema/index.js';
import { forEachDriver, lastInFirstOut } from '../../src/testing/index.js';
import { matrixEngineConfig } from '../conformance/engine/fixtures/matrix-engine.js';
import { Author, Comment, MODELS, Note, Post, PostTag, Tag } from './fixtures/tenant-models.js';

const { and, col, compareColumns, deleteFrom, eq, exists, inList, inSelect, insert, join } = ir;
const { select, table, update } = ir;

const SLUGS = ['one', 'two', 'three'] as const;
const COMMENTS_PER_POST = 3;

interface TenantRows {
  readonly posts: readonly number[];
  readonly comments: readonly number[];
}

interface Fixture {
  readonly engine: Engine;
  readonly catalog: StatementCatalog;
  readonly tenants: Readonly<Record<1 | 2, TenantRows>>;
  /** Both tenants' post keys: what a loader is handed for parents of either. */
  readonly allPosts: readonly number[];
  readonly authors: { readonly first: number; readonly second: number };
  run(statement: Statement): Promise<QueryResult>;
  rows<T extends object>(model: ModelTarget, statement: Statement): Promise<T[]>;
  insertRows<T>(model: ModelTarget, rows: readonly Values<T>[]): Promise<number[]>;
}

function key(row: Row, column = 'id'): number {
  return Number(row[column]);
}

async function fixture(t: Parameters<typeof matrixEngineConfig>[0]): Promise<Fixture> {
  const ordered = lastInFirstOut(t);
  const config = await matrixEngineConfig(ordered);
  await pushSchema({ config, models: MODELS }, { environment: 'development' });
  const engine = await createEngine(config);
  ordered.after(() => engine.close());
  const catalog = createStatementCatalog({ dialect: engine.dialect, models: MODELS });

  const run = async (statement: Statement): Promise<QueryResult> => {
    const conn = await engine.lease();
    try {
      return await executeStatement(conn, catalog, statement);
    } finally {
      await conn.release();
    }
  };
  const rows = async <T extends object>(model: ModelTarget, statement: Statement) =>
    (await run(statement)).rows.map((row) => hydrate<T>(catalog.codecs(model), row));
  const insertRows = async <T>(model: ModelTarget, values: readonly Values<T>[]) => {
    const codecs = catalog.codecs(model);
    const encoded = encodeInsertRows(codecs, values);
    const result = await run(
      insert(codecs.spec.table, encoded.columns, encoded.rows, { returning: ['id'] }),
    );
    return result.rows.map((row) => key(row));
  };

  const [first, second] = (await insertRows<Author>(Author, [
    { name: 'first' },
    { name: 'second' },
  ])) as [number, number];
  const [red, blue] = (await insertRows(Tag, [{ name: 'red' }, { name: 'blue' }])) as [
    number,
    number,
  ];

  const seed = (tenant: 1 | 2): Promise<TenantRows> =>
    runWithTenant(tenant, async () => {
      // The tenant column is left out on purpose: the policy stamps it.
      const posts = await insertRows<Post>(
        Post,
        SLUGS.map((slug) => ({
          title: `${slug} of ${tenant}`,
          slug,
          authorId: tenant === 1 ? first : second,
        })),
      );
      const comments = await insertRows<Comment>(
        Comment,
        posts.flatMap((postId) =>
          Array.from({ length: COMMENTS_PER_POST }, (_, index) => ({
            body: `comment ${index}`,
            postId,
          })),
        ),
      );
      // Tenant 1 tags every post red and its first post blue; tenant 2 uses red only.
      const links = posts.map((postId) => ({ postId, tagId: red }));
      if (tenant === 1) links.push({ postId: posts[0] as number, tagId: blue });
      await insertRows(PostTag, links);
      await insertRows(Note, [{ text: `note of ${tenant}` }]);
      return { posts, comments };
    });
  const tenants = { 1: await seed(1), 2: await seed(2) };
  return {
    engine,
    catalog,
    tenants,
    allPosts: [...tenants[1].posts, ...tenants[2].posts],
    authors: { first, second },
    run,
    rows,
    insertRows,
  };
}

/** Every row of `model`'s table, across tenants, through the opt-out. */
function everyRow<T extends object>(f: Fixture, model: ModelTarget): Promise<T[]> {
  return withoutTenantScope(() =>
    f.rows<T>(model, select(f.catalog.codecs(model).spec.table, { orderBy: [{ column: 'id' }] })),
  );
}

/** The loader's shapes, each handed both tenants' keys. */
function loaderShapes(f: Fixture): Readonly<Record<string, Statement>> {
  return {
    'has-many': select('st_comments', { where: inList('post_id', f.allPosts) }),
    'belongs-to': select('st_posts', { where: inList('id', f.allPosts) }),
    through: select(table('st_tags', 't'), {
      columns: [
        { column: col('t', 'id'), as: 'id' },
        { column: col('t', 'name'), as: 'name' },
        { column: col('pt', 'post_id'), as: 'post_id' },
      ],
      joins: [
        join(table('st_post_tags', 'pt'), compareColumns(col('pt', 'tag_id'), '=', col('t', 'id'))),
      ],
      where: inList(col('pt', 'post_id'), f.allPosts),
    }),
    'window limit': select(table('st_comments', 'c'), {
      columns: [
        { column: col('c', 'id'), as: 'id' },
        { column: col('c', 'post_id'), as: 'post_id' },
        { column: col('c', 'tenant_id'), as: 'tenant_id' },
      ],
      where: inList(col('c', 'post_id'), f.allPosts),
      orderBy: [{ column: col('c', 'id'), direction: 'desc' }],
      windowLimit: { partitionBy: [col('c', 'post_id')], limit: 2 },
    }),
    exists: select(table('st_authors', 'a'), {
      where: exists(
        select(table('st_posts', 'p'), {
          columns: [{ column: col('p', 'id') }],
          where: compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
        }),
      ),
    }),
    'in subquery': select('st_tags', {
      where: inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] })),
      orderBy: [{ column: 'id' }],
    }),
  };
}

forEachDriver('tenant isolation on the database', () => {
  it('reads only the current tenant, for selects and every loader shape', async (t) => {
    const f = await fixture(t);
    const own = new Set(f.tenants[1].posts);
    await runWithTenant(1, async () => {
      const posts = await f.rows<Post>(Post, select('st_posts'));
      assert.deepEqual(posts.map((post) => post.tenantId).sort(), [1, 1, 1]);
      const bySlug = await f.rows<Post>(
        Post,
        select('st_posts', { where: compileWhere(f.catalog.codecs(Post), { slug: 'one' }) }),
      );
      assert.deepEqual(
        bySlug.map((post) => [post.tenantId, post.title]),
        [[1, 'one of 1']],
        'a slug both tenants use matches the current tenant only',
      );
      const notes = await f.rows<{ org: string }>(Note, select('st_notes'));
      assert.deepEqual(
        notes.map((note) => note.org),
        ['1'],
        'a string tenant column scopes the same way',
      );

      const shapes = loaderShapes(f);
      const read = async (name: string) => (await f.run(shapes[name] as Statement)).rows;

      const children = await read('has-many');
      assert.equal(children.length, 3 * COMMENTS_PER_POST);
      assert.ok(
        children.every((row) => key(row, 'tenant_id') === 1 && own.has(key(row, 'post_id'))),
      );

      const parents = await read('belongs-to');
      assert.deepEqual(parents.map((row) => key(row)).sort(), [...f.tenants[1].posts].sort());

      const through = await read('through');
      assert.equal(through.length, 4, 'three red links and one blue, all of tenant 1');
      assert.ok(through.every((row) => own.has(key(row, 'post_id'))));

      const windowed = await read('window limit');
      assert.equal(windowed.length, 3 * 2, 'two per parent, parents of tenant 1 only');
      assert.ok(windowed.every((row) => key(row, 'tenant_id') === 1));

      const authors = await read('exists');
      assert.deepEqual(
        authors.map((row) => key(row)),
        [f.authors.first],
      );

      const tags = await read('in subquery');
      assert.deepEqual(
        tags.map((row) => row.name),
        ['red', 'blue'],
      );
    });
    await runWithTenant(2, async () => {
      const tags = (await f.run(loaderShapes(f)['in subquery'] as Statement)).rows;
      assert.deepEqual(
        tags.map((row) => row.name),
        ['red'],
        'tenant 2 never sees the tag only tenant 1 links',
      );
    });
  });

  it('writes only the current tenant: update-all, delete-all and upserts', async (t) => {
    const f = await fixture(t);
    await runWithTenant(1, async () => {
      const bumped = await f.run(update('st_posts', [{ column: 'views', add: 1 }], ir.TRUE));
      assert.equal(bumped.affected, 3);

      const upserted = await f.run(
        insert('st_posts', ['title', 'slug'], [['one, again', 'one']], {
          onConflict: { target: ['tenant_id', 'slug'], action: 'update', update: ['title'] },
        }),
      );
      assert.ok(upserted.affected > 0);

      // A conflict on the primary key of tenant 2's row, outside the stated
      // target. MariaDB takes the update path for every unique key, where
      // the guard leaves the row alone; the other dialects refuse it.
      const victim = f.tenants[2].posts[0] as number;
      const hijack = insert('st_posts', ['id', 'title', 'slug'], [[victim, 'hijacked', 'new']], {
        onConflict: { target: ['tenant_id', 'slug'], action: 'update', update: ['title'] },
      });
      if (f.engine.dialect === 'mariadb') {
        await f.run(hijack);
      } else {
        await assert.rejects(f.run(hijack), { code: 'unique_violation' });
      }

      const removed = await f.run(deleteFrom('st_comments', ir.TRUE));
      assert.equal(removed.affected, 3 * COMMENTS_PER_POST);

      const unlinked = await f.run(
        deleteFrom(
          'st_post_tags',
          inSelect(
            'tag_id',
            select('st_tags', { columns: [{ column: 'id' }], where: eq('name', 'red') }),
          ),
        ),
      );
      assert.equal(unlinked.affected, 3, "tenant 1's red links only");
    });

    const posts = await everyRow<Post>(f, Post);
    assert.equal(posts.length, 6, 'no upsert inserted or lost a row');
    for (const post of posts) {
      if (post.tenantId === 2) {
        assert.equal(post.views, 0, 'tenant 2 was not bumped');
        assert.equal(post.title, `${post.slug} of 2`, 'tenant 2 was not upserted');
      } else {
        assert.equal(post.views, 1);
        assert.equal(post.title, post.slug === 'one' ? 'one, again' : `${post.slug} of 1`);
      }
    }
    const comments = await everyRow<Comment>(f, Comment);
    assert.deepEqual(
      comments.map((comment) => comment.tenantId),
      Array.from({ length: 3 * COMMENTS_PER_POST }, () => 2),
      "tenant 2's comments survived the delete-all",
    );
    const links = await everyRow<{ tenantId: number }>(f, PostTag);
    assert.deepEqual(links.map((link) => link.tenantId).sort(), [1, 2, 2, 2]);
  });

  it('with no tenant, reads come back empty and writes throw before reaching the database', async (t) => {
    const f = await fixture(t);
    await runWithoutTenant(async () => {
      for (const [name, statement] of Object.entries(loaderShapes(f))) {
        assert.deepEqual((await f.run(statement)).rows, [], `${name} reads nothing`);
      }
      // Negated and outer-joined reads of a tenant table: emptying only that
      // reference would answer "no posts", "never linked" or keep every
      // author, for rows of every tenant.
      const negated: Readonly<Record<string, Statement>> = {
        'not exists': select(table('st_authors', 'a'), {
          where: and(
            eq(col('a', 'id'), f.authors.first),
            exists(
              select(table('st_posts', 'p'), {
                columns: [{ column: col('p', 'id') }],
                where: compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
              }),
              true,
            ),
          ),
        }),
        'not in': select('st_tags', {
          where: inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] }), true),
        }),
        'left join': select(table('st_authors', 'a'), {
          joins: [
            join(
              table('st_posts', 'p'),
              compareColumns(col('p', 'author_id'), '=', col('a', 'id')),
              'left',
            ),
          ],
        }),
      };
      for (const [name, statement] of Object.entries(negated)) {
        assert.deepEqual((await f.run(statement)).rows, [], `${name} reads nothing`);
      }
      assert.deepEqual((await f.run(select('st_posts'))).rows, []);
      assert.equal(
        (await f.run(select('st_tags'))).rows.length,
        2,
        'a global table reads as usual',
      );

      const writes: readonly Statement[] = [
        update('st_posts', [{ column: 'views', add: 1 }], ir.TRUE),
        deleteFrom('st_comments', ir.TRUE),
        insert('st_comments', ['body', 'post_id'], [['x', f.tenants[1].posts[0] as number]]),
        insert('st_posts', ['title', 'slug'], [['x', 'one']], {
          onConflict: { target: ['tenant_id', 'slug'], action: 'update', update: ['title'] },
        }),
        // A write to a global table whose condition reads a tenant table.
        deleteFrom(
          'st_tags',
          inSelect('id', select('st_post_tags', { columns: [{ column: 'tag_id' }] }), true),
        ),
      ];
      const ledger = createQueryLedger({ detail: true });
      await withQueryLedger(ledger, async () => {
        for (const statement of writes) {
          await assert.rejects(f.run(statement), (error: unknown) =>
            TenantScopeErrors.is(error, 'no_tenant'),
          );
        }
      });
      assert.equal(ledger.count, 0, 'no refused write sent a statement');
    });

    const posts = await everyRow<Post>(f, Post);
    assert.deepEqual(
      posts.map((post) => [post.views, post.title]),
      [...f.tenants[1].posts, ...f.tenants[2].posts].map((_, index) => [
        0,
        `${SLUGS[index % 3] as string} of ${index < 3 ? 1 : 2}`,
      ]),
    );
    assert.equal((await everyRow(f, Comment)).length, 6 * COMMENTS_PER_POST);
    assert.equal((await everyRow(f, Tag)).length, 2);
  });

  it('withoutTenantScope reads every tenant, recorded under its own ledger origin', async (t) => {
    const f = await fixture(t);
    const ledger = createQueryLedger({ detail: true });
    const rows = await withQueryLedger(ledger, () =>
      runWithTenant(1, () =>
        withoutTenantScope(() =>
          f.rows<Post>(Post, select('st_posts', { where: and(inList('slug', ['one']), ir.TRUE) })),
        ),
      ),
    );
    assert.deepEqual(rows.map((post) => post.tenantId).sort(), [1, 2]);
    assert.deepEqual(
      ledger.records.map((record) => record.origin),
      [TENANT_UNSCOPED_ORIGIN],
    );
  });
});
