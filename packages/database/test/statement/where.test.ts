/**
 * The predicate compiler: `Where<T>` and `Q` lowered to the IR with values
 * encoded by their columns' codecs; the build-time refusals of predicates a
 * codec cannot answer; ordering; the encoding of SET maps and insert rows;
 * and, through `@ts-expect-error`, the types that reject unknown columns,
 * wrong value types and text operators on non-text columns.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileStatement, type SqlValue } from '../../src/engine/index.js';
import { ColumnValueError, column, defineTable, type PortableType } from '../../src/model/index.js';
import {
  chainCodecs,
  compileOrder,
  compileWhere,
  encodeAssignments,
  encodeInsertRows,
  ir,
  modelCodecs,
  modelColumns,
  Q,
  StatementErrors,
  type CodecLayer,
  type Where,
  type WhereInput,
} from '../../src/index.js';
import { Post } from './fixtures/tenant-models.js';

const posts = modelCodecs(Post, 'sqlite');

function sql(where: WhereInput<Post>): { sql: string; params: readonly unknown[] } {
  const compiled = compileStatement(
    ir.select('st_posts', { where: compileWhere(posts, where) }),
    'sqlite',
  );
  return {
    sql: compiled.sql.replace('SELECT * FROM "st_posts" WHERE ', ''),
    params: compiled.params,
  };
}

describe('compileWhere', () => {
  it('lowers values, null, arrays and operators, ANDing properties', () => {
    assert.deepEqual(sql({ slug: 'a', authorId: null }), {
      sql: '("slug" = ?) AND ("author_id" IS NULL)',
      params: ['a'],
    });
    assert.deepEqual(sql({ views: [1, 2, 3] }), { sql: '"views" IN (?, ?, ?)', params: [1, 2, 3] });
    assert.deepEqual(sql({ views: { gte: 10, lt: 20 }, title: { like: 'A%' } }), {
      sql: `("views" >= ?) AND ("views" < ?) AND ("title" LIKE ? ESCAPE '\\')`,
      params: [10, 20, 'A%'],
    });
    assert.deepEqual(sql({ views: { ne: 3, notIn: [4] }, publishedAt: { isNull: false } }), {
      sql: '("views" <> ?) AND ("views" NOT IN (?)) AND ("published_at" IS NOT NULL)',
      params: [3, 4],
    });
    assert.deepEqual(sql({}), { sql: '1 = 1', params: [] });
    assert.deepEqual(sql({ views: [] }), { sql: '1 = 0', params: [] });
  });

  it('encodes each value through its column codec', () => {
    const at = new Date('2026-01-02T03:04:05.006Z');
    assert.deepEqual(sql({ publishedAt: { gt: at } }).params, ['2026-01-02T03:04:05.006Z']);
    const mariadb = compileWhere(modelCodecs(Post, 'mariadb'), { publishedAt: at });
    assert.deepEqual(mariadb, {
      op: 'compare',
      column: 'published_at',
      comparison: '=',
      value: '2026-01-02 03:04:05.006',
    });
    assert.throws(
      () => compileWhere(posts, { status: 'archived' } as unknown as Where<Post>),
      (error: unknown) => error instanceof ColumnValueError && error.code === 'invalid_value',
      'an enum refuses a value outside it, in a lookup too',
    );
    assert.throws(
      () => compileWhere(posts, { views: 2 ** 40 }),
      (error: unknown) => error instanceof ColumnValueError && error.code === 'out_of_range',
    );
  });

  it('combines with Q.and, Q.or and Q.not, and qualifies columns when asked', () => {
    const predicate = compileWhere(
      posts,
      Q.or({ slug: 'a' }, Q.and({ views: { gt: 1 } }, Q.not({ status: 'draft' }))),
      'p',
    );
    const compiled = compileStatement(
      ir.select(ir.table('st_posts', 'p'), { where: predicate }),
      'sqlite',
    );
    assert.equal(
      compiled.sql,
      'SELECT * FROM "st_posts" AS "p" WHERE ("p"."slug" = ?) OR (("p"."views" > ?) AND (NOT ("p"."status" = ?)))',
    );
    assert.deepEqual(compiled.params, ['a', 1, 'draft']);
  });

  it('refuses at build time what a codec cannot answer', () => {
    const refused = (where: unknown, operator: string) =>
      assert.throws(
        () => compileWhere(posts, where as Where<Post>),
        (error: unknown) => {
          assert.ok(StatementErrors.is(error, 'unsupported_predicate'), String(error));
          assert.equal(error.context.operator, operator);
          return true;
        },
      );
    refused({ preferences: { theme: 'dark', size: 1 } }, 'eq');
    refused({ preferences: { in: [{ theme: 'dark' }] } }, 'in');
    refused({ views: { like: '1%' } }, 'like');
    assert.deepEqual(
      compileWhere(posts, { preferences: null }),
      { op: 'null', column: 'preferences' },
      'a null test applies to every column',
    );
  });

  it('holds equality-only columns to equality and fans a lookup out to every stored form', () => {
    const deterministic: CodecLayer<SqlValue, Uint8Array> = {
      queryable: 'equality',
      encode: (value) => new TextEncoder().encode(`k2:${String(value)}`),
      decode: (value) => new TextDecoder().decode(value).slice(3),
      encodeForLookup: (value) =>
        ['k2', 'k1'].map((key) => new TextEncoder().encode(`${key}:${String(value)}`)),
    };
    const Secret = defineTable({
      table: 'st_secrets',
      columns: {
        email: column.string(100, { encrypted: { mode: 'deterministic' } }),
        note: column.text({ nullable: true, encrypted: { mode: 'random' } }),
      },
    });
    const codecs = modelCodecs(Secret, 'sqlite', {
      seal: (target) => (target.encryption.mode === 'random' ? random : deterministic),
    });
    const lookup = compileWhere(codecs, { email: 'a@b.c' });
    assert.equal(lookup.op, 'in');
    assert.equal(lookup.op === 'in' ? lookup.values.length : 0, 2);
    const ne = compileWhere(codecs, { email: { ne: 'a@b.c' } });
    assert.ok(ne.op === 'in' && ne.negate === true);
    for (const [where, operator] of [
      [{ email: { gt: 'a' } }, 'gt'],
      [{ note: 'x' }, 'eq'],
    ] as const) {
      assert.throws(
        () => compileWhere(codecs, where as never),
        (error: unknown) =>
          StatementErrors.is(error, 'unsupported_predicate') && error.context.operator === operator,
      );
    }
    assert.throws(
      () => compileOrder(codecs, 'email' as never),
      (error: unknown) => StatementErrors.is(error, 'unsupported_predicate'),
    );
  });

  it('refuses unknown columns and malformed conditions', () => {
    assert.throws(
      () => compileWhere(posts, { nope: 1 } as unknown as Where<Post>),
      (error: unknown) => StatementErrors.is(error, 'unknown_column'),
    );
    for (const where of [
      { views: {} },
      { views: { between: [1, 2] } },
      { views: { eq: null } },
      { views: [1, null] },
      { publishedAt: { isNull: 'yes' } },
      { title: { like: 3 } },
    ]) {
      assert.throws(
        () => compileWhere(posts, where as unknown as Where<Post>),
        (error: unknown) => StatementErrors.is(error, 'invalid_where'),
        JSON.stringify(where),
      );
    }
    assert.throws(
      () => compileWhere(posts, 'slug' as unknown as Where<Post>),
      (error: unknown) => StatementErrors.is(error, 'invalid_where'),
    );
  });

  it('refuses a property or operator whose value is undefined instead of dropping it', () => {
    // A value missing from a request must not widen the predicate: dropped,
    // `{ id: undefined }` would match every row, and `lt: undefined` would
    // open the range.
    const missing: string | undefined = undefined;
    const maybe: number | undefined = undefined;
    for (const where of [
      { id: maybe },
      { slug: missing, title: missing },
      { slug: 'a', title: missing },
      { views: { gte: 10, lt: maybe } },
      { views: { eq: maybe } },
      Q.or<Post>({ slug: 'a' }, { slug: missing }),
      Q.not<Post>({ id: maybe }),
    ] satisfies WhereInput<Post>[]) {
      assert.throws(
        () => compileWhere(posts, where),
        (error: unknown) =>
          StatementErrors.is(error, 'invalid_where') && error.context.model === 'Post',
        JSON.stringify(where),
      );
    }
    assert.throws(
      () => compileWhere(posts, { nope: undefined } as unknown as Where<Post>),
      (error: unknown) => StatementErrors.is(error, 'unknown_column'),
      'an unknown property is unknown whatever its value',
    );
  });

  it('reports a key that is no identifier as an unknown column, without echoing it', () => {
    const keys = ['no pe', 'title desc', "x' OR 1=1", '$where', '', 'x'.repeat(200)];
    for (const key of keys) {
      for (const run of [
        () => compileWhere(posts, { [key]: 1 }),
        () => compileOrder(posts, key as never),
        () => encodeAssignments(posts, { [key]: 1 } as never),
        () => encodeInsertRows(posts, [{ [key]: 1 }] as never),
      ]) {
        assert.throws(
          run,
          (error: unknown) => {
            assert.ok(StatementErrors.is(error, 'unknown_column'), JSON.stringify(key));
            if (key !== '') assert.ok(!error.message.includes(key));
            assert.notEqual(error.context.field, key);
            return true;
          },
          JSON.stringify(key),
        );
      }
    }
    assert.throws(
      () => compileWhere(posts, { nope: 1 } as unknown as Where<Post>),
      (error: unknown) =>
        StatementErrors.is(error, 'unknown_column') && error.context.field === 'nope',
      'an identifier-shaped key is named',
    );
  });
});

const random: CodecLayer<SqlValue, Uint8Array> = {
  queryable: 'none',
  encode: (value) => new TextEncoder().encode(String(value)),
  decode: (value) => new TextDecoder().decode(value),
};

describe('compileOrder and modelColumns', () => {
  it('orders by ordered columns only', () => {
    assert.deepEqual(compileOrder<Post>(posts, ['views', { column: 'id', direction: 'desc' }]), [
      { column: 'views' },
      { column: 'id', direction: 'desc' },
    ]);
    assert.deepEqual(compileOrder<Post>(posts, { column: 'publishedAt', nulls: 'last' }, 'p'), [
      { column: { table: 'p', column: 'published_at' }, nulls: 'last' },
    ]);
    assert.throws(
      () => compileOrder<Post>(posts, 'preferences'),
      (error: unknown) =>
        StatementErrors.is(error, 'unsupported_predicate') && error.context.operator === 'orderBy',
    );
  });

  it('lists every column by its physical name', () => {
    assert.deepEqual(
      modelColumns(posts).map((output) => ('column' in output ? output.column : undefined)),
      posts.columns.map((entry) => entry.column),
    );
    assert.deepEqual(modelColumns(posts, 'p')[1], {
      column: { table: 'p', column: 'title' },
      as: 'title',
    });
  });
});

describe('encodeAssignments and encodeInsertRows', () => {
  it('maps properties to columns and encodes every value', () => {
    assert.deepEqual(
      encodeAssignments<Post>(posts, {
        status: 'live',
        preferences: { theme: 'dark' } as Post['preferences'],
        authorId: null,
        title: undefined,
      }),
      [
        { column: 'status', value: 'live' },
        { column: 'preferences', value: '{"theme":"dark","size":12}' },
        { column: 'author_id', value: null },
      ],
    );
    assert.deepEqual(
      encodeInsertRows<Post>(posts, [
        { title: 'a', slug: 'x' },
        { slug: 'y', title: 'b' },
      ]),
      {
        columns: ['title', 'slug'],
        rows: [
          ['a', 'x'],
          ['b', 'y'],
        ],
      },
    );
  });

  it('refuses empty, unknown, mismatched and invalid values', () => {
    assert.throws(
      () => encodeAssignments<Post>(posts, {}),
      (error: unknown) => StatementErrors.is(error, 'invalid_values'),
    );
    assert.throws(
      () => encodeAssignments(posts, { nope: 1 } as never),
      (error: unknown) => StatementErrors.is(error, 'unknown_column'),
    );
    assert.throws(
      () => encodeInsertRows<Post>(posts, [{ title: 'a' }, { slug: 'b' }]),
      (error: unknown) => StatementErrors.is(error, 'invalid_values'),
    );
    assert.throws(
      () => encodeInsertRows<Post>(posts, []),
      (error: unknown) => StatementErrors.is(error, 'invalid_values'),
    );
    assert.throws(
      () => encodeAssignments<Post>(posts, { title: null as never }),
      (error: unknown) => error instanceof ColumnValueError && error.code === 'invalid_value',
      'null in a non-null column',
    );
    assert.throws(
      () => encodeAssignments<Post>(posts, { preferences: { theme: 'blue' } as never }),
      (error: unknown) => error instanceof ColumnValueError && error.field === 'preferences',
      'the data contract refuses the value',
    );
  });
});

describe('Where<T> types', () => {
  it('rejects unknown columns, wrong value types and misplaced operators', () => {
    const typed: Where<Post>[] = [
      { title: 'a', views: { gte: 1 }, publishedAt: null, status: ['draft', 'live'] },
      { authorId: null, slug: { like: 'a%' } },
      // @ts-expect-error -- not a column of Post
      { nope: 1 },
      // @ts-expect-error -- views holds numbers
      { views: 'ten' },
      // @ts-expect-error -- like applies to text columns only
      { views: { like: '1%' } },
      // @ts-expect-error -- title is not nullable
      { title: null },
      // @ts-expect-error -- status is an enum of draft and live
      { status: 'archived' },
    ];
    const combined: WhereInput<Post> = Q.or({ title: 'a' }, Q.not({ views: { lt: 3 } }));
    // @ts-expect-error -- Q checks its items against the context's row type
    const wrong: WhereInput<Post> = Q.or({ title: 1 });
    assert.equal(typed.length, 7);
    assert.ok(combined !== wrong);
  });

  it('accepts the chain of a hand-built codec', () => {
    const type: PortableType = { kind: 'integer' };
    const doubled = chainCodecs(type, [
      { queryable: 'full', encode: (v) => (v as number) * 2, decode: (v) => (v as number) / 2 },
    ]);
    assert.equal(doubled.encode(4), 8);
    assert.equal(doubled.decode(8), 4);
  });
});
