/**
 * The `Disk` shape guard and the `disk.*` registry: every method is required,
 * and codes are domain-qualified and value-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDisk } from '../../src/filesystem/disk.js';
import { DiskErrors } from '../../src/filesystem/disk-errors.js';

const noop = (): Promise<never> => Promise.reject(new Error('unused'));

describe('isDisk', () => {
  it('requires all six methods', () => {
    const disk = {
      write: noop,
      read: noop,
      stat: noop,
      delete: noop,
      deletePrefix: noop,
      list: noop,
    };
    assert.equal(isDisk(disk), true);
    for (const method of Object.keys(disk)) {
      const partial: Record<string, unknown> = { ...disk };
      delete partial[method];
      assert.equal(isDisk(partial), false, method);
    }
    assert.equal(isDisk(null), false);
    assert.equal(isDisk('disk'), false);
  });
});

describe('DiskErrors', () => {
  it('qualifies codes with the disk domain and names only the operation', () => {
    const cause = new Error('EACCES: permission denied, open /secret/path');
    const error = new DiskErrors.Error('io_failed', { operation: 'write' }, { cause });
    assert.equal(error.code, 'disk.io_failed');
    assert.equal(error.message, 'the disk write failed');
    assert.equal(error.cause, cause);
    assert.ok(DiskErrors.is(error, 'io_failed'));
    assert.equal(DiskErrors.is(error, 'not_found'), false);
  });
});
