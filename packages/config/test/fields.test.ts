/** Tests for the config field helpers: defaults, checks, form parsing, and value-free errors. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { array, string } from 'jsails/api';

import { ConfigError, boolean, choice, integer, json, text } from '../src/index.js';

function refuses(run: () => unknown, code: ConfigError['code'] = 'invalid_value'): void {
  assert.throws(run, (error: unknown) => error instanceof ConfigError && error.code === code);
}

describe('config fields', () => {
  it('text checks type, emptiness when required, and length', () => {
    const field = text({ required: true, max: 5, default: 'a' });
    assert.equal(field.check('abc'), 'abc');
    refuses(() => field.check(''));
    refuses(() => field.check('toolong'));
    refuses(() => field.check(3));
    assert.equal(field.fromForm('  hi  '), 'hi');
    assert.equal(text().default, '');
  });

  it('integer checks whole numbers and bounds, and parses only digits', () => {
    const field = integer({ default: 5, min: 1, max: 10 });
    assert.equal(field.check(7), 7);
    refuses(() => field.check(1.5));
    refuses(() => field.check(11));
    assert.equal(field.fromForm('8'), 8);
    refuses(() => field.fromForm('8px'));
    refuses(() => field.fromForm('1e1'));
    refuses(() => integer({ default: 1, min: 5, max: 2 }), 'invalid_field');
  });

  it('boolean reads a checkbox as absent-means-off', () => {
    const field = boolean();
    assert.equal(field.fromForm('on'), true);
    assert.equal(field.fromForm(undefined), false);
    refuses(() => field.check('yes'));
  });

  it('choice allows only its options', () => {
    const field = choice({ options: ['a', 'b'], default: 'a' });
    assert.equal(field.check('b'), 'b');
    refuses(() => field.check('c'));
    refuses(() => choice({ options: [], default: 'a' as never }), 'invalid_field');
  });

  it('json parses form text and validates through its schema', () => {
    const field = json({ default: [], schema: array(string()) });
    assert.deepEqual(field.fromForm('["a"]'), ['a']);
    assert.deepEqual(field.fromForm(''), []);
    refuses(() => field.fromForm('[1]'));
    refuses(() => field.fromForm('{nope'));
    refuses(() => json({ default: {} }).check({ ['__proto__']: 1, ok: () => 1 }));
  });

  it('json accepts a validate predicate for shapes a schema cannot state', () => {
    const field = json({
      default: {},
      validate: (value) =>
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every((item) => typeof item === 'string'),
    });
    assert.deepEqual(field.check({ x: 'https://x.test' }), { x: 'https://x.test' });
    refuses(() => field.check({ x: 1 }));
  });

  it('refuses a default that fails its own check', () => {
    refuses(() => text({ default: 'abcdef', max: 3 }));
  });

  it('never echoes the value in an error', () => {
    try {
      text({ max: 3 }).check('s3cr3t-value');
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes('s3cr3t'));
    }
  });
});
