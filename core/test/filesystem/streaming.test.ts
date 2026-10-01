/**
 * The streaming capability of the `Disk` contract: the structural guard needs
 * both `stream` and `putStream`, and range errors are value-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JsailsError } from '../../src/errors/jsails-error.js';
import type { Disk } from '../../src/filesystem/disk.js';
import { DiskRangeError, isStreamingDisk } from '../../src/filesystem/streaming.js';

function baseDisk(): Disk {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(new Uint8Array()),
    exists: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    size: () => Promise.resolve(0),
  };
}

describe('streaming disk capability', () => {
  it('requires both stream and putStream', () => {
    const stream = () => Promise.reject(new Error('unused'));
    assert.equal(isStreamingDisk(baseDisk()), false);
    assert.equal(isStreamingDisk({ ...baseDisk(), stream } as Disk), false);
    assert.equal(isStreamingDisk({ ...baseDisk(), stream, putStream: stream } as Disk), true);
  });

  it('DiskRangeError carries a code and is a JsailsError', () => {
    const error = new DiskRangeError('invalid_range', 'range starts past the end of the file');
    assert.ok(error instanceof JsailsError);
    assert.equal(error.code, 'invalid_range');
  });
});
