/**
 * The signed-URL capability of the `Disk` contract: the structural guard, the
 * lifetime bounds, and `diskUrl`'s delegation to a capable disk and value-free
 * refusal of one without the capability.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DiskError, isDisk, type Disk } from '../../src/filesystem/disk.js';
import {
  DISK_URL_DEFAULT_EXPIRES_IN,
  DISK_URL_MAX_EXPIRES_IN,
  diskUrl,
  isUrlDisk,
  type DiskUrlOptions,
  type UrlDisk,
} from '../../src/filesystem/signed-url.js';

/** A base disk that stores nothing: the capability checks only read its shape. */
function baseDisk(): Disk {
  return {
    put: () => Promise.resolve(),
    get: () => Promise.reject(new DiskError('not_found', 'file not found')),
    exists: () => Promise.resolve(false),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    size: () => Promise.reject(new DiskError('not_found', 'file not found')),
  };
}

describe('disk URL capability', () => {
  it('bounds the lifetime at 15 minutes by default and 7 days at most', () => {
    assert.equal(DISK_URL_DEFAULT_EXPIRES_IN, 15 * 60);
    assert.equal(DISK_URL_MAX_EXPIRES_IN, 7 * 24 * 60 * 60);
  });

  it('isUrlDisk reads the shape, and a URL disk is still a disk', () => {
    const plain = baseDisk();
    const signing: UrlDisk = { ...baseDisk(), url: () => Promise.resolve('https://x.test/') };
    assert.equal(isUrlDisk(plain), false);
    assert.equal(isUrlDisk(signing), true);
    assert.equal(isDisk(signing), true);
  });

  it('diskUrl delegates the key and options to a capable disk', async () => {
    const calls: [string, DiskUrlOptions | undefined][] = [];
    const signing: UrlDisk = {
      ...baseDisk(),
      url: (key, options) => {
        calls.push([key, options]);
        return Promise.resolve(`https://store.test/${key}`);
      },
    };
    const options: DiskUrlOptions = { expiresIn: 60, disposition: 'inline' };
    assert.equal(await diskUrl(signing, 'a/b.png', options), 'https://store.test/a/b.png');
    assert.deepEqual(calls, [['a/b.png', options]]);
  });

  it('diskUrl refuses a disk without the capability with a value-free unsupported error', async () => {
    await assert.rejects(diskUrl(baseDisk(), 'private/secret.txt'), (error: unknown) => {
      assert.ok(error instanceof DiskError);
      assert.equal(error.code, 'unsupported');
      assert.doesNotMatch(error.message, /private|secret/);
      return true;
    });
  });
});
