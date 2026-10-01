/**
 * The asset version hash (P-15 Asset Versioning; clause numbering as in
 * props.test.ts): determinism, the canonical encoding, and the collision pairs
 * the previous concatenating hash could not tell apart.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { InertiaError, inertiaVersion } from '../../src/index.js';

describe('inertiaVersion', () => {
  it('is sha256 over the sorted [key, value] pairs as JSON, base64url, 16 characters', () => {
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          ['app.css', 'def'],
          ['app.js', 'abc'],
        ]),
      )
      .digest('base64url')
      .slice(0, 16);
    assert.equal(inertiaVersion({ 'app.js': 'abc', 'app.css': 'def' }), expected);
    assert.match(expected, /^[A-Za-z0-9_-]{16}$/u);
  });

  it('ignores key order', () => {
    assert.equal(inertiaVersion({ a: '1', b: '2' }), inertiaVersion({ b: '2', a: '1' }));
  });

  it('separates keys from values and entries from each other', () => {
    const pairs: readonly [Record<string, string>, Record<string, string>][] = [
      [{ a: 'bc' }, { a: 'b', b: 'c' }],
      [{ a: 'bc' }, { ab: 'c' }],
      [{ 'app.js': 'h1' }, { 'main.js': 'h1' }],
      [
        { a: '', b: 'x' },
        { a: 'x', b: '' },
      ],
      [{ 'a","b': 'c' }, { a: 'b', c: '' }],
    ];
    for (const [left, right] of pairs) {
      assert.notEqual(inertiaVersion(left), inertiaVersion(right), JSON.stringify([left, right]));
    }
  });

  it('rejects a non-string value', () => {
    assert.throws(
      () => inertiaVersion({ a: 1 as unknown as string }),
      (error: unknown) => error instanceof InertiaError && error.code === 'invalid_options',
    );
  });
});
