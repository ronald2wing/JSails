/**
 * Tests for the action descriptors: `defineAdminAction` validation and the
 * replicate/restore/import wrappers that share it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  defineAdminAction,
  defineImportAction,
  defineReplicateAction,
  defineRestoreAction,
} from '../src/index.js';

describe('admin action descriptor validation', () => {
  it('rejects an invalid name, empty label, or missing run', () => {
    assert.throws(() => defineAdminAction({ name: 'bad/name', label: 'x', run: () => {} }));
    assert.throws(() => defineAdminAction({ name: 'ok', label: '  ', run: () => {} }));
    assert.throws(() =>
      defineAdminAction({
        name: 'ok',
        label: 'x',
        // @ts-expect-error — a missing `run` must be rejected at runtime.
        run: undefined,
      }),
    );
  });

  it('freezes a valid descriptor', () => {
    const action = defineAdminAction({ name: 'ok', label: 'OK', run: () => {} });
    assert.equal(Object.isFrozen(action), true);
    assert.equal(action.name, 'ok');
    assert.equal(action.label, 'OK');
  });
});

describe('replicate/restore/import actions', () => {
  it('defineReplicateAction defaults its label and confirm', () => {
    const a = defineReplicateAction({ name: 'replicate', run: () => {} });
    assert.equal(a.label, 'Replicate');
    assert.equal(typeof a.confirm, 'string');
  });

  it('defineRestoreAction preserves an explicit label', () => {
    const a = defineRestoreAction({ name: 'restore', label: 'Bring back', run: () => {} });
    assert.equal(a.label, 'Bring back');
  });

  it('rejects an invalid name through the shared validator', () => {
    assert.throws(
      () => defineImportAction({ name: 'bad name', run: () => {} }),
      AdminDefinitionError,
    );
  });
});
