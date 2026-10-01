/**
 * The strict page serializer: the allow-list, fail-closed rejection with the
 * prop path, `$bigint` encoding (P-7 `preserveBigIntegers`), and a seeded
 * property test that @inertiajs/core 3.11.0's own `parsePage` reads back
 * exactly the expected value.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePage } from '@inertiajs/core/json';

import { always, InertiaError, serializePage, type InertiaPageObject } from '../../src/index.js';

function page(
  props: Record<string, unknown>,
  extra: Partial<InertiaPageObject> = {},
): InertiaPageObject {
  return { component: 'Test', props: { errors: {}, ...props }, url: '/t', version: 'v', ...extra };
}

function rejectsAt(path: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof InertiaError);
    assert.equal(error.code, 'unserializable_prop');
    assert.equal(error.message, 'an Inertia prop holds a value that is not plain JSON data');
    assert.deepEqual(error.context, { path });
    return true;
  };
}

describe('serializePage allow-list', () => {
  it('serializes plain data in page-object order', () => {
    assert.equal(
      serializePage(page({ n: 1, s: 'x', b: true, z: null, list: [1, 'a'], o: { k: 'v' } })),
      '{"component":"Test","props":{"errors":{},"n":1,"s":"x","b":true,"z":null,"list":[1,"a"],"o":{"k":"v"}},"url":"/t","version":"v"}',
    );
  });

  it('sends a valid Date as ISO-8601', () => {
    const json = serializePage(page({ at: new Date(Date.UTC(2026, 10, 19, 12)) }));
    assert.match(json, /"at":"2026-11-19T12:00:00\.000Z"/);
  });

  it('encodes bigint as a $bigint marker and sets preserveBigIntegers', () => {
    const json = serializePage(page({ id: 9007199254740993n }));
    assert.match(json, /"id":\{"\$bigint":"9007199254740993"\}/);
    const parsed = parsePage(json);
    assert.equal(parsed.preserveBigIntegers, true);
    assert.equal(parsed.props['id'], 9007199254740993n);
    assert.equal(JSON.parse(serializePage(page({ id: 1 }))).preserveBigIntegers, undefined);
  });

  it('drops undefined object keys and sends undefined array items as null', () => {
    assert.match(
      serializePage(page({ a: undefined, list: [undefined, 1] })),
      /"props":\{"errors":\{\},"list":\[null,1\]\}/,
    );
  });

  it('accepts null-prototype objects, shared references, and dotted error keys', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { k: 1 });
    const shared = { id: 1 };
    const json = serializePage({
      component: 'T',
      props: { errors: { 'user.tags.2': 'Too long' }, bare, left: shared, right: shared },
      url: '/',
      version: '',
    });
    assert.match(
      json,
      /"errors":\{"user\.tags\.2":"Too long"\},"bare":\{"k":1\},"left":\{"id":1\},"right":\{"id":1\}/,
    );
  });
});

describe('serializePage rejections (fail closed, value-free, with the path)', () => {
  class UserRecord {
    id = 1;
    passwordHash = 'secret-hash';
  }

  it('rejects class instances such as ORM records', () => {
    assert.throws(
      () => serializePage(page({ user: new UserRecord() })),
      (error: unknown) => {
        rejectsAt('props.user')(error);
        assert.equal(String(error).includes('secret-hash'), false);
        return true;
      },
    );
  });

  it('rejects Map, Set, functions, symbols, URLs, boxed and toJSON values', () => {
    const cases: readonly [unknown, string][] = [
      [new Map([['a', 1]]), 'props.v'],
      [new Set([1]), 'props.v'],
      [() => 1, 'props.v'],
      [Symbol('s'), 'props.v'],
      [new URL('https://example.test'), 'props.v'],
      [Object('boxed'), 'props.v'],
      [{ toJSON: () => 'x' }, 'props.v.toJSON'],
      [[1, new Map()], 'props.v.1'],
    ];
    for (const [value, path] of cases) {
      assert.throws(() => serializePage(page({ v: value })), rejectsAt(path));
    }
  });

  it('rejects non-finite numbers and invalid dates', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, new Date('nope')]) {
      assert.throws(() => serializePage(page({ deep: { v: value } })), rejectsAt('props.deep.v'));
    }
  });

  it('rejects cycles, unresolved descriptors, and subclassed arrays', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    assert.throws(() => serializePage(page({ c: cyclic })), rejectsAt('props.c.self'));
    assert.throws(() => serializePage(page({ d: always(1) })), rejectsAt('props.d'));
    class List extends Array<number> {}
    assert.throws(() => serializePage(page({ l: List.from([1]) })), rejectsAt('props.l'));
  });

  it('rejects prototype keys and user $bigint keys', () => {
    const tainted = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    assert.throws(() => serializePage(page({ t: tainted })), rejectsAt('props.t.__proto__'));
    assert.throws(
      () => serializePage(page({ m: { $bigint: '12' } })),
      rejectsAt('props.m.$bigint'),
    );
  });

  it('checks flash as strictly as props', () => {
    assert.throws(
      () => serializePage(page({}, { flash: { user: new Map() } })),
      rejectsAt('flash.user'),
    );
  });
});

// ---------------------------------------------------------------------------
// Property test against @inertiajs/core/json parsePage
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRINGS = ['', 'plain', '</script>', '<!--', '  ', '"quoted"', '\\', '😀', 'a/b', '$bigint'];

/** A random value and what the client must read back for it. */
function generate(random: () => number, depth: number): { value: unknown; expected: unknown } {
  const roll = random();
  if (depth < 4 && roll < 0.2) {
    const value: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    const size = Math.floor(random() * 4);
    for (let index = 0; index < size; index += 1) {
      const key = `${STRINGS[Math.floor(random() * 8)] ?? 'k'}${index}`;
      const child = generate(random, depth + 1);
      value[key] = child.value;
      if (child.value !== undefined) expected[key] = child.expected;
    }
    return { value, expected };
  }
  if (depth < 4 && roll < 0.35) {
    const size = Math.floor(random() * 4);
    const items = Array.from({ length: size }, () => generate(random, depth + 1));
    return {
      value: items.map((item) => item.value),
      expected: items.map((item) => (item.value === undefined ? null : item.expected)),
    };
  }
  if (roll < 0.45) {
    const date = new Date(Math.floor(random() * 4_102_444_800_000));
    return { value: date, expected: date.toISOString() };
  }
  if (roll < 0.55) {
    const big = BigInt(Math.floor(random() * 1e15)) * 1_000_000_007n - 5n;
    return { value: big, expected: big };
  }
  if (roll < 0.62) return { value: undefined, expected: undefined };
  if (roll < 0.7) return { value: null, expected: null };
  if (roll < 0.78) {
    const flag = random() < 0.5;
    return { value: flag, expected: flag };
  }
  if (roll < 0.88) {
    const number = (random() - 0.5) * 1e6;
    return { value: number, expected: number };
  }
  const text = STRINGS[Math.floor(random() * STRINGS.length)] ?? '';
  return { value: text, expected: text };
}

describe('serializer property test (@inertiajs/core 3.11.0 parsePage)', () => {
  it('round-trips random plain data to the expected client value', () => {
    const SEED = 0x5e71_2026;
    const random = prng(SEED);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const { value, expected } = generate(random, 0);
      const json = serializePage(page({ v: value }));
      const parsed = parsePage(json);
      const label = `seed ${SEED} iteration ${iteration}`;
      if (value === undefined) {
        assert.equal(Object.hasOwn(parsed.props, 'v'), false, label);
      } else {
        assert.deepEqual(parsed.props['v'], expected, label);
      }
    }
  });
});
