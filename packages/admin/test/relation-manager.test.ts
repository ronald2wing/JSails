/**
 * Tests for `defineRelationManager` (validation and the frozen descriptor) and
 * `renderRelationManager` (escaped related cells).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  defineRelationManager,
  defineResource,
  renderRelationManager,
} from '../src/index.js';

describe('relation managers', () => {
  it('defineRelationManager validates and freezes its descriptor', () => {
    const related = defineResource({
      slug: 'comments',
      label: 'Comments',
      columns: [{ name: 'body', label: 'Body' }],
      fields: [{ name: 'body', label: 'Body', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'comments',
      label: 'Comments',
      related,
      foreignKey: 'postId',
      list: async () => ({ rows: [{ id: 'c1', body: 'hi' }], total: 1 }),
    });
    assert.equal(Object.isFrozen(rm), true);
    assert.equal(rm.foreignKey, 'postId');
  });

  it('rejects a relation manager with an empty foreignKey', () => {
    const related = defineResource({
      slug: 'r',
      label: 'R',
      columns: [{ name: 'x', label: 'X' }],
      fields: [{ name: 'x', label: 'X', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    assert.throws(
      () =>
        defineRelationManager({
          name: 'r',
          label: 'R',
          related,
          foreignKey: '',
          list: async () => ({ rows: [], total: 0 }),
        }),
      AdminDefinitionError,
    );
  });

  it('renderRelationManager escapes related cell values', () => {
    const related = defineResource({
      slug: 'r2',
      label: 'R2',
      columns: [{ name: 'x', label: 'X' }],
      fields: [{ name: 'x', label: 'X', type: 'text' }],
      list: async () => ({ rows: [], total: 0 }),
    });
    const rm = defineRelationManager({
      name: 'r2',
      label: 'R2',
      related,
      foreignKey: 'p',
      list: async () => ({ rows: [], total: 0 }),
    });
    const html = renderRelationManager(rm, [{ id: '1', x: '<script>' }], 'p1', {
      panelPath: '/admin',
      resourceSlug: 'test',
      csrfToken: 'csrf-test',
    });
    // Preact entity-encodes `<` and `&` in text content; `>` is safe in
    // non-attribute contexts and may remain literal. Verify the critical
    // guard: the raw `<script>` tag is never emitted.
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script/);
  });
});
