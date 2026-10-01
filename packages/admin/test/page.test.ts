/**
 * Tests for `defineAdminPage`: slug, label, render, and form-cap validation
 * plus the frozen descriptor.
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

  it('takes a form cap from 1 byte to 100 MiB and refuses any other', () => {
    for (const maxBodyBytes of [0, -1, 1.5, 100 * 1024 * 1024 + 1, Number.NaN]) {
      assert.throws(
        () => defineAdminPage({ slug: 'x', label: 'X', render: () => 'x', maxBodyBytes }),
        AdminDefinitionError,
        `maxBodyBytes ${maxBodyBytes} must be rejected`,
      );
    }
    const page = defineAdminPage({ slug: 'x', label: 'X', render: () => 'x', maxBodyBytes: 5 });
    assert.equal(page.maxBodyBytes, 5);
  });

  it('returns a frozen descriptor', () => {
    const page = defineAdminPage({ slug: 'x', label: 'X', render: () => 'x' });
    assert.equal(Object.isFrozen(page), true);
    assert.equal(page.slug, 'x');
  });
});
