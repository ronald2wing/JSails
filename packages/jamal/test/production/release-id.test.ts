/**
 * Tests for release ids: their shape, their order, and the commit they name.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isReleaseId, RELEASE_SHA_LENGTH, releaseIdFor } from '../../src/production/release-id.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('releaseIdFor', () => {
  it('names the UTC second and the first twelve hex digits of the commit', () => {
    const at = new Date('2026-11-23T10:15:00.000+02:00');
    assert.equal(releaseIdFor(at, SHA), '20261123081500-0123456789ab');
    assert.equal(RELEASE_SHA_LENGTH, 12);
  });

  it('makes a redeploy of one commit a distinct release, sorted in the order made', () => {
    const ids = ['2026-11-23T10:00:09Z', '2026-11-23T10:00:10Z', '2026-12-01T00:00:00Z'].map((at) =>
      releaseIdFor(new Date(at), SHA),
    );
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual([...ids].sort(), ids);
  });

  it('writes the commit in lowercase, whatever case git printed', () => {
    assert.equal(
      releaseIdFor(new Date('2026-01-02T03:04:05Z'), SHA.toUpperCase()),
      '20260102030405-0123456789ab',
    );
  });
});

describe('isReleaseId', () => {
  it('accepts exactly the shape releaseIdFor makes', () => {
    assert.ok(isReleaseId(releaseIdFor(new Date(), SHA)));
    for (const bad of [
      '',
      'latest',
      'abcdef1',
      '20261123081500-0123456789a',
      '20261123081500-0123456789abc',
      '20261123081500-0123456789AB',
      '2026112308150-0123456789ab',
      '20261123081500_0123456789ab',
      '20261123081500-0123456789ab\n',
      '../20261123081500-0123456789ab',
    ]) {
      assert.equal(isReleaseId(bad), false, JSON.stringify(bad));
    }
  });
});
