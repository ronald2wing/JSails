/**
 * `copyJson` tests: plain JSON is copied and deep-frozen; anything that would
 * not survive a JSON round trip is refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_JSON_DEPTH,
  copyJson,
  isJsonValue,
  isPlainObject,
} from '../../src/content/json-value.js';

describe('copyJson', () => {
  it('copies and deep-freezes plain JSON', () => {
    const source = { a: [1, 'two', null, true, { b: 2 }], c: { d: [] } };
    const copy = copyJson(source);
    assert.deepEqual(copy, source);
    assert.notEqual(copy, source);
    assert.ok(Object.isFrozen(copy));
    assert.ok(Object.isFrozen((copy as { a: unknown[] }).a[4]));
  });

  it('keeps a __proto__ key as data instead of setting the prototype', () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const copy = copyJson(source) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(copy), Object.prototype);
    assert.deepEqual(Object.keys(copy), ['__proto__']);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('refuses values JSON would mangle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      () => 1,
      Symbol('s'),
      new Date(0),
      new Map(),
      cyclic,
      { nested: [undefined] },
    ]) {
      assert.equal(copyJson(value), undefined);
      assert.equal(isJsonValue(value), false);
    }
  });

  it('allows a shared (non-cyclic) reference and refuses excessive depth', () => {
    const shared = { x: 1 };
    assert.deepEqual(copyJson([shared, shared]), [{ x: 1 }, { x: 1 }]);
    let deep: unknown = 1;
    for (let index = 0; index <= MAX_JSON_DEPTH + 1; index += 1) deep = [deep];
    assert.equal(copyJson(deep), undefined);
  });

  it('recognizes plain objects only', () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject(Object.create(null)), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(new Date()), false);
  });
});
