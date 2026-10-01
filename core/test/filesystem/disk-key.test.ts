/**
 * The disk key rules: relative `/`-separated paths, the same on every disk and
 * platform, refused value-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DiskErrors } from '../../src/filesystem/disk-errors.js';
import { assertDiskKey, assertDiskPrefix, isDiskKey } from '../../src/filesystem/disk-key.js';

const BAD_KEYS = [
  '',
  '/etc/passwd',
  '../escape',
  'a/../b',
  'a/./b',
  'a//b',
  'trailing/',
  'back\\slash',
  'C:drive',
  'nul\u0000byte',
  'line\nbreak',
  'c1\u0085control',
  'x'.repeat(1025),
];

describe('disk keys', () => {
  it('accepts relative slash-separated keys', () => {
    for (const key of ['a', 'media/2026/logo.png', '.hidden/file', 'a b/ü.txt', 'x'.repeat(1024)]) {
      assert.equal(isDiskKey(key), true, key);
      assertDiskKey(key);
    }
  });

  it('refuses every malformed key without echoing it', () => {
    for (const key of BAD_KEYS) {
      assert.equal(isDiskKey(key), false);
      assert.throws(
        () => assertDiskKey(key),
        (error: unknown) => {
          assert.ok(DiskErrors.is(error, 'invalid_key'));
          assert.ok(key === '' || !(error as Error).message.includes(key));
          return true;
        },
      );
    }
    assert.equal(isDiskKey(42), false);
  });

  it('accepts the empty prefix and otherwise applies the key rules', () => {
    assertDiskPrefix('');
    assertDiskPrefix('media');
    assert.throws(
      () => assertDiskPrefix('/media'),
      (error: unknown) => DiskErrors.is(error, 'invalid_key'),
    );
  });
});
