import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareVersions } from '../../src/directory/index.js';

describe('compareVersions', () => {
  it('orders stable versions by major, minor, then patch', () => {
    assert.equal(compareVersions('1.0.0', '2.0.0') < 0, true);
    assert.equal(compareVersions('1.10.0', '1.2.0') > 0, true);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('ranks a prerelease below its stable release', () => {
    assert.equal(compareVersions('1.0.0-beta', '1.0.0') < 0, true);
    assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0, true);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0, true);
  });

  it('sorts an invalid version after any valid version', () => {
    assert.equal(compareVersions('nope', '0.0.0') > 0, true);
    assert.equal(compareVersions('0.0.0', 'nope') < 0, true);
  });

  it('orders two invalid versions lexicographically', () => {
    assert.equal(compareVersions('abc', 'abd') < 0, true);
    assert.equal(compareVersions('z', 'a') > 0, true);
    assert.equal(compareVersions('same', 'same'), 0);
  });
});
