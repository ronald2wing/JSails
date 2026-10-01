/**
 * `physicalTable` offline: every portable type's column per dialect, the
 * declared and automatic indexes, foreign keys and their actions, the
 * cross-model relation checks, and `unindexedColumns`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Dialect } from '../../src/engine/index.js';
import {
  column,
  defineModel,
  defineTable,
  ENCRYPTION_ENVELOPE_OVERHEAD,
  ModelSpecError,
  physicalTable,
  unindexedColumns,
  type ModelTarget,
} from '../../src/model/index.js';

const DIALECTS: readonly Dialect[] = ['postgres', 'mariadb', 'sqlite'];

function rejects(model: ModelTarget, code: string, field?: string): void {
  for (const dialect of DIALECTS) {
    assert.throws(
      () => physicalTable(model, dialect),
      (error: unknown) => {
        assert.ok(
          error instanceof ModelSpecError,
          `expected a ModelSpecError, got ${String(error)}`,
        );
        assert.equal(error.code, code);
        if (field !== undefined) assert.equal(error.field, field);
        return true;
      },
    );
  }
}

describe('physicalTable', () => {
  it('lowers every portable type to each dialect', () => {
    const everything = defineTable({
      table: 'everything',
      columns: {
        ref: column.id(),
        name: column.string(80),
        body: column.text(),
        count: column.integer({ default: 0 }),
        big: column.bigint(),
        price: column.decimal(12, 2),
        wide: column.decimal(30, 10),
        ratio: column.float(),
        done: column.boolean({ default: false }),
        at: column.timestamp({ default: { now: true } }),
        day: column.date(),
        clock: column.time(),
        doc: column.json({ nullable: true }),
        key: column.uuid(),
        blob: column.binary(),
        token: column.binary(32),
      },
    });
    const expected: Record<Dialect, string[]> = {
      postgres: [
        'id bigint identity',
        'ref bigint',
        'name character varying(80) C',
        'body text C',
        'count integer',
        'big bigint',
        'price numeric(12,2)',
        'wide numeric(30,10)',
        'ratio double precision',
        'done boolean',
        'at timestamp(3) with time zone',
        'day date',
        'clock time(3) without time zone',
        'doc jsonb null',
        'key uuid',
        'blob bytea',
        'token bytea',
      ],
      mariadb: [
        'id bigint identity',
        'ref bigint',
        'name varchar(80) utf8mb4_nopad_bin',
        'body longtext utf8mb4_nopad_bin',
        'count int',
        'big bigint',
        'price decimal(12,2)',
        'wide decimal(30,10)',
        'ratio double',
        'done tinyint(1)',
        'at datetime(3)',
        'day date',
        'clock time(3)',
        'doc longtext utf8mb4_bin null json',
        'key binary(16)',
        'blob longblob',
        'token varbinary(32)',
      ],
      sqlite: [
        'id integer identity',
        'ref integer',
        'name text',
        'body text',
        'count integer',
        'big integer',
        'price integer',
        'wide text',
        'ratio real',
        'done integer',
        'at text',
        'day text',
        'clock text',
        'doc text null',
        'key text',
        'blob blob',
        'token blob',
      ],
    };
    for (const dialect of DIALECTS) {
      const table = physicalTable(everything, dialect);
      assert.deepEqual(
        table.columns.map((c) =>
          [
            c.name,
            c.type,
            c.collation,
            c.nullable ? 'null' : undefined,
            c.check,
            c.identity ? 'identity' : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(' '),
        ),
        expected[dialect],
        dialect,
      );
      assert.deepEqual(table.primaryKey, ['id']);
      assert.ok(Object.isFrozen(table) && Object.isFrozen(table.columns));
    }
    const pgDefaults = physicalTable(everything, 'postgres').columns;
    assert.deepEqual(pgDefaults.find((c) => c.name === 'done')?.default, {
      kind: 'value',
      value: false,
    });
    assert.deepEqual(pgDefaults.find((c) => c.name === 'at')?.default, { kind: 'now' });
    const sqliteDone = physicalTable(everything, 'sqlite').columns.find((c) => c.name === 'done');
    assert.deepEqual(sqliteDone?.default, { kind: 'value', value: 0 });
  });

  it('stores an encrypted column as binary sized for its envelope', () => {
    const sealed = defineTable({
      table: 'sealed',
      columns: {
        email: column.string(100, { encrypted: { mode: 'deterministic' } }),
        notes: column.text({ encrypted: { mode: 'random' } }),
      },
    });
    const email = physicalTable(sealed, 'mariadb').columns.find((c) => c.name === 'email');
    assert.equal(email?.type, `varbinary(${400 + ENCRYPTION_ENVELOPE_OVERHEAD})`);
    assert.equal(email?.portable.kind, 'string');
    assert.equal(email?.encrypted?.mode, 'deterministic');
    assert.equal(
      physicalTable(sealed, 'mariadb').columns.find((c) => c.name === 'notes')?.type,
      'longblob',
    );
    assert.equal(
      physicalTable(sealed, 'postgres').columns.find((c) => c.name === 'email')?.type,
      'bytea',
    );
  });

  it('indexes foreign keys, polymorphic pairs and the tenant unless an index leads with them', () => {
    const tenants = defineTable({ table: 'tenants', columns: {} });
    const authors = defineTable({ table: 'authors', columns: {} });
    const posts = defineTable({
      table: 'posts',
      columns: { title: column.string(100) },
      relations: {
        tenant: { kind: 'belongsTo', target: () => tenants },
        author: { kind: 'belongsTo', target: () => authors, nullable: true },
        editor: { kind: 'belongsTo', target: () => authors, index: false, nullable: true },
        subject: { kind: 'belongsTo', polymorphic: true },
      },
      tenant: 'tenantId',
      indexes: [{ columns: ['authorId', 'title'] }],
    });
    for (const dialect of DIALECTS) {
      const table = physicalTable(posts, dialect);
      assert.deepEqual(
        table.indexes.map((index) => [index.name, index.columns.join(','), index.origin]),
        [
          ['posts_author_id_title_idx', 'author_id,title', 'declared'],
          ['posts_tenant_id_idx', 'tenant_id', 'tenant'],
          ['posts_subject_type_subject_id_idx', 'subject_type,subject_id', 'polymorphic'],
        ],
      );
      assert.equal(table.tenant, 'tenant_id');
      assert.deepEqual(
        table.foreignKeys.map((fk) => [
          fk.name,
          fk.columns[0],
          fk.referencedTable,
          fk.referencedColumns[0],
          fk.onDelete,
          fk.indexed,
        ]),
        [
          ['posts_tenant_id_fkey', 'tenant_id', 'tenants', 'id', 'restrict', true],
          ['posts_author_id_fkey', 'author_id', 'authors', 'id', 'restrict', true],
          ['posts_editor_id_fkey', 'editor_id', 'authors', 'id', 'restrict', false],
        ],
      );
      assert.deepEqual(unindexedColumns(table), ['editor_id']);
    }
  });

  it('counts a composite primary key as an index for its leading column', () => {
    const tags = defineTable({ table: 'tags', columns: {} });
    const items = defineTable({ table: 'items', columns: {} });
    const taggings = defineTable({
      table: 'taggings',
      primaryKey: ['itemId', 'tagId'],
      columns: { itemId: column.id(), tagId: column.id() },
      relations: {
        item: { kind: 'belongsTo', target: () => items, foreignKey: 'itemId', onDelete: 'cascade' },
        tag: { kind: 'belongsTo', target: () => tags, foreignKey: 'tagId', onDelete: 'cascade' },
      },
    });
    const table = physicalTable(taggings, 'postgres');
    assert.deepEqual(table.primaryKey, ['item_id', 'tag_id']);
    assert.deepEqual(
      table.indexes.map((index) => index.name),
      ['taggings_tag_id_idx'],
    );
    assert.ok(table.columns.every((c) => !c.identity));
    assert.deepEqual(unindexedColumns(table), []);
  });

  it('derives the foreign-key action from the inverse dependent', () => {
    class Parent {}
    class Destroyed {}
    class Nullified {}
    class Kept {}
    class Contradicting {}
    defineModel(Parent, {
      table: 'parents',
      columns: {},
      relations: {
        destroyed: {
          kind: 'hasOne',
          target: () => Destroyed,
          inverse: 'parent',
          dependent: 'destroy',
        },
        nullified: {
          kind: 'hasMany',
          target: () => Nullified,
          inverse: 'parent',
          dependent: 'nullify',
        },
        kept: { kind: 'hasMany', target: () => Kept, inverse: 'parent' },
        contradicting: {
          kind: 'hasMany',
          target: () => Contradicting,
          inverse: 'parent',
          dependent: 'destroy',
        },
      },
    });
    defineModel(Destroyed, {
      table: 'destroyed_children',
      columns: {},
      relations: { parent: { kind: 'belongsTo', target: () => Parent } },
    });
    defineModel(Nullified, {
      table: 'nullified_children',
      columns: {},
      relations: { parent: { kind: 'belongsTo', target: () => Parent, nullable: true } },
    });
    defineModel(Kept, {
      table: 'kept_children',
      columns: {},
      relations: { parent: { kind: 'belongsTo', target: () => Parent } },
    });
    // The pipeline relies on the action when a child's plan is empty, so an
    // explicit action that disagrees with the inverse's dependent is refused.
    defineModel(Contradicting, {
      table: 'contradicting_children',
      columns: {},
      relations: { parent: { kind: 'belongsTo', target: () => Parent, onDelete: 'restrict' } },
    });
    const action = (model: ModelTarget) => physicalTable(model, 'sqlite').foreignKeys[0]?.onDelete;
    assert.equal(action(Destroyed), 'cascade');
    assert.equal(action(Nullified), 'set null');
    assert.equal(action(Kept), 'restrict');
    rejects(Contradicting, 'invalid_relation', 'relations.parent');
    physicalTable(Parent, 'sqlite');
  });

  it('checks relations against their targets', () => {
    const coded = defineTable({
      table: 'coded',
      primaryKey: 'code',
      columns: { code: column.string(10) },
    });
    rejects(
      defineTable({
        table: 'bad_fk',
        columns: {},
        relations: { owner: { kind: 'belongsTo', target: () => coded } },
      }),
      'invalid_relation',
      'relations.owner.foreignKey',
    );
    defineTable({
      table: 'good_fk',
      columns: { ownerCode: column.string(10) },
      relations: { owner: { kind: 'belongsTo', target: () => coded, foreignKey: 'ownerCode' } },
    });
    rejects(
      defineTable({
        table: 'unresolved',
        columns: {},
        relations: { owner: { kind: 'belongsTo', target: () => ({}) } },
      }),
      'unresolved_relation',
      'relations.owner',
    );
    rejects(
      defineTable({
        table: 'throwing',
        columns: {},
        relations: {
          owner: {
            kind: 'belongsTo',
            target: () => {
              throw new Error('still loading');
            },
          },
        },
      }),
      'unresolved_relation',
    );
    const counted = defineTable({
      table: 'counted',
      columns: { total: column.integer(), label: column.text() },
    });
    rejects(
      defineTable({
        table: 'counter_bad',
        columns: {},
        relations: { owner: { kind: 'belongsTo', target: () => counted, counterCache: 'label' } },
      }),
      'invalid_relation',
      'relations.owner.counterCache',
    );
    rejects(
      defineTable({
        table: 'touch_bad',
        columns: {},
        relations: { owner: { kind: 'belongsTo', target: () => counted, touch: 'total' } },
      }),
      'invalid_relation',
      'relations.owner.touch',
    );
    physicalTable(
      defineTable({
        table: 'counter_ok',
        columns: {},
        relations: { owner: { kind: 'belongsTo', target: () => counted, counterCache: 'total' } },
      }),
      'postgres',
    );

    class Lonely {}
    defineModel(Lonely, { table: 'lonely', columns: {} });
    rejects(
      defineTable({
        table: 'no_inverse',
        columns: {},
        relations: { kids: { kind: 'hasMany', target: () => Lonely, inverse: 'parent' } },
      }),
      'invalid_relation',
      'relations.kids.inverse',
    );
    class Strict {}
    class StrictChild {}
    defineModel(Strict, {
      table: 'strict_parents',
      columns: {},
      relations: {
        kids: {
          kind: 'hasMany',
          target: () => StrictChild,
          inverse: 'parent',
          dependent: 'nullify',
        },
      },
    });
    defineModel(StrictChild, {
      table: 'strict_children',
      columns: {},
      relations: { parent: { kind: 'belongsTo', target: () => Strict } },
    });
    rejects(Strict, 'invalid_relation', 'relations.kids.dependent');
    rejects(StrictChild, 'invalid_relation', 'relations.parent');
  });

  it('checks a through relation reaches its target', () => {
    class Article {}
    class Tag {}
    class Tagging {}
    defineModel(Tag, { table: 'th_tags', columns: {} });
    defineModel(Tagging, {
      table: 'th_taggings',
      columns: {},
      relations: {
        article: { kind: 'belongsTo', target: () => Article },
        tag: { kind: 'belongsTo', target: () => Tag },
      },
    });
    defineModel(Article, {
      table: 'th_articles',
      columns: {},
      relations: {
        taggings: { kind: 'hasMany', target: () => Tagging, inverse: 'article' },
        tags: { kind: 'hasMany', target: () => Tag, through: 'taggings', source: 'tag' },
        wrong: { kind: 'hasMany', target: () => Tag, through: 'taggings', source: 'article' },
      },
    });
    rejects(Article, 'invalid_relation', 'relations.wrong.source');
  });

  it('accepts a polymorphic inverse', () => {
    class Comment {}
    class Photo {}
    defineModel(Comment, {
      table: 'pm_comments',
      columns: {},
      relations: { subject: { kind: 'belongsTo', polymorphic: true } },
    });
    defineModel(Photo, {
      table: 'pm_photos',
      columns: {},
      relations: { comments: { kind: 'hasMany', target: () => Comment, inverse: 'subject' } },
    });
    assert.equal(physicalTable(Photo, 'mariadb').name, 'pm_photos');
    assert.deepEqual(physicalTable(Comment, 'mariadb').foreignKeys, []);
  });
});
