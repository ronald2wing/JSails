/**
 * Tests for canonical param serialization.
 *
 * `canonicalParams` must serialize two structurally equal params objects to the
 * same string regardless of key insertion order, number formatting, or nesting,
 * or equal param sets fail to share a multiplexer driver and fan-out collapses
 * to `O(subscriptions)` (LIVE-PLAN.md §4.7, §10).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalParams } from '../../src/live/canonical-params.js';

describe('canonicalParams', () => {
  it('is deterministic across key insertion order', () => {
    const a = canonicalParams({ alpha: 1, beta: 2 });
    const b = canonicalParams({ beta: 2, alpha: 1 });
    assert.equal(a, b);
  });

  it('distinguishes values that differ by type', () => {
    assert.notEqual(canonicalParams({ n: 1 }), canonicalParams({ n: '1' }));
  });

  it('normalizes numbers consistently regardless of formatting', () => {
    assert.equal(canonicalParams({ n: 1 }), canonicalParams({ n: 1 }));
    assert.equal(canonicalParams({ n: 1.0 }), canonicalParams({ n: 1 }));
    // Integer-valued floats and integers share a canonical form.
    assert.equal(canonicalParams({ n: 2 }), canonicalParams({ n: 2.0 }));
  });

  it('serializes nested objects deterministically', () => {
    const a = canonicalParams({ outer: { inner: { x: 1, y: 2 } } });
    const b = canonicalParams({ outer: { inner: { y: 2, x: 1 } } });
    assert.equal(a, b);
  });

  it('serializes arrays order-sensitively', () => {
    assert.notEqual(canonicalParams({ list: [1, 2] }), canonicalParams({ list: [2, 1] }));
  });

  it('produces a length-prefixed string stable against value ambiguities', () => {
    const value = { id: 42, tags: ['a', 'b'] };
    const canonical = canonicalParams(value);
    const colon = canonical.indexOf(':');
    assert.notEqual(colon, -1);
    const length = Number(canonical.slice(0, colon));
    const body = canonical.slice(colon + 1);
    assert.equal(body.length, length, 'the prefix is the byte length of the body');
  });

  it('handles null, boolean, and string scalars distinctly', () => {
    assert.notEqual(canonicalParams({ v: null }), canonicalParams({ v: false }));
    assert.notEqual(canonicalParams({ v: false }), canonicalParams({ v: true }));
    assert.notEqual(canonicalParams({ v: 'x' }), canonicalParams({ v: 'y' }));
  });
});
