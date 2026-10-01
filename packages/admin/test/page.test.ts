/**
 * Tests for `defineAdminPage`: slug, label, and render validation plus the
 * frozen descriptor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminDefinitionError, defineAdminPage } from '../src/index.js';

describe('defineAdminPage validation', () => {
  it('rejects an invalid slug', () => {
    for (const slug of ['', 'a/b', 'a b', '.hidden', '-lead', 'trail-']) {
      assert.throws(
        () => defineAdminPage({ slug, label: 'X', render: () => 'x' }),
        AdminDefinitionError,
        `slug ${JSON.stringify(slug)} must be rejected`,
      );
    }
  });

  it('rejects a missing or empty label', () => {
    assert.throws(
      () => defineAdminPage({ slug: 'x', label: '', render: () => 'x' }),
      AdminDefinitionError,
    );
  });

  it('rejects a missing render function', () => {
    assert.throws(() => defineAdminPage({ slug: 'x', label: 'X' } as never), AdminDefinitionError);
  });

  it('returns a frozen descriptor', () => {
    const page = defineAdminPage({ slug: 'x', label: 'X', render: () => 'x' });
    assert.equal(Object.isFrozen(page), true);
    assert.equal(page.slug, 'x');
  });
});
