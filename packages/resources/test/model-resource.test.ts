/**
 * Tests for the definition-time rules of `defineModelResource`: every unsafe
 * or ambiguous declaration fails when the resource is defined, with a stable
 * code and a value-free message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

import { integer, string, type ResourceAuthorize } from 'jsails/api';
import { registerModel } from 'jsails/models';

import {
  defineModelResource,
  ModelResourceError,
  scopedBy,
  unscoped,
  type ModelResourceErrorCode,
} from '../src/index.js';
import { call, defineNoteEntity, type NoteEntity } from './fixtures.js';

const allow: ResourceAuthorize<unknown> = () => true;
const everyRow = unscoped('test fixture');

function rejects(code: ModelResourceErrorCode, define: () => unknown, field?: string): void {
  assert.throws(define, (error: unknown) => {
    assert.ok(error instanceof ModelResourceError);
    assert.equal(error.code, code);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
}

function define(Note: NoteEntity, overrides: Record<string, unknown>) {
  return defineModelResource(Note, {
    name: 'notes',
    fields: { id: { schema: integer(), access: 'read' } },
    scope: everyRow,
    authorize: allow,
    ...overrides,
  } as never);
}

describe('defineModelResource definition rules', () => {
  const Note = defineNoteEntity('rules_note');

  it('accepts a valid definition and returns frozen plain data', () => {
    const resource = defineModelResource(Note, {
      name: 'notes',
      fields: {
        id: { schema: integer(), access: 'read', sort: true },
        title: { schema: string({ min: 1 }), access: 'readWrite', sort: true, search: true },
        rank: {
          schema: integer(),
          access: 'readWrite',
          filter: { type: 'integer', operators: ['gte'] },
        },
        secret: { schema: string(), access: 'write' },
      },
      scope: everyRow,
      authorize: allow,
      defaultSort: [{ field: 'title', direction: 'asc' }],
    });
    assert.ok(Object.isFrozen(resource));
    assert.equal(resource.name, 'notes');
    assert.deepEqual(Object.keys(resource.filters.fields).sort(), ['id', 'rank', 'title']);
    assert.equal(resource.filters.fields['rank']?.sortable, false);
    assert.equal(resource.filters.fields['title']?.filterable, false);
    assert.equal(typeof resource.handlers.collection.GET, 'function');
    assert.equal(typeof resource.handlers.detail.PATCH, 'function');
  });

  it('requires authorize and a scope', () => {
    rejects('missing_authorize', () => define(Note, { authorize: undefined }));
    rejects('missing_scope', () => define(Note, { scope: undefined }));
    rejects('missing_scope', () => define(Note, { scope: { kind: 'everything' } }));
  });

  it('requires a written reason to opt out of scope', () => {
    rejects('invalid_scope', () => unscoped(''));
    rejects('invalid_scope', () => unscoped('   '));
    rejects('invalid_scope', () => scopedBy(undefined as never));
  });

  it('requires a URL-safe name', () => {
    rejects('invalid_name', () => define(Note, { name: '../notes' }));
    rejects('invalid_name', () => define(Note, { name: '' }));
  });

  it('requires at least one well-formed field', () => {
    rejects('invalid_fields', () => define(Note, { fields: {} }));
    rejects(
      'invalid_field',
      () => define(Note, { fields: { title: { schema: string() } } }),
      'title',
    );
    rejects(
      'invalid_field',
      () => define(Note, { fields: { title: { schema: string(), access: 'admin' } } }),
      'title',
    );
  });

  it('refuses a field that is not a column', () => {
    rejects(
      'unknown_column',
      () => define(Note, { fields: { password: { schema: string(), access: 'write' } } }),
      'password',
    );
    rejects(
      'unknown_column',
      () => define(Note, { fields: { constructor: { schema: string(), access: 'read' } } }),
      'constructor',
    );
  });

  it('keeps the primary key read-only', () => {
    rejects(
      'primary_key_writable',
      () => define(Note, { fields: { id: { schema: integer(), access: 'readWrite' } } }),
      'id',
    );
  });

  it('never lets a write-only field be queried', () => {
    for (const query of [{ sort: true }, { filter: {} }, { search: true }]) {
      rejects(
        'writeonly_queryable',
        () => define(Note, { fields: { secret: { schema: string(), access: 'write', ...query } } }),
        'secret',
      );
    }
  });

  it('never lets a JSON column be queried', () => {
    rejects(
      'json_queryable',
      () => define(Note, { fields: { meta: { schema: string(), access: 'read', filter: {} } } }),
      'meta',
    );
  });

  it('searches only text columns', () => {
    rejects(
      'search_not_text',
      () => define(Note, { fields: { rank: { schema: integer(), access: 'read', search: true } } }),
      'rank',
    );
  });

  it('limits the default sort to sortable fields', () => {
    rejects(
      'invalid_sort',
      () =>
        define(Note, {
          fields: { title: { schema: string(), access: 'read' } },
          defaultSort: [{ field: 'title', direction: 'asc' }],
        }),
      'title',
    );
  });

  it('requires a single primary key named id', () => {
    @Entity('rules_keyed')
    class Keyed extends BaseEntity {
      @PrimaryColumn({ type: 'varchar', length: 40 })
      slug!: string;

      @Column({ type: 'varchar', length: 40 })
      title!: string;
    }
    rejects('missing_primary_key', () =>
      defineModelResource(Keyed, {
        name: 'keyed',
        fields: { title: { schema: string(), access: 'read' } },
        scope: everyRow,
        authorize: allow,
      }),
    );
  });

  it('refuses a class without columns', () => {
    class Plain extends BaseEntity {}
    rejects('invalid_model', () =>
      defineModelResource(Plain, {
        name: 'plain',
        fields: { id: { schema: integer(), access: 'read' } },
        scope: everyRow,
        authorize: allow,
      }),
    );
  });

  describe('actions', () => {
    const readOnly = () =>
      define(Note, {
        fields: { id: { schema: integer(), access: 'read' } },
        actions: ['list', 'retrieve'],
      });

    it('serves all five by default and lists what it serves', () => {
      assert.deepEqual(define(Note, {}).actions, [
        'list',
        'create',
        'retrieve',
        'update',
        'delete',
      ]);
      assert.deepEqual(readOnly().actions, ['list', 'retrieve']);
    });

    it('answers an action left out with 405 and an Allow header', async () => {
      const { collection, detail } = readOnly().handlers;
      const created = await call(collection.POST, 'POST', '/api/notes', { body: {} });
      assert.equal(created.status, 405);
      assert.equal((created.body as { error: { allow: string } }).error.allow, 'GET');
      const removed = await call(detail.DELETE, 'DELETE', '/api/notes/1', { params: { id: '1' } });
      assert.equal(removed.status, 405);
      assert.equal((removed.body as { error: { allow: string } }).error.allow, 'GET');
    });

    it('refuses a write the actions leave out in the store too', async () => {
      await assert.rejects(
        readOnly().store.create({}, { request: new Request('http://localhost/') } as never),
        (error: unknown) =>
          error instanceof ModelResourceError && error.code === 'action_not_allowed',
      );
    });

    it('must list known actions', () => {
      rejects('invalid_actions', () => define(Note, { actions: [] }));
      rejects('invalid_actions', () => define(Note, { actions: ['destroy'] }));
    });
  });

  describe('stamp', () => {
    const title = { title: { schema: string(), access: 'readWrite' } };

    it('must map columns to functions', () => {
      rejects('invalid_stamp', () => define(Note, { fields: title, stamp: () => ({}) }));
      rejects(
        'invalid_stamp',
        () => define(Note, { fields: title, stamp: { ownerId: 1 } }),
        'ownerId',
      );
    });

    it('must name a column the client cannot write', () => {
      rejects(
        'unknown_column',
        () => define(Note, { fields: title, stamp: { missing: () => 1 } }),
        'missing',
      );
      rejects(
        'stamped_field_writable',
        () => define(Note, { fields: title, stamp: { title: () => 'x' } }),
        'title',
      );
    });
  });

  describe('encrypted columns', () => {
    const Sealed = defineNoteEntity('rules_sealed');
    registerModel(Sealed, [], {
      table: 'rules_sealed',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [],
      relations: [],
      encrypted: ['secret'],
    });

    it('must be exposed by name', () => {
      rejects(
        'encrypted_field',
        () => define(Sealed, { fields: { secret: { schema: string(), access: 'readWrite' } } }),
        'secret',
      );
    });

    it('are never queryable, even when exposed', () => {
      rejects(
        'encrypted_queryable',
        () =>
          define(Sealed, {
            fields: { secret: { schema: string(), access: 'read', sort: true } },
            exposeEncrypted: ['secret'],
          }),
        'secret',
      );
    });

    it('are allowed when exposed and not queried', () => {
      const resource = define(Sealed, {
        fields: { secret: { schema: string(), access: 'read' } },
        exposeEncrypted: ['secret'],
      });
      assert.equal(resource.name, 'notes');
    });
  });

  it('carries value-free messages', () => {
    try {
      define(Note, { fields: { s3cr3tColumn: { schema: string(), access: 'read' } } });
      assert.fail('expected a definition error');
    } catch (error) {
      assert.ok(error instanceof ModelResourceError);
      assert.ok(!error.message.includes('s3cr3tColumn'));
    }
  });
});
