/**
 * Seeded property tests for list-query parsing (`parseFilters`).
 *
 * Query strings are assembled by a small deterministic PRNG (mulberry32) from
 * declared, undeclared, prototype-named (`__proto__`, `constructor`,
 * `toString`), malformed (`filter[`, `filter[]`), and operator-bearing keys,
 * with values biased toward numeric edge forms, separators, oversize text, and
 * a planted marker. The properties: parsing either returns a query built only
 * from the allowlist or throws a `ValidationError` whose messages never echo a
 * value, and nothing ever reaches `Object.prototype`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFilters, type FilterOptions } from '../../src/api/filters.js';
import { ValidationError } from '../../src/api/validation.js';

// ---------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------

const BASE_SEED = 0x0f17_3001;
const RUNS = 1500;

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

const PLANTED = 'PLANTEDVALUE';

const FIELDS = ['name', 'age', 'active', 'hidden', '__proto__', 'constructor', 'toString', 'nope'];
const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'bogus', '__proto__', ''];

function key(gen: Gen): string {
  const field = gen.pick(FIELDS);
  switch (gen.int(0, 7)) {
    case 0:
      return 'search';
    case 1:
      return 'sort';
    case 2:
      return `filter[${field}]`;
    case 3:
      return `filter[${field}][]`;
    case 4:
      return `filter[${field}][${gen.pick(OPERATORS)}]`;
    case 5:
      return gen.pick(['filter[', 'filter[]', 'filter[]]', 'filter[a][b][c]', '__proto__', 'page']);
    default:
      return `filter[${field}]`;
  }
}

function value(gen: Gen): string {
  return gen.pick([
    'name',
    '-name',
    'age',
    '-age',
    'active',
    'hidden',
    '-hidden',
    '__proto__',
    'constructor',
    'name,age',
    'name,,age',
    ',',
    '-',
    '--name',
    ' name ',
    '1',
    '-1',
    '01',
    '+1',
    '1e3',
    '0x10',
    '9007199254740993',
    '1.5',
    'NaN',
    'Infinity',
    'true',
    'false',
    'TRUE',
    '1',
    '0',
    '',
    ' ',
    '\u0000',
    '<script>',
    PLANTED,
    `${PLANTED},${PLANTED}`,
    'x'.repeat(201),
    'y'.repeat(5000),
  ]);
}

function query(gen: Gen): URLSearchParams {
  const params = new URLSearchParams();
  for (let i = gen.int(0, 10); i > 0; i -= 1) params.append(key(gen), value(gen));
  return params;
}

const OPTIONS: FilterOptions = {
  fields: {
    name: { type: 'string', operators: ['eq', 'in'] },
    age: { type: 'integer', operators: ['eq', 'gt', 'lt', 'in', 'nin'] },
    active: { type: 'boolean' },
    hidden: { sortable: false, filterable: false },
  },
};

const FIELD_OPTIONS = OPTIONS.fields as Record<string, FilterOptions['fields'][string] | undefined>;

function declared(field: string): FilterOptions['fields'][string] | undefined {
  return Object.hasOwn(FIELD_OPTIONS, field) ? FIELD_OPTIONS[field] : undefined;
}

function assertScalarType(field: string, scalar: unknown): void {
  const type = declared(field)?.type ?? 'string';
  if (type === 'integer')
    assert.ok(Number.isSafeInteger(scalar), `${field} value ${String(scalar)}`);
  else if (type === 'boolean') assert.equal(typeof scalar, 'boolean');
  else {
    assert.equal(typeof scalar, 'string');
    assert.ok((scalar as string).length <= 200);
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: parseFilters', () => {
  it('returns an allowlisted query or throws a value-free ValidationError', () => {
    let accepted = 0;
    let rejected = 0;
    forAll((gen) => {
      const params = query(gen);
      let result: ReturnType<typeof parseFilters>;
      try {
        result = parseFilters(params, OPTIONS);
      } catch (error) {
        assert.ok(error instanceof ValidationError, `unexpected ${String(error)}`);
        assert.ok(!JSON.stringify(error.issues).includes(PLANTED), 'an issue echoed a value');
        assert.ok(!error.message.includes(PLANTED));
        rejected += 1;
        return;
      }
      accepted += 1;

      if (result.search !== null) {
        assert.ok(result.search.length > 0 && result.search.length <= 200);
        assert.equal(result.search, result.search.trim());
      }
      const sortFields = result.sorts.map((sort) => sort.field);
      assert.equal(new Set(sortFields).size, sortFields.length, 'sorts are deduplicated');
      for (const sort of result.sorts) {
        const options = declared(sort.field);
        assert.ok(options !== undefined && options.sortable !== false, `sort on ${sort.field}`);
        assert.ok(sort.direction === 'asc' || sort.direction === 'desc');
      }
      for (const clause of result.filterClauses) {
        const options = declared(clause.field);
        assert.ok(
          options !== undefined && options.filterable !== false,
          `filter on ${clause.field}`,
        );
        assert.ok((options.operators ?? ['eq']).includes(clause.operator), clause.operator);
        const values = Array.isArray(clause.value) ? clause.value : [clause.value];
        for (const scalar of values) assertScalarType(clause.field, scalar);
      }
      assert.ok(
        Object.getPrototypeOf(result.filters) === Object.prototype ||
          Object.getPrototypeOf(result.filters) === null,
      );
      for (const field of Object.keys(result.filters)) {
        assert.ok(declared(field) !== undefined, `filters carries ${field}`);
      }
    });
    assert.equal(Object.getOwnPropertyNames(Object.prototype).includes(PLANTED), false);
    assert.ok(
      accepted > RUNS / 20 && rejected > RUNS / 20,
      `${accepted} accepted, ${rejected} rejected`,
    );
  });

  it('is deterministic for the same input', () => {
    forAll((gen) => {
      const params = query(gen);
      const run = (): string => {
        try {
          return JSON.stringify(parseFilters(params, OPTIONS));
        } catch (error) {
          return JSON.stringify((error as ValidationError).issues);
        }
      };
      assert.equal(run(), run());
    });
  });
});
