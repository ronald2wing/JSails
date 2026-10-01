/**
 * Tests for hostname normalisation: the committed vector table, idempotence
 * as a seeded property, and the within-domain relation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isHostnameWithin, normalizeHostname } from '../src/hostname.js';
import { HOSTNAME_VECTORS } from './naming-vectors.js';
import { seededPrng } from './seeded-prng.js';

describe('normalizeHostname', () => {
  for (const [input, expected, why] of HOSTNAME_VECTORS) {
    it(`${why}`, () => {
      assert.equal(normalizeHostname(input), expected);
    });
  }

  it('refuses non-string input', () => {
    assert.equal(normalizeHostname(42 as unknown as string), null);
  });

  it('is idempotent over random hosts (seeded property)', () => {
    const random = seededPrng(0x7e4a);
    const alphabet = 'abcXYZ019-._:äßü*%@ 。';
    for (let i = 0; i < 5000; i += 1) {
      const input = random.string(alphabet, 1 + random.int(24));
      const once = normalizeHostname(input);
      if (once !== null) {
        assert.equal(normalizeHostname(once), once, `seed 0x7e4a step ${i}`);
        assert.match(once, /^[a-z0-9.-]+$/);
        assert.ok(once.length <= 253);
      }
    }
  });
});

describe('isHostnameWithin', () => {
  it('holds for the name itself and its subdomains only', () => {
    assert.equal(isHostnameWithin('example.com', 'example.com'), true);
    assert.equal(isHostnameWithin('a.example.com', 'example.com'), true);
    assert.equal(isHostnameWithin('notexample.com', 'example.com'), false);
    assert.equal(isHostnameWithin('example.com', 'a.example.com'), false);
  });
});
