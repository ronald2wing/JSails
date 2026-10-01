/**
 * Tests for the island id rule and the island props codec both sides share: an id is a bounded path of letters, digits and `_ $ . -` segments that no object carries as a name; decoding returns `{}` for an absent marker and a plain object within the length, depth and key bounds, refuses prototype keys at any depth and never evaluates a value; encoding refuses what JSON cannot carry and returns the decoded copy the server renders from. Errors are `island.*` registry codes that echo nothing of the input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeIslandProps,
  encodeIslandProps,
  isIslandId,
  IslandErrors,
  MAX_ISLAND_PROPS_LENGTH,
} from '../../src/view/island-props.js';

/** Asserts `run` throws the island error `code`, and that its message holds no input. */
function throwsCode(run: () => unknown, code: string, input = ''): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(IslandErrors.is(error), 'an island registry error');
    assert.equal(error.code, `island.${code}`);
    if (input !== '')
      assert.equal(error.message.includes(input), false, 'the message echoes input');
    return true;
  });
}

describe('isIslandId', () => {
  it('accepts a bounded path of letters, digits and _ $ . - segments', () => {
    for (const id of ['counter', 'admin/user-card', 'a.b/c_d/$e', 'x'.repeat(200)]) {
      assert.equal(isIslandId(id), true, id);
    }
  });

  it('refuses any other id, a name every object has, and a non-string', () => {
    for (const id of [
      '',
      '/a',
      'a//b',
      '(marketing)/cta',
      '@shop/cart',
      'café',
      'constructor',
      '__proto__',
      'x'.repeat(201),
      1,
      null,
    ]) {
      assert.equal(isIslandId(id), false, String(id));
    }
  });
});

describe('decodeIslandProps', () => {
  it('returns an empty object for an absent or empty marker', () => {
    assert.deepEqual(decodeIslandProps(null), {});
    assert.deepEqual(decodeIslandProps(undefined), {});
    assert.deepEqual(decodeIslandProps(''), {});
  });

  it('decodes a plain object', () => {
    assert.deepEqual(decodeIslandProps('{"a":1,"b":[true,null,"x"],"c":{"d":"e"}}'), {
      a: 1,
      b: [true, null, 'x'],
      c: { d: 'e' },
    });
  });

  it('refuses invalid JSON without echoing it', () => {
    throwsCode(() => decodeIslandProps('{"secret-token'), 'props_unparseable', 'secret-token');
  });

  it('refuses a top level that is not a plain object', () => {
    for (const raw of ['[1,2]', '42', '"str"', 'null', 'true']) {
      throwsCode(() => decodeIslandProps(raw), 'props_invalid');
    }
  });

  it('refuses prototype keys at any depth, and keeps them as values', () => {
    throwsCode(() => decodeIslandProps('{"__proto__":{}}'), 'props_invalid');
    throwsCode(() => decodeIslandProps('{"ok":true,"constructor":1}'), 'props_invalid');
    throwsCode(() => decodeIslandProps('{"list":[{"prototype":{}}]}'), 'props_invalid');
    assert.deepEqual(decodeIslandProps('{"name":"__proto__"}'), { name: '__proto__' });
  });

  it('bounds the length, the depth and the key count', () => {
    throwsCode(
      () => decodeIslandProps(JSON.stringify({ x: 'a'.repeat(MAX_ISLAND_PROPS_LENGTH) })),
      'props_too_large',
    );
    let deep = '1';
    for (let level = 0; level < 40; level += 1) deep = `{"x":${deep}}`;
    throwsCode(() => decodeIslandProps(deep), 'props_too_large');
    const wide = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`k${index}`, 0]));
    throwsCode(() => decodeIslandProps(JSON.stringify(wide)), 'props_too_large');
  });

  it('never evaluates a value', () => {
    assert.deepEqual(decodeIslandProps('{"x":"<script>alert(1)</script>"}'), {
      x: '<script>alert(1)</script>',
    });
  });
});

describe('encodeIslandProps', () => {
  it('returns the marker text and the copy the browser will decode', () => {
    const when = new Date(0);
    const { text, decoded } = encodeIslandProps({ count: 2, when, skip: undefined });
    assert.equal(text, '{"count":2,"when":"1970-01-01T00:00:00.000Z"}');
    assert.deepEqual(decoded, { count: 2, when: '1970-01-01T00:00:00.000Z' });
  });

  it('refuses what JSON cannot carry', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    throwsCode(() => encodeIslandProps(cycle), 'props_unserializable');
    throwsCode(() => encodeIslandProps({ n: 1n }), 'props_unserializable');
  });

  it('refuses what the browser would refuse', () => {
    throwsCode(
      () => encodeIslandProps(JSON.parse('{"__proto__":{"x":1}}') as object),
      'props_invalid',
    );
  });
});
