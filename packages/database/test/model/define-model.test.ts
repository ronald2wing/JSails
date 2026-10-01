/**
 * `defineModel`, `defineTable` and the spec validator: what a definition
 * attaches and derives, and each declaration rule with the code it fails on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  column,
  defineModel,
  defineTable,
  MODEL_SPEC,
  modelDefinition,
  modelSpec,
  ModelSpecError,
  snakeCase,
  type ModelSpec,
} from '../../src/model/index.js';

function rejects(spec: unknown, code: string, field?: string): void {
  assert.throws(
    () => defineTable(spec as ModelSpec),
    (error: unknown) => {
      assert.ok(error instanceof ModelSpecError, `expected a ModelSpecError, got ${String(error)}`);
      assert.equal(error.code, code);
      if (field !== undefined) assert.equal(error.field, field);
      return true;
    },
  );
}

const users = defineTable({ table: 'users', columns: { email: column.string(200) } });

describe('defineModel and defineTable', () => {
  it('attaches a frozen, normalized spec under the registry-wide symbol', () => {
    class Post {}
    const returned = defineModel(Post, {
      table: 'posts',
      columns: { title: column.string(200), publishedAt: column.timestamp({ nullable: true }) },
      relations: { author: { kind: 'belongsTo', target: () => users } },
      lockVersion: true,
    });
    assert.equal(returned, Post);
    assert.equal(MODEL_SPEC, Symbol.for('jsails.model.spec'));
    assert.equal(Object.keys(Post).length, 0, 'the definition is not enumerable');
    const spec = modelSpec(Post);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.columns));
    assert.equal(spec.name, 'Post');
    assert.equal(spec.generatedKey, true);
    assert.deepEqual(
      spec.columns.map((c) => [c.property, c.column, c.type.kind, c.nullable, c.origin]),
      [
        ['id', 'id', 'id', false, 'primary-key'],
        ['title', 'title', 'string', false, 'declared'],
        ['publishedAt', 'published_at', 'timestamp', true, 'declared'],
        ['authorId', 'author_id', 'id', false, 'foreign-key'],
        ['lockVersion', 'lock_version', 'integer', false, 'lock-version'],
      ],
    );
  });

  it('is read by own property only, and once per class', () => {
    class Base {}
    defineModel(Base, { table: 'bases', columns: {} });
    class Derived extends Base {}
    assert.equal(modelDefinition(Derived), undefined);
    assert.equal(modelDefinition({}), undefined);
    assert.equal(modelDefinition(null), undefined);
    assert.throws(() => defineModel(Base, { table: 'bases', columns: {} }), {
      code: 'already_defined',
    });
    assert.throws(() => modelSpec(Derived), { code: 'unresolved_relation' });
  });

  it('makes a class-less table that relations can target', () => {
    assert.equal(users.kind, 'table');
    assert.equal(modelDefinition(users), users);
    assert.equal(users.spec.name, 'users');
    assert.ok(Object.isFrozen(users));
  });

  it('derives physical names in snake_case', () => {
    assert.equal(snakeCase('authorId'), 'author_id');
    assert.equal(snakeCase('htmlURL'), 'html_url');
    assert.equal(snakeCase('URLPath'), 'url_path');
    assert.equal(snakeCase('line2Text'), 'line2_text');
  });

  it('adds polymorphic pairs and keeps a declared foreign key', () => {
    const memberships = defineTable({
      table: 'memberships',
      primaryKey: ['tenantId', 'userId'],
      columns: { tenantId: column.uuid(), userId: column.id() },
      relations: {
        user: { kind: 'belongsTo', target: () => users, foreignKey: 'userId' },
        subject: { kind: 'belongsTo', polymorphic: true, nullable: true },
      },
      tenant: 'tenantId',
    });
    assert.equal(memberships.spec.generatedKey, false);
    assert.deepEqual(
      memberships.spec.columns.map((c) => [c.property, c.origin, c.nullable]),
      [
        ['tenantId', 'primary-key', false],
        ['userId', 'foreign-key', false],
        ['subjectType', 'polymorphic-type', true],
        ['subjectId', 'polymorphic-id', true],
      ],
    );
  });
});

describe('the spec validator', () => {
  const base = { table: 'things', columns: {} };

  it('refuses unknown fields and malformed names', () => {
    rejects({ ...base, extra: true }, 'invalid_spec', 'spec.extra');
    rejects({ table: 'Things', columns: {} }, 'invalid_identifier', 'table');
    rejects({ table: 'a'.repeat(64), columns: {} }, 'invalid_identifier', 'table');
    rejects({ ...base, columns: { 'bad-name': column.text() } }, 'invalid_identifier');
    rejects(
      { ...base, columns: { title: { ...column.text(), column: 'Title' } } },
      'invalid_identifier',
    );
    rejects({ ...base, columns: { title: { ...column.text(), size: 1 } } }, 'invalid_spec');
    rejects({ ...base, name: 'has space' }, 'invalid_spec', 'name');
    rejects(null, 'invalid_spec');
  });

  it('accepts only portable types with parameters in range', () => {
    rejects({ ...base, columns: { at: { type: { kind: 'datetime' } } } }, 'invalid_type');
    rejects({ ...base, columns: { s: column.string(0) } }, 'invalid_type');
    rejects({ ...base, columns: { s: column.string(16384) } }, 'invalid_type');
    rejects({ ...base, columns: { d: column.decimal(39, 2) } }, 'invalid_type');
    rejects({ ...base, columns: { d: column.decimal(4, 5) } }, 'invalid_type');
    rejects({ ...base, columns: { b: column.binary(65533) } }, 'invalid_type');
    rejects(
      { ...base, columns: { s: { type: { kind: 'string', length: 5, collation: 'x' } } } },
      'invalid_type',
    );
  });

  it('refuses two properties on one column', () => {
    rejects(
      { ...base, columns: { fooBar: column.text(), other: column.text({ column: 'foo_bar' }) } },
      'duplicate_column',
    );
    rejects(
      {
        ...base,
        columns: { authorId: column.id({ nullable: true }) },
        relations: { authorId: { kind: 'belongsTo', polymorphic: true } },
      },
      'duplicate_column',
    );
    rejects(
      { ...base, columns: { lockVersion: column.integer() }, lockVersion: true },
      'duplicate_column',
    );
  });

  it('checks defaults against the type on every dialect', () => {
    defineTable({
      ...base,
      table: 'defaults_ok',
      columns: {
        flag: column.boolean({ default: true }),
        big: column.bigint({ default: '9007199254740993' }),
        at: column.timestamp({ default: { now: true } }),
        price: column.decimal(6, 2, { default: '1.5' }),
      },
    });
    rejects({ ...base, columns: { n: column.integer({ default: 'x' }) } }, 'invalid_default');
    rejects({ ...base, columns: { s: column.string(2, { default: 'abc' }) } }, 'invalid_default');
    rejects(
      { ...base, columns: { d: column.date({ default: { now: true } }) } },
      'invalid_default',
    );
    rejects(
      { ...base, columns: { t: column.timestamp({ default: '2024-01-01' }) } },
      'invalid_default',
    );
    rejects({ ...base, columns: { b: column.bigint({ default: 1.5 }) } }, 'invalid_default');
    rejects(
      {
        ...base,
        columns: { u: column.uuid({ default: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }) },
      },
      'invalid_default',
    );
    rejects(
      {
        ...base,
        columns: { s: column.string(10, { default: 'x', encrypted: { mode: 'random' } }) },
      },
      'invalid_default',
    );
  });

  it('requires a non-null, indexable primary key', () => {
    rejects({ ...base, primaryKey: 'code', columns: {} }, 'unknown_column');
    rejects(
      { ...base, primaryKey: 'code', columns: { code: column.string(10, { nullable: true }) } },
      'invalid_primary_key',
    );
    rejects(
      { ...base, primaryKey: 'body', columns: { body: column.text() } },
      'invalid_primary_key',
    );
    rejects(
      { ...base, primaryKey: 'score', columns: { score: column.float() } },
      'invalid_primary_key',
    );
    rejects({ ...base, primaryKey: [], columns: {} }, 'invalid_primary_key');
    rejects(
      { ...base, primaryKey: ['a', 'a'], columns: { a: column.integer() } },
      'invalid_primary_key',
    );
    rejects({ ...base, columns: { id: column.id({ default: 1 }) } }, 'invalid_primary_key');
    const coded = defineTable({
      ...base,
      table: 'coded',
      primaryKey: 'code',
      columns: { code: column.string(20) },
    });
    assert.equal(coded.spec.generatedKey, false);
    assert.equal(coded.spec.columns[0]?.origin, 'primary-key');
  });

  it('checks relations that need only the spec', () => {
    const target = () => users;
    rejects(
      { ...base, relations: { owner: { kind: 'belongsTo' } } },
      'invalid_relation',
      'relations.owner.target',
    );
    rejects(
      { ...base, relations: { owner: { kind: 'belongsTo', target, onDelete: 'set null' } } },
      'invalid_relation',
    );
    rejects(
      { ...base, relations: { owner: { kind: 'belongsTo', target, onDelete: 'explode' } } },
      'invalid_relation',
    );
    rejects(
      { ...base, relations: { owner: { kind: 'belongsTo', target, index: true } } },
      'invalid_relation',
    );
    rejects({ ...base, relations: { owner: { kind: 'hasMany', target } } }, 'invalid_relation');
    rejects(
      {
        ...base,
        relations: { owner: { kind: 'hasMany', target, inverse: 'x', dependent: 'drop' } },
      },
      'invalid_relation',
    );
    rejects(
      {
        ...base,
        relations: { owner: { kind: 'hasMany', target, inverse: 'x', dependent: 'delete' } },
      },
      'invalid_relation',
      'relations.owner.dependent',
    );
    rejects(
      {
        ...base,
        relations: {
          owner: { kind: 'belongsTo', target, foreignKey: 'ownerKey', onDelete: 'set null' },
        },
      },
      'invalid_relation',
      'relations.owner.onDelete',
    );
    rejects({ ...base, relations: { owner: { kind: 'manyToMany', target } } }, 'invalid_relation');
    rejects(
      {
        ...base,
        relations: { tags: { kind: 'hasMany', target, through: 'missing', source: 'tag' } },
      },
      'invalid_relation',
      'relations.tags.through',
    );
    rejects(
      {
        ...base,
        columns: { ownerId: column.id() },
        relations: { owner: { kind: 'belongsTo', target, nullable: true } },
      },
      'invalid_relation',
    );
    rejects(
      {
        ...base,
        columns: { ownerId: column.id() },
        relations: { owner: { kind: 'belongsTo', target, onDelete: 'set null' } },
      },
      'invalid_relation',
    );
  });

  it('requires a non-null key column for the tenant, and the tenant in every unique', () => {
    const tenant = { tenantId: column.uuid() };
    rejects({ ...base, tenant: 'tenantId' }, 'invalid_tenant');
    rejects(
      { ...base, columns: { tenantId: column.uuid({ nullable: true }) }, tenant: 'tenantId' },
      'invalid_tenant',
    );
    rejects(
      { ...base, columns: { tenantId: column.json() }, tenant: 'tenantId' },
      'invalid_tenant',
    );
    rejects({ ...base, tenant: 'id' }, 'invalid_tenant');
    rejects(
      {
        ...base,
        columns: { ...tenant, slug: column.string(50) },
        tenant: 'tenantId',
        indexes: [{ columns: ['slug'], unique: true }],
      },
      'unique_without_tenant',
      'indexes[0]',
    );
    rejects(
      {
        ...base,
        primaryKey: 'code',
        columns: { ...tenant, code: column.string(10) },
        tenant: 'tenantId',
      },
      'unique_without_tenant',
      'primaryKey',
    );
    rejects(
      {
        ...base,
        columns: { slug: column.string(50) },
        indexes: [{ columns: ['slug'], unique: true, global: true }],
      },
      'invalid_index',
    );
    const scoped = defineTable({
      ...base,
      table: 'scoped',
      columns: { ...tenant, slug: column.string(50), handle: column.string(50) },
      tenant: 'tenantId',
      indexes: [
        { columns: ['tenantId', 'slug'], unique: true },
        { columns: ['handle'], unique: true, global: true },
      ],
    });
    assert.deepEqual(
      scoped.spec.indexes.map((index) => index.name),
      ['scoped_tenant_id_slug_key', 'scoped_handle_key'],
    );
  });

  it('checks index columns, width, names and duplicates', () => {
    const columns = {
      a: column.string(100),
      b: column.string(400),
      body: column.text(),
      doc: column.json(),
    };
    rejects({ ...base, columns, indexes: [{ columns: [] }] }, 'invalid_index');
    rejects({ ...base, columns, indexes: [{ columns: ['a', 'a'] }] }, 'invalid_index');
    rejects({ ...base, columns, indexes: [{ columns: ['zzz'] }] }, 'unknown_column');
    rejects({ ...base, columns, indexes: [{ columns: ['body'] }] }, 'unindexable_column');
    rejects({ ...base, columns, indexes: [{ columns: ['doc'] }] }, 'unindexable_column');
    rejects({ ...base, columns, indexes: [{ columns: ['a', 'b', 'b2'] }] }, 'unknown_column');
    rejects(
      {
        ...base,
        columns: { ...columns, c: column.string(300) },
        indexes: [{ columns: ['b', 'c'] }],
      },
      'index_too_wide',
    );
    // PostgreSQL's 2704-byte entry: an 8-byte header and a 4-byte length
    // around 4 bytes per character leave room for 673 characters.
    defineTable({
      ...base,
      table: 'widest',
      columns: { s: column.string(673) },
      indexes: [{ columns: ['s'] }],
    });
    rejects(
      { ...base, columns: { s: column.string(674) }, indexes: [{ columns: ['s'] }] },
      'index_too_wide',
    );
    rejects(
      { ...base, columns: { s: column.string(674) }, primaryKey: 's' },
      'index_too_wide',
      'primaryKey',
    );
    rejects({ ...base, columns, indexes: [{ columns: ['a'], name: 'Bad' }] }, 'invalid_identifier');
    rejects(
      { ...base, columns, indexes: [{ columns: ['a'] }, { columns: ['a'] }] },
      'duplicate_index',
    );
    rejects(
      {
        ...base,
        columns,
        indexes: [
          { columns: ['a'], name: 'x' },
          { columns: ['b'], name: 'x' },
        ],
      },
      'duplicate_index',
    );
    rejects({ ...base, columns, indexes: [{ columns: ['a'], unique: false }] }, 'invalid_spec');
    const long = defineTable({
      table: 'a_rather_long_table_name_for_an_index',
      columns: { aRatherLongColumnName: column.integer(), anotherLongColumnName: column.integer() },
      indexes: [{ columns: ['aRatherLongColumnName', 'anotherLongColumnName'] }],
    });
    const name = long.spec.indexes[0]?.name ?? '';
    assert.ok(name.length <= 63);
    assert.match(name, /^a_rather_long_table_name_for_an_index_a_rather_long_co_[0-9a-f]{8}$/);
  });

  it('checks encrypted columns: type, envelope bound, and indexability', () => {
    rejects(
      { ...base, columns: { at: column.timestamp({ encrypted: { mode: 'random' } }) } },
      'invalid_encryption',
    );
    rejects(
      { ...base, columns: { s: column.text({ encrypted: { mode: 'deterministic' } }) } },
      'invalid_encryption',
    );
    rejects(
      {
        ...base,
        columns: { s: column.string(10, { encrypted: { mode: 'random', maxLength: 41 } }) },
      },
      'invalid_encryption',
    );
    rejects(
      { ...base, columns: { s: column.text({ encrypted: { mode: 'other' } as never }) } },
      'invalid_encryption',
    );
    rejects(
      { ...base, columns: { s: column.text({ encrypted: { mode: 'random', maxLength: 65500 } }) } },
      'invalid_encryption',
    );
    rejects(
      {
        ...base,
        columns: { s: column.string(10, { encrypted: { mode: 'random' } }) },
        indexes: [{ columns: ['s'] }],
      },
      'encrypted_not_indexable',
    );
    rejects(
      {
        ...base,
        columns: { s: column.string(1000, { encrypted: { mode: 'deterministic' } }) },
        indexes: [{ columns: ['s'], unique: true }],
      },
      'encrypted_not_indexable',
    );
    rejects(
      {
        ...base,
        columns: { tenantId: column.string(36, { encrypted: { mode: 'deterministic' } }) },
        tenant: 'tenantId',
      },
      'invalid_tenant',
    );
    const sealed = defineTable({
      ...base,
      table: 'sealed',
      columns: {
        email: column.string(254, { encrypted: { mode: 'deterministic' } }),
        notes: column.text({ encrypted: { mode: 'random' } }),
      },
      indexes: [{ columns: ['email'], unique: true }],
    });
    assert.equal(sealed.spec.columns[1]?.encrypted?.mode, 'deterministic');
  });

  it('refuses a row MariaDB could not store', () => {
    const columns: Record<string, ReturnType<typeof column.string>> = {};
    for (let index = 0; index < 5; index += 1) columns[`s${index}`] = column.string(4000);
    rejects({ ...base, columns }, 'row_too_wide');
  });

  it('checks autosave flags and attachments', () => {
    const owner = defineTable({ table: 'as_owners', columns: {} });
    const autosaved = defineTable({
      table: 'as_children',
      columns: {},
      relations: { owner: { kind: 'belongsTo', target: () => owner, autosave: true } },
      attachments: { avatar: { kind: 'one' } },
    });
    assert.deepEqual(modelSpec(autosaved).attachments, { avatar: { kind: 'one' } });
    assert.equal(
      (modelSpec(autosaved).relations.owner as { readonly autosave?: true }).autosave,
      true,
    );
    const relation = { kind: 'belongsTo', target: () => owner, autosave: 'yes' };
    rejects(
      { ...base, relations: { owner: relation } },
      'invalid_spec',
      'relations.owner.autosave',
    );
    rejects(
      {
        ...base,
        relations: {
          kids: { kind: 'hasMany', target: () => owner, inverse: 'x', autosave: false },
        },
      },
      'invalid_spec',
      'relations.kids.autosave',
    );
    rejects(
      { ...base, attachments: { avatar: { kind: 'many' } } },
      'invalid_spec',
      'attachments.avatar.kind',
    );
    rejects({ ...base, attachments: { avatar: { kind: 'one', disk: 'x' } } }, 'invalid_spec');
    rejects({ ...base, attachments: [] }, 'invalid_spec', 'attachments');
    rejects(
      { ...base, columns: { avatar: column.string(10) }, attachments: { avatar: { kind: 'one' } } },
      'duplicate_column',
      'attachments.avatar',
    );
    rejects(
      {
        ...base,
        primaryKey: ['a', 'b'],
        columns: { a: column.integer(), b: column.integer() },
        attachments: { avatar: { kind: 'one' } },
      },
      'invalid_spec',
      'attachments',
    );
  });

  it('names the model and field in the error, never a value', () => {
    assert.throws(
      () =>
        defineTable({
          table: 'leaky',
          columns: { s: column.string(2, { default: 'secret-default' }) },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ModelSpecError);
        assert.equal(error.model, 'leaky');
        assert.equal(error.field, 'columns.s.default');
        assert.doesNotMatch(error.message, /secret-default/);
        return true;
      },
    );
  });
});
