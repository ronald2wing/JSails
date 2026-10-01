/**
 * Tests for the operator, array, and comparison forms of `parseFilters`: every
 * clause must stay within the field's declared operator allowlist and bounds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_QUERY, parseFilters } from '../../src/api/filters.js';
import { ValidationError } from '../../src/api/validation.js';

describe('advanced filters', () => {
  it('accumulates repeated filter[field][] values into an array', () => {
    const q = parseFilters(new URL('http://x/?filter[tag][]=a&filter[tag][]=b'), {
      fields: { tag: { type: 'string', operators: ['in'] } },
    });
    assert.deepEqual(q.filterClauses, [{ field: 'tag', operator: 'in', value: ['a', 'b'] }]);
  });

  it('parses an operator form filter[age][gt]=18', () => {
    const q = parseFilters(new URL('http://x/?filter[age][gt]=18'), {
      fields: { age: { type: 'integer', operators: ['gt'] } },
    });
    assert.deepEqual(q.filterClauses, [{ field: 'age', operator: 'gt', value: 18 }]);
  });

  it('rejects an operator not allowlisted for the field', () => {
    assert.throws(
      () =>
        parseFilters(new URL('http://x/?filter[age][gt]=18'), {
          fields: { age: { type: 'integer' } },
        }),
      ValidationError,
    );
  });

  it('enforces the filter count bound across accumulated values', () => {
    const params = new URLSearchParams();
    for (let i = 0; i < 40; i += 1) params.append('filter[t][]', String(i));
    assert.throws(
      () =>
        parseFilters(params, {
          fields: { t: { type: 'string', operators: ['in'] } },
          maxFilters: 32,
        }),
      ValidationError,
    );
  });

  it('never echoes an undeclared field name or operator in an error', () => {
    const fields = { age: { type: 'integer' as const } };
    for (const query of [
      'sort=secret_column',
      'filter[secret_column]=1',
      'filter[age][secret_op]=1',
    ]) {
      try {
        parseFilters(new URL(`http://x/?${query}`), { fields });
        assert.fail(`expected a ValidationError for ${query}`);
      } catch (error) {
        assert.ok(error instanceof ValidationError);
        const text = JSON.stringify({ message: error.message, issues: error.issues });
        assert.ok(!text.includes('secret_'), `echoed client input for ${query}: ${text}`);
      }
    }
  });

  it('exports a frozen empty query', () => {
    assert.deepEqual(EMPTY_QUERY, { search: null, sorts: [], filters: {}, filterClauses: [] });
    assert.ok(Object.isFrozen(EMPTY_QUERY));
    assert.ok(Object.isFrozen(EMPTY_QUERY.sorts));
    assert.ok(Object.isFrozen(EMPTY_QUERY.filterClauses));
  });

  it('treats inherited property names as undeclared', () => {
    const fields = { age: { type: 'integer' as const } };
    for (const query of ['sort=constructor', 'sort=-toString', 'filter[hasOwnProperty]=1']) {
      assert.throws(
        () => parseFilters(new URL(`http://x/?${query}`), { fields }),
        (error: unknown) =>
          error instanceof ValidationError &&
          ['unknown_sort_field', 'unknown_filter_field'].includes(error.issues[0]?.code ?? ''),
        `expected an unknown-field error for ${query}`,
      );
    }
  });

  it('rejects a filter key that matches no filter form instead of dropping it', () => {
    const fields = { status: { type: 'string' as const, operators: ['in' as const] } };
    for (const query of ['filter[status][in][]=a', 'filter[status', 'filter[a][b][c]=1']) {
      assert.throws(
        () => parseFilters(new URL(`http://x/?${query}`), { fields }),
        (error: unknown) =>
          error instanceof ValidationError && error.issues[0]?.code === 'invalid_filter',
        `expected invalid_filter for ${query}`,
      );
    }
    const q = parseFilters(new URL('http://x/?filter[status][in]=a&filter[status][in]=b'), {
      fields,
    });
    assert.deepEqual(q.filterClauses, [{ field: 'status', operator: 'in', value: ['a', 'b'] }]);
  });
});
