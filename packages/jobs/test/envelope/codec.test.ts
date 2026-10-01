/**
 * The envelope codec: every built envelope survives serialization and decodes
 * to an equal value (a seeded property test), the decoder reports a newer
 * version apart from a malformed envelope and never throws, and the builder
 * refuses a value that serialization would change, without echoing it.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { JOB_ENVELOPE_VERSION, type JobEnvelope } from '../../src/contract/index.js';
import {
  buildEnvelope,
  decodeEnvelope,
  JobEnvelopeError,
  type EnvelopeParts,
} from '../../src/envelope/codec.js';
import { isPlainJson, MAX_JSON_DEPTH } from '../../src/envelope/plain-json.js';

/** mulberry32: a small seeded generator, so a failing case can be replayed from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function integer(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

const ALPHABET = ['a', 'Z', '0', ' ', ':', '"', '\\', '\n', 'é', '日', '\u{1F680}', '\u0000'];

function text(random: () => number, max = 12): string {
  let out = '';
  for (let length = integer(random, 0, max); length > 0; length -= 1) out += pick(random, ALPHABET);
  return out;
}

function nonEmptyText(random: () => number): string {
  return `k${text(random)}`;
}

function jsonValue(random: () => number, depth: number): unknown {
  const kind = depth > 3 ? integer(random, 0, 3) : integer(random, 0, 5);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return pick(random, [
        0,
        1,
        -1,
        0.5,
        -2.25,
        1e21,
        9_007_199_254_740_991,
        integer(random, -1e6, 1e6),
      ]);
    case 3:
      return text(random);
    case 4:
      return Array.from({ length: integer(random, 0, 4) }, () => jsonValue(random, depth + 1));
    default:
      return Object.fromEntries(
        Array.from({ length: integer(random, 0, 4) }, () => [
          text(random, 6),
          jsonValue(random, depth + 1),
        ]),
      );
  }
}

function randomParts(random: () => number): EnvelopeParts {
  const parts: Record<string, unknown> = {
    name: pick(random, ['report', 'mail.send', 'blog:publish', 'a-b_c']),
    payload: jsonValue(random, 0),
    options: {
      ...(random() < 0.5 ? {} : { attempts: integer(random, 1, 25) }),
      ...(random() < 0.5
        ? {}
        : {
            backoff: {
              type: pick(random, ['fixed', 'exponential'] as const),
              delayMs: integer(random, 0, 1e6),
            },
          }),
      ...(random() < 0.5 ? {} : { timeoutMs: integer(random, 1, 1e6) }),
      ...(random() < 0.5 ? {} : { priority: integer(random, 0, 2_097_152) }),
    },
    dispatchedAt: integer(random, 0, 2e12),
  };
  if (random() < 0.5)
    parts.key = { value: nonEmptyText(random), windowMs: integer(random, 1, 1e9) };
  if (random() < 0.5)
    parts.tags = Array.from({ length: integer(random, 1, 4) }, () => nonEmptyText(random));
  if (random() < 0.5) parts.context = jsonValue(random, 0);
  if (random() < 0.3) parts.overlap = { key: nonEmptyText(random), ttlMs: integer(random, 1, 1e7) };
  if (random() < 0.3) {
    parts.flow =
      random() < 0.5
        ? {
            kind: 'chain',
            id: nonEmptyText(random),
            step: integer(random, 0, 99),
            ...(random() < 0.5 ? {} : { catchFired: random() < 0.5 }),
          }
        : { kind: 'batch', id: nonEmptyText(random), index: integer(random, 0, 999) };
  }
  if (random() < 0.5) parts.runAt = integer(random, 0, 2e12);
  return parts as unknown as EnvelopeParts;
}

function maximal(): JobEnvelope {
  return buildEnvelope({
    name: 'report',
    payload: { id: 1 },
    options: { attempts: 3, backoff: { type: 'fixed', delayMs: 10 }, timeoutMs: 5, priority: 1 },
    key: { value: 'k', windowMs: 1_000 },
    tags: ['t'],
    context: { trace: 'x' },
    overlap: { key: 'o', ttlMs: 10 },
    flow: { kind: 'chain', id: 'c', step: 0, catchFired: false },
    runAt: 10,
    dispatchedAt: 1,
  });
}

/** A deep copy of `value` with `edit` applied, for building malformed envelopes. */
function edited(edit: (copy: Record<string, Record<string, unknown>>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(maximal())) as Record<string, Record<string, unknown>>;
  edit(copy);
  return copy;
}

describe('envelope codec', () => {
  test('every built envelope survives a JSON round trip and decodes to an equal value', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const parts = randomParts(seeded(seed));
      const built = buildEnvelope(parts);
      const stored: unknown = JSON.parse(JSON.stringify(built));
      const decoded = decodeEnvelope(stored);
      assert.ok(decoded.ok, `seed ${seed}: a built envelope did not decode`);
      assert.deepEqual(decoded.envelope, built, `seed ${seed}: the decoded envelope differs`);
      assert.deepEqual(built.payload, parts.payload, `seed ${seed}: the payload changed`);
      assert.equal(built.v, JOB_ENVELOPE_VERSION);
      assert.equal(built.meta.dispatchedAt, parts.dispatchedAt);
    }
  });

  test('the builder copies the payload and context, so later mutation cannot reach the envelope', () => {
    const payload = { list: [1] };
    const context = { trace: 'a' };
    const envelope = buildEnvelope({ name: 'job', payload, options: {}, context, dispatchedAt: 0 });
    payload.list.push(2);
    context.trace = 'b';
    assert.deepEqual(envelope.payload, { list: [1] });
    assert.deepEqual(envelope.meta.context, { trace: 'a' });
    assert.ok(Object.isFrozen(envelope));
    assert.ok(Object.isFrozen(envelope.meta));
  });

  test('empty tags are left out', () => {
    const envelope = buildEnvelope({
      name: 'job',
      payload: 1,
      options: {},
      tags: [],
      dispatchedAt: 0,
    });
    assert.equal('tags' in envelope.meta, false);
  });

  test('a newer version is reported as such, not as malformed', () => {
    const newer = edited((copy) => {
      (copy as Record<string, unknown>).v = JOB_ENVELOPE_VERSION + 1;
      copy.meta!.somethingNew = true;
    });
    assert.deepEqual(decodeEnvelope(newer), { ok: false, reason: 'newer_version' });
  });

  const malformed: readonly [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a string', 'envelope'],
    ['version 0', edited((copy) => ((copy as Record<string, unknown>).v = 0))],
    ['a fractional version', edited((copy) => ((copy as Record<string, unknown>).v = 1.5))],
    ['a string version', edited((copy) => ((copy as Record<string, unknown>).v = '1'))],
    ['an extra top-level field', edited((copy) => ((copy as Record<string, unknown>).queue = 'q'))],
    ['a missing payload', edited((copy) => delete (copy as Record<string, unknown>).payload)],
    ['an empty name', edited((copy) => ((copy as Record<string, unknown>).name = ''))],
    ['an unknown option', edited((copy) => (copy.options!.delay = 5))],
    ['attempts out of bounds', edited((copy) => (copy.options!.attempts = 26))],
    [
      'a bad backoff type',
      edited((copy) => (copy.options!.backoff = { type: 'linear', delayMs: 1 })),
    ],
    ['an extra meta field', edited((copy) => (copy.meta!.unknownCount = 1))],
    ['a missing dispatch time', edited((copy) => delete copy.meta!.dispatchedAt)],
    ['a key without a window', edited((copy) => delete copy.meta!.keyWindowMs)],
    ['a window without a key', edited((copy) => delete copy.meta!.key)],
    ['an empty key', edited((copy) => (copy.meta!.key = ''))],
    ['a non-string tag', edited((copy) => (copy.meta!.tags = [1]))],
    ['a bad flow kind', edited((copy) => (copy.meta!.flow = { kind: 'tree', id: 'x', step: 0 }))],
    [
      'a chain flow with an index',
      edited((copy) => (copy.meta!.flow = { kind: 'chain', id: 'x', index: 0 })),
    ],
    ['a negative run time', edited((copy) => (copy.meta!.runAt = -1))],
    ['an overlap without a ttl', edited((copy) => (copy.meta!.overlap = { key: 'o' }))],
  ];

  for (const [label, value] of malformed) {
    test(`an envelope with ${label} is malformed`, () => {
      assert.deepEqual(decodeEnvelope(value), { ok: false, reason: 'malformed' });
    });
  }

  test('an envelope whose payload is not plain JSON is malformed', () => {
    const envelope = { ...maximal(), payload: new Date(0) };
    assert.deepEqual(decodeEnvelope(envelope), { ok: false, reason: 'malformed' });
  });

  const notJson: readonly [string, unknown][] = [
    ['undefined', undefined],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative zero', -0],
    ['a bigint', 1n],
    ['a function', () => undefined],
    ['a nested undefined', { a: undefined }],
    ['a sparse array', new Array<number>(2)],
    ['a symbol key', { [Symbol('s')]: 1 }],
    ['an own __proto__ key', JSON.parse('{"__proto__": 1}') as unknown],
  ];

  for (const [label, payload] of notJson) {
    test(`a payload holding ${label} is refused at build, value-free`, () => {
      assert.throws(
        () => buildEnvelope({ name: 'job', payload, options: {}, dispatchedAt: 0 }),
        (error: unknown) => error instanceof JobEnvelopeError && error.code === 'payload_not_json',
      );
    });
  }

  test('a context that is not plain JSON is refused at build', () => {
    assert.throws(
      () =>
        buildEnvelope({
          name: 'job',
          payload: 1,
          options: {},
          context: new Date(0),
          dispatchedAt: 0,
        }),
      (error: unknown) => error instanceof JobEnvelopeError && error.code === 'context_not_json',
    );
  });

  test('parts out of bounds are refused at build', () => {
    assert.throws(
      () => buildEnvelope({ name: '', payload: 1, options: {}, dispatchedAt: 0 }),
      (error: unknown) => error instanceof JobEnvelopeError && error.code === 'invalid_envelope',
    );
    assert.throws(
      () => buildEnvelope({ name: 'job', payload: 1, options: { attempts: 0 }, dispatchedAt: 0 }),
      (error: unknown) => error instanceof JobEnvelopeError && error.code === 'invalid_envelope',
    );
  });

  test('a cyclic or too deeply nested value is not plain JSON', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(isPlainJson(cyclic), false);
    let deep: unknown = 1;
    for (let depth = 0; depth <= MAX_JSON_DEPTH; depth += 1) deep = [deep];
    assert.equal(isPlainJson(deep), false);
    assert.equal(isPlainJson(Object.create(null) as unknown), true);
  });
});
