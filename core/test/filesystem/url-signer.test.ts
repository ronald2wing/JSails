/**
 * The signed-URL interface: a structural guard, separate from `Disk`, and the
 * 7-day lifetime ceiling.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDisk } from '../../src/filesystem/disk.js';
import { isDiskUrlSigner, SIGNED_URL_MAX_EXPIRES_IN_MS } from '../../src/filesystem/url-signer.js';

describe('DiskUrlSigner', () => {
  it('is recognized by shape and is not a disk', () => {
    const signer = { signedUrl: () => Promise.resolve('https://store.test/a') };
    assert.equal(isDiskUrlSigner(signer), true);
    assert.equal(isDisk(signer), false);
    assert.equal(isDiskUrlSigner({}), false);
    assert.equal(isDiskUrlSigner(null), false);
  });

  it('caps lifetimes at the SigV4 maximum of 7 days', () => {
    assert.equal(SIGNED_URL_MAX_EXPIRES_IN_MS, 604_800_000);
  });
});
