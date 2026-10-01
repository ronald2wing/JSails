/**
 * Tests for the live publication contract and its name-keyed registry
 * (docs/design/live.md §4.2, §4.3).
 *
 * `definePublication` freezes a definition and rejects one without `authorize`
 * at construction; `createPublicationRegistry` resolves definitions by name and
 * rejects duplicates value-free (a `code`, never the echoed name).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  createPublicationRegistry,
  definePublication,
  PublicationDefinitionError,
  PublicationRegistryError,
  type PublicationDefinition,
} from '../../src/live/index.js';
import type { ModelQuery } from '../../src/database/model-query.js';

type Row = { id: number };

// A registry test avoids a live DataSource: the `query` callback only ever
// *returns* a ModelQuery (never executes), so a stub cast through `unknown`
// stands in for the real thing without reaching `getRepository()`.
function stubQuery(): ModelQuery<Row> {
  return {} as unknown as ModelQuery<Row>;
}

/** A well-formed post definition; `overrides` replace fields for the bad cases. */
function aPostDefinition(
  overrides: Partial<PublicationDefinition<Record<string, unknown>, Row>> = {},
): PublicationDefinition<Record<string, unknown>, Row> {
  return {
    name: 'posts',
    collection: 'posts',
    fields: ['id'],
    params: z.object({}).strict(),
    authorize: () => true,
    query: () => stubQuery(),
    ...overrides,
  };
}

describe('definePublication', () => {
  it('freezes the returned definition', () => {
    const definition = definePublication(aPostDefinition());
    assert.ok(Object.isFrozen(definition));
    assert.equal(definition.name, 'posts');
    assert.equal(definition.collection, 'posts');
    assert.equal(typeof definition.authorize, 'function');
    assert.equal(typeof definition.query, 'function');
  });

  it('returns content identical to its input (spread, no added fields)', () => {
    const input = aPostDefinition();
    assert.deepEqual(definePublication(input), input);
  });

  it('rejects a definition missing authorize, value-free', () => {
    const missing = aPostDefinition();
    delete (missing as { authorize?: unknown }).authorize;
    assert.throws(
      () => definePublication(missing),
      (err: unknown) =>
        err instanceof PublicationDefinitionError &&
        err.code === 'missing_authorize' &&
        !err.message.includes('posts'),
    );
  });

  it('rejects a non-function authorize (an as-cast object fails closed)', () => {
    assert.throws(
      () => definePublication({ ...aPostDefinition(), authorize: 'yes' as unknown as () => true }),
      (err: unknown) =>
        err instanceof PublicationDefinitionError && err.code === 'missing_authorize',
    );
  });

  it('rejects a definition missing query', () => {
    const missing = { ...aPostDefinition(), query: undefined as unknown as () => ModelQuery<Row> };
    assert.throws(
      () => definePublication(missing),
      (err: unknown) => err instanceof PublicationDefinitionError && err.code === 'missing_query',
    );
  });

  it('rejects an empty name', () => {
    assert.throws(
      () => definePublication(aPostDefinition({ name: '' })),
      (err: unknown) => err instanceof PublicationDefinitionError && err.code === 'invalid_name',
    );
  });

  it('requires exactly one of fields or project', () => {
    const neither = aPostDefinition();
    delete (neither as { fields?: unknown }).fields;
    const both = aPostDefinition({ project: (row) => ({ id: row.id }) });
    for (const definition of [neither, both]) {
      assert.throws(
        () => definePublication(definition),
        (err: unknown) =>
          err instanceof PublicationDefinitionError && err.code === 'missing_projection',
      );
    }
    const projected = definePublication({
      ...neither,
      project: (row: Row) => ({ id: row.id }),
    });
    assert.equal(typeof projected.project, 'function');
  });

  it('rejects a field list without id, with duplicates, or with a blank name', () => {
    for (const fields of [[], ['secretcol'], ['id', 'id'], ['id', '']]) {
      assert.throws(
        () => definePublication(aPostDefinition({ fields: fields as unknown as ['id'] })),
        (err: unknown) =>
          err instanceof PublicationDefinitionError &&
          err.code === 'invalid_fields' &&
          !err.message.includes('secretcol'),
      );
    }
  });

  it('freezes a copy of the field list', () => {
    const fields: Array<'id'> = ['id'];
    const definition = definePublication(aPostDefinition({ fields }));
    fields.push('id');
    assert.deepEqual(definition.fields, ['id']);
    assert.ok(Object.isFrozen(definition.fields));
  });
});

describe('createPublicationRegistry', () => {
  it('registers and retrieves a definition by name', () => {
    const registry = createPublicationRegistry();
    registry.register(definePublication(aPostDefinition()));
    const found = registry.get('posts');
    assert.ok(found);
    assert.equal(found.name, 'posts');
  });

  it('returns undefined for an unknown name', () => {
    assert.equal(createPublicationRegistry().get('nope'), undefined);
  });

  it('rejects a duplicate name with code duplicate_publication and no echoed name', () => {
    const registry = createPublicationRegistry();
    registry.register(definePublication(aPostDefinition()));
    assert.throws(
      () => registry.register(definePublication(aPostDefinition())),
      (err: unknown) =>
        err instanceof PublicationRegistryError &&
        err.code === 'duplicate_publication' &&
        !err.message.includes('posts'),
    );
    // The original definition survives the rejected registration.
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get('posts')?.collection, 'posts');
  });

  it('list() returns a frozen array of frozen definitions, isolated from the map', () => {
    const registry = createPublicationRegistry();
    registry.register(definePublication(aPostDefinition({ name: 'posts' })));
    registry.register(definePublication(aPostDefinition({ name: 'comments' })));

    const list = registry.list();
    assert.ok(Object.isFrozen(list));
    assert.equal(list.length, 2);
    for (const definition of list) {
      assert.ok(Object.isFrozen(definition));
    }

    const names = list.map((d) => d.name).sort();
    assert.deepEqual(names, ['comments', 'posts']);
  });
});
