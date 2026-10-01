/**
 * Tests for the attach/detach actions: defaulted names and labels, the
 * `requiresParent` marker, the parent id and related ids handed to the
 * callback, and the value-free error when a run arrives without a parent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  defineAttachAction,
  defineDetachAction,
  defineRelationManager,
  defineResource,
  type RelationManager,
} from '../src/index.js';
import { SESSION } from './fixtures.js';

function defineTagsManager(): RelationManager {
  const related = defineResource({
    slug: 'tags',
    label: 'Tags',
    columns: [{ name: 'name', label: 'Name' }],
    fields: [{ name: 'name', label: 'Name', type: 'text' }],
    list: async () => ({ rows: [], total: 0 }),
  });
  return defineRelationManager({
    name: 'tags',
    label: 'Tags',
    related,
    foreignKey: 'postId',
    list: async () => ({ rows: [], total: 0 }),
  });
}

describe('attach/detach actions', () => {
  it('defineAttachAction defaults name/label and calls attach with the parent and record ids', async () => {
    const seen: Array<{ parentId: string; relatedIds: readonly string[] }> = [];
    const action = defineAttachAction({
      manager: defineTagsManager(),
      attach: async ({ parentId, relatedIds }) => {
        seen.push({ parentId, relatedIds: [...relatedIds] });
      },
    });
    assert.equal(action.name, 'attach');
    assert.equal(action.label, 'Attach');
    assert.equal(action.requiresParent, true);
    await action.run({ session: SESSION, path: '/admin', parentId: 'p1' }, [
      { id: 't1' },
      { id: 't2' },
    ]);
    assert.deepEqual(seen, [{ parentId: 'p1', relatedIds: ['t1', 't2'] }]);
  });

  it('defineDetachAction defaults its name and label', () => {
    const action = defineDetachAction({ manager: defineTagsManager(), detach: async () => {} });
    assert.equal(action.name, 'detach');
    assert.equal(action.label, 'Detach');
    assert.equal(action.requiresParent, true);
  });

  it('rejects a run without a parent id', async () => {
    const action = defineAttachAction({ manager: defineTagsManager(), attach: async () => {} });
    await assert.rejects(
      async () => action.run({ session: SESSION, path: '/admin' }, [{ id: 't1' }]),
      (error: unknown) => error instanceof AdminDefinitionError && error.code === 'missing_parent',
    );
  });

  it('rejects a missing manager or callback', () => {
    assert.throws(
      () => defineAttachAction({ manager: defineTagsManager(), attach: undefined as never }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineDetachAction({ manager: undefined as never, detach: async () => {} }),
      AdminDefinitionError,
    );
  });
});
