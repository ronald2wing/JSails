/**
 * Seeded property tests for the server-component form object's `fill` and
 * `fromState` over hostile JSON.
 *
 * States are parsed from JSON text built by a small deterministic PRNG
 * (mulberry32), so `__proto__` arrives as an own key exactly as it would from
 * a request body, alongside `constructor`, `prototype`, and bracket/dot paths.
 * The properties: every call either applies a schema-valid value or throws a
 * `FormDefinitionError`/`ZodError`, no undeclared field survives into
 * `values()` or `toState()`, and nothing ever reaches `Object.prototype`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { defineForm, FormDefinitionError } from '../../src/server-components/form.js';

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

const BASE_SEED = 0xf0e3_4101;
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
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

function generator(seed: number): Gen {
  const next = mulberry32(seed);
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}

function forAll(check: (gen: Gen) => void): void {
  for (let run = 0; run < RUNS; run += 1) {
    const caseSeed = (BASE_SEED + run) >>> 0;
    try {
      check(generator(caseSeed));
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
  '__proto__[polluted]',
  'constructor[prototype][polluted]',
  '__proto__.polluted',
  'a[b]',
  'polluted',
  '',
  'name',
  'name',
  'age',
  'age',
];
const VALUES = [
  '"x"',
  '""',
  '1',
  '-1',
  '1.5',
  'true',
  'null',
  '[]',
  '{"polluted":true}',
  '{"prototype":{"polluted":true}}',
  '{"__proto__":{"polluted":true}}',
];

/** A JSON object parsed from text, so `__proto__` is an own key as in a request body. */
function hostileState(gen: Gen): unknown {
  const entries: string[] = [];
  for (let i = gen.int(0, 5); i > 0; i -= 1) {
    entries.push(`${JSON.stringify(gen.pick(NAMES))}:${gen.pick(VALUES)}`);
  }
  return JSON.parse(`{${entries.join(',')}}`) as unknown;
}

function assertPrototypeClean(): void {
  const probe: Record<string, unknown> = {};
  assert.equal(probe.polluted, undefined, 'Object.prototype was polluted');
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
}

const DECLARED = new Set(['name', 'age']);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: server-component form fill and fromState', () => {
  const schema = z.object({ name: z.string(), age: z.number().optional() });
  const define = defineForm({ schema, initial: { name: 'start' } });

  it('throws only FormDefinitionError or ZodError and never pollutes Object.prototype', () => {
    forAll((gen) => {
      const form = define();
      const state = hostileState(gen);
      for (const apply of [
        () => form.fill(state as Record<string, never>),
        () => form.fromState(state),
      ]) {
        try {
          apply();
        } catch (error) {
          assert.ok(
            error instanceof FormDefinitionError || error instanceof z.ZodError,
            `unexpected ${String(error)}`,
          );
        }
        assert.equal(Object.getPrototypeOf(form.values()), Object.prototype);
      }
      assertPrototypeClean();
    });
  });

  it('fromState keeps only declared fields', () => {
    forAll((gen) => {
      const form = define();
      try {
        form.fromState(hostileState(gen));
      } catch (error) {
        assert.ok(error instanceof FormDefinitionError || error instanceof z.ZodError);
      }
      for (const name of Reflect.ownKeys(form.toState())) {
        assert.ok(DECLARED.has(String(name)), `undeclared state field ${String(name)}`);
      }
    });
  });

  it('fill keeps only declared, schema-valid fields', () => {
    forAll((gen) => {
      const form = define();
      try {
        form.fill(hostileState(gen) as Record<string, never>);
      } catch (error) {
        assert.ok(error instanceof FormDefinitionError || error instanceof z.ZodError);
      }
      for (const name of Reflect.ownKeys(form.toState())) {
        assert.ok(DECLARED.has(String(name)), `undeclared field ${String(name)} survived fill`);
      }
      // Every value fill kept satisfies its field's schema.
      const state = form.toState();
      assert.equal(schema.shape.name.safeParse(state.name).success, true);
      assert.equal(schema.shape.age.safeParse(state.age).success, true);
    });
  });

  it('validate fails while a filled value was rejected', () => {
    forAll((gen) => {
      const form = define();
      const state = hostileState(gen) as Record<string, unknown>;
      form.fill(state);
      const nameRejected =
        Object.hasOwn(state, 'name') && !schema.shape.name.safeParse(state.name).success;
      const ageRejected =
        Object.hasOwn(state, 'age') && !schema.shape.age.safeParse(state.age).success;
      const result = form.validate();
      if (nameRejected || ageRejected) {
        assert.equal(result.ok, false);
      } else {
        assert.equal(result.ok, true);
      }
      for (const key of result.ok ? [] : Object.keys(result.errors)) {
        assert.ok(DECLARED.has(key.split('.')[0]!), `error for undeclared field ${key}`);
      }
    });
  });

  it('an own __proto__ key in fill never becomes inherited form state', () => {
    const form = define();
    try {
      form.fill(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, never>);
    } catch (error) {
      assert.ok(error instanceof FormDefinitionError || error instanceof z.ZodError);
    }
    const result = form.validate();
    assert.equal(result.ok ? undefined : result.errors.polluted, undefined);
    assert.equal(result.ok, true);
    assert.equal(Object.getPrototypeOf(form.values()), Object.prototype);
    assert.deepEqual(form.toState(), { name: 'start' });
  });

  it('an own __proto__ key in initial never reaches the form values', () => {
    const form = defineForm({
      schema,
      initial: JSON.parse('{"name":"x","__proto__":{"polluted":true},"extra":1}') as {
        name: string;
      },
    })();
    assert.deepEqual(form.toState(), { name: 'x' });
    assert.equal(form.validate().ok, true);
    assertPrototypeClean();
  });
});
