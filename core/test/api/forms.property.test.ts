/**
 * Seeded property tests for form parsing: `readForm` over
 * `application/x-www-form-urlencoded` bodies.
 *
 * Bodies are assembled by a small deterministic PRNG (mulberry32) from field
 * names that target prototype handling (`__proto__`, `constructor`,
 * `prototype`, `hasOwnProperty`, their percent-encoded spellings, bracket and
 * dot paths) with arbitrary values. The properties: the parsed record equals a
 * reference model built from `URLSearchParams` (one own data property per
 * name, repeated names as arrays), keeps an ordinary prototype, and nothing
 * ever reaches `Object.prototype`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readForm } from '../../src/api/forms.js';
import type { Schema } from '../../src/api/validation.js';

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

const BASE_SEED = 0xf0e3_4001;
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

interface Gen {
  chance(p: number): boolean;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

function generator(seed: number): Gen {
  const next = mulberry32(seed);
  return {
    chance: (p) => next() < p,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

async function forAll(check: (gen: Gen) => Promise<void> | void): Promise<void> {
  for (let run = 0; run < RUNS; run += 1) {
    const caseSeed = (BASE_SEED + run) >>> 0;
    try {
      await check(generator(caseSeed));
    } catch (error) {
      assert.fail(`property failed for seed ${caseSeed}: ${(error as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const NAMES = [
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__proto__[polluted]',
  'constructor[prototype][polluted]',
  '__proto__.polluted',
  'a[b]',
  'a',
  'b',
  '',
  ' ',
  'polluted',
  'é',
  '😀',
];
const RAW_NAMES = ['%5F%5Fproto%5F%5F', '__pro%74o__', 'constructor%5Bprototype%5D', '%00', '+'];
const VALUES = [
  '',
  'x',
  'true',
  '1',
  '{"polluted":true}',
  '<script>',
  '&',
  '=',
  '%',
  '%zz',
  '+',
  '😀',
];

function body(gen: Gen): string {
  const pairs: string[] = [];
  for (let i = gen.int(0, 8); i > 0; i -= 1) {
    const name = gen.chance(0.2) ? gen.pick(RAW_NAMES) : encodeURIComponent(gen.pick(NAMES));
    const value = gen.chance(0.3) ? gen.pick(VALUES) : encodeURIComponent(gen.pick(VALUES));
    pairs.push(gen.chance(0.1) ? name : `${name}=${value}`);
  }
  return pairs.join(gen.chance(0.1) ? '&&' : '&');
}

/** The record readForm must produce: one own data property per decoded name. */
function model(text: string): Map<string, string | string[]> {
  const fields = new Map<string, string | string[]>();
  for (const [name, value] of new URLSearchParams(text)) {
    const existing = fields.get(name);
    if (existing === undefined) fields.set(name, value);
    else if (Array.isArray(existing)) existing.push(value);
    else fields.set(name, [existing, value]);
  }
  return fields;
}

const passthrough: Schema<unknown> = {
  validate: (input) => input,
  _validate: (input) => input,
};

function assertPrototypeClean(): void {
  const probe: Record<string, unknown> = {};
  assert.equal(probe.polluted, undefined, 'Object.prototype was polluted');
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: readForm urlencoded parsing', () => {
  it('produces exactly the reference record with own data properties', async () => {
    await forAll(async (gen) => {
      const text = body(gen);
      const result = await readForm(
        new Request('http://localhost/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: text,
        }),
        passthrough,
      );
      assert.ok(result.ok);
      const value = result.value as Record<string, unknown>;
      assert.equal(Object.getPrototypeOf(value), Object.prototype);
      const expected = model(text);
      assert.deepEqual(Reflect.ownKeys(value).sort(), [...expected.keys()].sort());
      for (const [name, expectedValue] of expected) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        assert.ok(
          descriptor !== undefined && 'value' in descriptor,
          `${name} is not a data property`,
        );
        assert.deepEqual(descriptor.value, expectedValue);
      }
      assertPrototypeClean();
    });
  });

  it('never throws for an oversized body; it reports body_too_large', async () => {
    await forAll(async (gen) => {
      const text = body(gen).padEnd(gen.int(65, 200), 'a');
      const result = await readForm(
        new Request('http://localhost/', { method: 'POST', body: text }),
        passthrough,
        { maxBytes: 64 },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.errors[0]?.code, 'body_too_large');
    });
  });
});
