/**
 * Tests for renderList: numbers count from 1, iterables pass item and index, plain objects pass value, key and index in Object.keys order, and null, undefined and other values render nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderList } from '../../src/view/index.js';

describe('renderList', () => {
  it('counts from 1 to n with the index', () => {
    assert.deepEqual(
      renderList(3, (value, index) => `${index}:${value}`),
      ['0:1', '1:2', '2:3'],
    );
    assert.deepEqual(
      renderList(0, (value) => value),
      [],
    );
  });

  it('iterates arrays, strings, maps and sets with the index', () => {
    assert.deepEqual(
      renderList(['a', 'b'], (item, index) => `${index}${item}`),
      ['0a', '1b'],
    );
    assert.deepEqual(
      renderList('hi', (item) => item),
      ['h', 'i'],
    );
    assert.deepEqual(
      renderList(new Map([['k', 1]]), ([key, value]) => `${key}=${value}`),
      ['k=1'],
    );
    assert.deepEqual(
      renderList(new Set([3, 4]), (item, index) => item * 10 + index),
      [30, 41],
    );
  });

  it("iterates a plain object's own keys with value, key and index", () => {
    const record: Record<string, number> = { b: 2, a: 1 };
    assert.deepEqual(
      renderList(record, (value, key, index) => `${index}${key}${value}`),
      ['0b2', '1a1'],
    );
  });

  it('renders nothing for null, undefined and other values', () => {
    const render = (item: unknown): unknown => item;
    assert.deepEqual(renderList(null, render), []);
    assert.deepEqual(renderList(undefined, render), []);
    assert.deepEqual(renderList(true as unknown as Iterable<unknown>, render), []);
  });
});
