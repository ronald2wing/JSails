/**
 * Tests for normalizeClass, normalizeStyle and bindAttributes: strings, arrays and records merge in order, falsy entries add nothing, declaration strings split outside parentheses and quotes, later styles win and falsy values remove, and a js-bind spread drops the raw-HTML attributes and merges its class and style after the element's own.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bindAttributes,
  normalizeClass,
  normalizeStyle,
  type ClassValue,
} from '../../src/view/index.js';

describe('normalizeClass', () => {
  it('joins strings, records and nested arrays in order', () => {
    assert.equal(
      normalizeClass(['a', { b: true, c: false, d: 1 }, [' e ', ['f']], 0, 2]),
      'a b d e f 0 2',
    );
  });

  it('returns undefined when no class is named', () => {
    assert.equal(normalizeClass(null), undefined);
    assert.equal(normalizeClass(false), undefined);
    assert.equal(normalizeClass(['', { a: false }, [undefined]]), undefined);
    assert.equal(normalizeClass('  '), undefined);
  });

  it('ignores values of shapes the types do not allow', () => {
    const values: unknown = [true, 'a'];
    assert.equal(normalizeClass(values as ClassValue), 'a');
  });
});

describe('normalizeStyle', () => {
  it('parses a declaration string, ignoring comments and empty declarations', () => {
    assert.deepEqual(normalizeStyle('color: red; /* note */ font-size:12px;;margin'), {
      color: 'red',
      'font-size': '12px',
    });
  });

  it('keeps a semicolon inside parentheses in its declaration', () => {
    assert.deepEqual(normalizeStyle('background: url(data:image/png;base64,AA); color: blue'), {
      background: 'url(data:image/png;base64,AA)',
      color: 'blue',
    });
  });

  it('keeps a semicolon inside quotes in its declaration', () => {
    assert.deepEqual(normalizeStyle(`content: "a;b"; font-family: 'x;\\'y'; color: red`), {
      content: '"a;b"',
      'font-family': "'x;\\'y'",
      color: 'red',
    });
  });

  it('lets later entries win and removes properties set to a falsy value', () => {
    assert.deepEqual(
      normalizeStyle([
        'color: red; top: 1px',
        { color: 'blue', top: null, zIndex: 2 },
        [{ left: 0 }],
      ]),
      { color: 'blue', zIndex: 2, left: 0 },
    );
    assert.deepEqual(normalizeStyle([{ display: 'none' }, { display: false }]), undefined);
  });

  it('returns undefined when no property is set', () => {
    assert.equal(normalizeStyle(undefined), undefined);
    assert.equal(normalizeStyle(''), undefined);
    assert.equal(normalizeStyle([null, false]), undefined);
  });
});

describe('bindAttributes', () => {
  it('merges the spread class and style after the element’s own', () => {
    assert.deepEqual(
      bindAttributes(
        { id: 'x', class: 'b', style: { color: 'blue' } },
        { class: 'a', style: 'color: red; top: 0' },
      ),
      { id: 'x', class: 'a b', style: { color: 'blue', top: '0' } },
    );
  });

  it('copies other attributes and accepts a missing spread', () => {
    assert.deepEqual(bindAttributes(null, { class: 'a' }), { class: 'a' });
    assert.deepEqual(bindAttributes({ title: 't' }, {}), { title: 't' });
    assert.deepEqual(bindAttributes({ class: { on: false } }, { class: null }), {});
  });

  it('drops the raw-HTML attributes, with or without the element’s own class and style', () => {
    const attributes = {
      title: 't',
      class: ['b'],
      dangerouslySetInnerHTML: { __html: '<script></script>' },
      innerHTML: '<script></script>',
    };
    assert.deepEqual(bindAttributes(attributes), { title: 't', class: ['b'] });
    assert.deepEqual(bindAttributes(attributes, { class: 'a' }), { title: 't', class: 'a b' });
    assert.deepEqual(bindAttributes(undefined), {});
  });

  it('does not change the spread object', () => {
    const attributes = { class: 'b' };
    bindAttributes(attributes, { class: 'a' });
    assert.deepEqual(attributes, { class: 'b' });
  });
});
