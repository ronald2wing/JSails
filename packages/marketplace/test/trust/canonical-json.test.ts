import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, MarketplaceConfigErrors } from '../../src/trust/index.js';

function refused(value: unknown, problem: string): void {
  assert.throws(
    () => canonicalJson(value),
    (error: unknown) =>
      MarketplaceConfigErrors.is(error, 'not_canonical') && error.context.problem === problem,
  );
}

describe('canonicalJson', () => {
  it('sorts members by UTF-16 code units and drops whitespace', () => {
    assert.equal(
      canonicalJson({ b: 1, a: [true, null, 'x'], A: {} }),
      '{"A":{},"a":[true,null,"x"],"b":1}',
    );
  });

  it('orders keys by UTF-16 code units, not code points (RFC 8785)', () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFFD.
    assert.equal(
      canonicalJson({ '\ufffd': 1, '\ud83d\ude00': 2, '\u20ac': 3 }),
      '{"\u20ac":3,"\ud83d\ude00":2,"\ufffd":1}',
    );
  });

  it('escapes strings as JSON.stringify does', () => {
    const text = 'quote " backslash \\ tab \t control \u001f line \u2028 e\u0301';
    assert.equal(canonicalJson(text), JSON.stringify(text));
  });

  it('writes safe integers, and -0 as 0', () => {
    assert.equal(
      canonicalJson([0, -0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]),
      '[0,0,1,-1,9007199254740991,-9007199254740991]',
    );
  });

  it('accepts null-prototype objects and nesting to 32 levels', () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { z: 1, a: 2 });
    assert.equal(canonicalJson(record), '{"a":2,"z":1}');
    let nested: unknown = 1;
    for (let depth = 0; depth < 32; depth += 1) nested = [nested];
    assert.equal(canonicalJson(nested), `${'['.repeat(32)}1${']'.repeat(32)}`);
    refused([nested], 'depth');
  });

  it('refuses numbers that are not safe integers', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
      refused(value, 'number');
  });

  it('refuses lone surrogates in strings and keys', () => {
    refused('\ud800', 'string');
    refused({ '\udc00': 1 }, 'string');
  });

  it('refuses undefined, holes and values JSON has no form for', () => {
    refused(undefined, 'undefined');
    refused({ a: undefined }, 'undefined');
    const holey: unknown[] = [1];
    holey[2] = 2;
    refused(holey, 'undefined');
    for (const value of [
      new Date(0),
      new Map(),
      () => 1,
      Symbol('s'),
      1n,
      new (class Thing {})(),
    ]) {
      refused(value, 'type');
    }
  });
});
