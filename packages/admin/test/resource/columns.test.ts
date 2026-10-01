/**
 * Tests for column and infolist validation: empty or duplicate columns, an
 * unsupported format, colors on a non-badge/boolean column, an image format
 * without `imageBaseUrl`, a relation column without `resolve`, and an invalid
 * infolist all reject at `defineResource` time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminDefinitionError, defineResource, type ResourceField } from '../../src/index.js';

describe('column validation', () => {
  const base = () => ({
    slug: 'ok',
    label: 'Label',
    columns: [{ name: 'id', label: 'ID' }],
    fields: [] as ResourceField[],
    list: async () => ({ rows: [], total: 0 }),
  });

  it('rejects empty or duplicate columns', () => {
    assert.throws(() => defineResource({ ...base(), columns: [] }), AdminDefinitionError);
    assert.throws(
      () =>
        defineResource({
          ...base(),
          columns: [
            { name: 'id', label: 'ID' },
            { name: 'id', label: 'ID Again' },
          ],
        }),
      AdminDefinitionError,
    );
  });

  it('rejects an unsupported column format and colors on a non-badge/boolean column', () => {
    assert.throws(
      () =>
        defineResource({
          ...base(),
          columns: [{ name: 'x', label: 'X', format: 'bogus' as never }],
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base(),
          columns: [{ name: 'x', label: 'X', format: 'date', colors: { a: 'b' } }],
        }),
      AdminDefinitionError,
    );
  });
});

describe('relation and image columns', () => {
  it('rejects a relation column without resolve and resolve on a plain column', () => {
    const base = {
      slug: 'posts',
      label: 'Posts',
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () =>
        defineResource({
          ...base,
          columns: [{ name: 'tags', label: 'Tags', type: 'relation' as const }],
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          columns: [{ name: 'title', label: 'Title', resolve: async () => [] }],
        }),
      AdminDefinitionError,
    );
  });

  it('rejects an image format without imageBaseUrl', () => {
    assert.throws(
      () =>
        defineResource({
          slug: 'x',
          label: 'X',
          columns: [{ name: 'i', label: 'I', format: 'image' }],
          fields: [{ name: 'i', label: 'I', type: 'text' }],
          list: async () => ({ rows: [], total: 0 }),
        }),
      AdminDefinitionError,
    );
  });
});

describe('infolist validation', () => {
  it('rejects an invalid infolist (empty entries, bad format, colors on date)', () => {
    const base = {
      slug: 'items',
      label: 'Items',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }] as readonly ResourceField[],
      list: async () => ({ rows: [], total: 0 }),
    };
    assert.throws(
      () => defineResource({ ...base, infolist: { label: 'D', entries: [] } }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          infolist: {
            label: 'D',
            entries: [{ name: 'x', label: 'X', format: 'bogus' as never }],
          },
        }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineResource({
          ...base,
          infolist: {
            label: 'D',
            entries: [{ name: 'x', label: 'X', format: 'date', colors: { a: 'b' } }],
          },
        }),
      AdminDefinitionError,
    );
  });
});
