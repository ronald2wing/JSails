/**
 * Tests for `defineResource`: slug, label, and list validation plus the deeply
 * frozen descriptor, including a `relationManagers` entry.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  defineRelationManager,
  defineResource,
  type ResourceField,
} from '../../src/index.js';

describe('defineResource validation', () => {
  const base = () => ({
    slug: 'ok',
    label: 'Label',
    columns: [{ name: 'id', label: 'ID' }],
    fields: [] as ResourceField[],
    list: async () => ({ rows: [], total: 0 }),
  });

  it('rejects a malformed or reserved slug', () => {
    for (const slug of ['', 'bad/slug', 'bad slug', 'bad.slug', '-lead', 'trail-', 'plugins']) {
      assert.throws(
        () => defineResource({ ...base(), slug }),
        AdminDefinitionError,
        `slug ${slug}`,
      );
    }
  });

  it('rejects a missing or blank label', () => {
    for (const label of ['', '   ']) {
      assert.throws(() => defineResource({ ...base(), label }), AdminDefinitionError);
    }
  });

  it('rejects a missing list function', () => {
    assert.throws(
      () => defineResource({ ...base(), list: undefined } as never),
      AdminDefinitionError,
    );
  });

  it('accepts a valid spec and freezes the descriptor', () => {
    const resource = defineResource({
      ...base(),
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
    });
    assert.equal(Object.isFrozen(resource), true);
    assert.equal(Object.isFrozen(resource.columns), true);
    assert.equal(Object.isFrozen(resource.fields), true);
    assert.equal(resource.slug, 'ok');
  });

  it('accepts a valid spec with a relationManagers entry and freezes it', () => {
    const related = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'text', label: 'Text', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'comments',
      label: 'Comments',
      related,
      foreignKey: 'post_id',
      list: async () => ({ rows: [], total: 0 }),
      create: async () => {},
      delete: async () => {},
    });
    const resource = defineResource({ ...base(), relationManagers: [rm] });
    assert.equal(Array.isArray(resource.relationManagers), true);
    assert.equal(resource.relationManagers!.length, 1);
    assert.equal(Object.isFrozen(resource.relationManagers![0]!), true);
  });
});
