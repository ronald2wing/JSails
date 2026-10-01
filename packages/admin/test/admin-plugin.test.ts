/**
 * Tests for `defineAdminPlugin`: id and register validation plus the frozen
 * descriptor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminDefinitionError, defineAdminPlugin } from '../src/index.js';

describe('defineAdminPlugin validation', () => {
  it('rejects a missing id', () => {
    assert.throws(() => defineAdminPlugin({ register: () => {} } as never), AdminDefinitionError);
  });

  it('rejects a missing register function', () => {
    assert.throws(() => defineAdminPlugin({ id: 'x' } as never), AdminDefinitionError);
  });

  it('returns a frozen descriptor', () => {
    const plugin = defineAdminPlugin({ id: 'x', register: () => {} });
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(plugin.id, 'x');
  });
});
