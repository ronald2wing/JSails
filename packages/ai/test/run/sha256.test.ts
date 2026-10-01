/**
 * `sha256Hex` against the FIPS 180-4 example vectors, every padding boundary,
 * and seeded random inputs cross-checked with `node:crypto`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../src/run/sha256.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 examples', () => {
    assert.equal(
      sha256Hex(new Uint8Array()),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
      sha256Hex(text('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
      sha256Hex(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    assert.equal(
      sha256Hex(text('a'.repeat(1_000_000))),
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with node:crypto at every length around the padding boundaries', () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 31 + length) & 0xff);
      assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'), `${length}`);
    }
  });

  it('agrees with node:crypto on seeded random inputs', () => {
    const random = mulberry32(0x5eed);
    for (let round = 0; round < 200; round += 1) {
      const bytes = new Uint8Array(Math.floor(random() * 5_000)).map(() =>
        Math.floor(random() * 256),
      );
      assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
