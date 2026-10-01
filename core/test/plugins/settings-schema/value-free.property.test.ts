/**
 * Seeded property test: no input value ever appears in a settings issue.
 *
 * A deterministic PRNG builds random settings schemas from every field kind,
 * then random values for them in which every string, key, and number carries
 * a unique marker. Whatever `validateSettings` and `parseSettingsSchema`
 * return, the printed issues never contain a marker: a settings value may be
 * a secret, so an issue names only where it failed and why.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseSettingsSchema,
  validateSettings,
} from '../../../src/plugins/settings-schema/index.js';

const BASE_SEED = 0x5e77_0003;
const RUNS = 500;

/** mulberry32: a tiny, well-distributed 32-bit PRNG; same seed, same sequence. */
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

const MARKER = 'QZXV';
/** A marked number: one no schema or index in this test would ever contain. */
const MARKED_NUMBER = 987_654.321;

function run(seed: number): { schema: unknown; value: unknown } {
  const next = mulberry32(seed);
  const int = (max: number): number => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const marked = (): string =>
    pick([
      `${MARKER}${int(1e6)}`,
      `${MARKER}\n${int(1e6)}`,
      `https://${MARKER}${int(1e6)}.test`,
      `${MARKER}@${MARKER}.test`,
      `${MARKER}`.repeat(1 + int(20_000)),
    ]);

  const kinds = [
    () => ({ type: 'string' }),
    () => ({ type: 'string', format: pick(['email', 'uri', 'textarea', 'secret']) }),
    () => ({ type: 'string', maxLength: 1 + int(8) }),
    () => ({ type: 'string', enum: ['a', 'b'] }),
    () => ({ type: pick(['number', 'integer']), minimum: 0, maximum: 10 }),
    () => ({ type: 'boolean' }),
    () => ({ type: 'array', items: { type: 'string', maxLength: 3 }, maxItems: 2, minItems: 1 }),
    () => ({ type: 'array', items: { type: 'string', enum: ['x'] } }),
  ];
  const properties: Record<string, unknown> = {};
  const keys: string[] = [];
  for (let index = 0; index < 1 + int(6); index += 1) {
    const key = `k${index}`;
    keys.push(key);
    properties[key] = pick(kinds)();
  }
  const schema = { type: 'object', properties, required: keys.filter(() => int(2) === 0) };

  const anyValue = (): unknown =>
    pick<() => unknown>([
      marked,
      () => MARKED_NUMBER,
      () => -MARKED_NUMBER,
      () => [marked(), marked()],
      () => [MARKED_NUMBER],
      () => ({ [MARKER]: marked() }),
      () => int(2) === 0,
      () => null,
    ])();
  const value: Record<string, unknown> = {};
  for (const key of keys) if (int(3) !== 0) value[key] = anyValue();
  if (int(3) === 0) value[`${MARKER}key${int(100)}`] = marked();
  return { schema, value };
}

describe('settings issues are value-free (seeded property)', () => {
  it('never repeats a value, a key, or a number from the input', () => {
    let refused = 0;
    for (let index = 0; index < RUNS; index += 1) {
      const { schema, value } = run(BASE_SEED + index);
      const parsed = parseSettingsSchema(schema);
      assert.ok(parsed.ok, `seed ${BASE_SEED + index}: the generated schema must parse`);
      const result = validateSettings(parsed.schema, value);
      if (result.ok) continue;
      refused += 1;
      const printed = JSON.stringify(result.issues);
      assert.ok(!printed.includes(MARKER), `seed ${BASE_SEED + index}: ${printed.slice(0, 200)}`);
      assert.ok(!printed.includes(String(MARKED_NUMBER)), `seed ${BASE_SEED + index}`);
    }
    assert.ok(refused > RUNS / 2, 'most generated values must exercise the refusal path');
  });

  it('never repeats a marked default or enum value from a schema', () => {
    for (let index = 0; index < RUNS; index += 1) {
      const next = mulberry32(BASE_SEED + index);
      const marker = `${MARKER}${Math.floor(next() * 1e6)}`;
      const field = [
        { type: 'string', format: 'secret', default: marker },
        { type: 'string', maxLength: 2, default: marker },
        { type: 'string', enum: [marker, marker] },
        { type: 'integer', default: MARKED_NUMBER },
        { type: 'string', format: marker },
        { type: marker },
        { type: 'string', [`${marker}\n`]: 1 },
        { type: 'boolean', [`<${marker}>`]: true },
      ][Math.floor(next() * 8)];
      const result = parseSettingsSchema({ type: 'object', properties: { field } });
      assert.equal(result.ok, false);
      if (!result.ok) {
        const printed = JSON.stringify(result.issues);
        assert.ok(!printed.includes(MARKER), printed);
        assert.ok(!printed.includes(String(MARKED_NUMBER)), printed);
      }
    }
  });
});
