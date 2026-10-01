/**
 * The shared JSON scanner and canonical serialization.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_JSON_DEPTH, canonicalJson, scanJson } from '../../src/wire/json-scan.js';

describe('scanJson', () => {
  it('accepts plain JSON values', () => {
    for (const value of [null, true, 0, 'x', [], {}, { a: [1, { b: null }] }]) {
      assert.equal(scanJson(value), null);
    }
  });

  it('names the first violation', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = 0;
    for (let index = 0; index <= MAX_JSON_DEPTH; index += 1) {
      deep = [deep];
    }
    assert.equal(scanJson(deep), 'depth');
    assert.equal(scanJson({ n: Number.POSITIVE_INFINITY }), 'non-finite');
    assert.equal(scanJson(new Date()), 'non-plain');
    assert.equal(scanJson(JSON.parse('{"__proto__":1}')), 'forbidden-key');
    assert.equal(scanJson(cycle), 'circular');
    assert.equal(scanJson({ f: () => 1 }), 'non-json');
  });

  it('accepts a shared (non-cyclic) reference', () => {
    const shared = { a: 1 };
    assert.equal(scanJson({ x: shared, y: shared }), null);
  });
});

describe('canonicalJson', () => {
  it('serializes equal values alike, whatever their key order', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }),
      canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }),
    );
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  it('distinguishes different values', () => {
    assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
    assert.notEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
  });
});
