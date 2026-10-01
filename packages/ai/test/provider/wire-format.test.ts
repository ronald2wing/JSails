/**
 * Shared wire helpers: canonical schema key order (name-keyed maps and data
 * keywords untouched), deterministic tool-call id fitting, base64 text
 * decoding, and strict parsing of streamed tool input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalSchema,
  decodeBase64Text,
  fitToolCallId,
  parseStreamedInput,
} from '../../src/provider/wire-format.js';

describe('canonicalSchema', () => {
  it('sorts keywords but keeps property order and data values', () => {
    const schema = canonicalSchema({
      type: 'object',
      properties: {
        zeta: { type: 'string', description: 'z' },
        alpha: { default: { b: 1, a: 2 }, type: 'number' },
      },
      required: ['zeta', 'alpha'],
      $defs: { Z: { type: 'null' }, A: { type: 'null' } },
      enum: [{ y: 1, x: 2 }],
    });
    assert.equal(
      JSON.stringify(schema),
      '{"$defs":{"Z":{"type":"null"},"A":{"type":"null"}},"enum":[{"y":1,"x":2}],' +
        '"properties":{"zeta":{"description":"z","type":"string"},"alpha":{"default":{"b":1,"a":2},"type":"number"}},' +
        '"required":["zeta","alpha"],"type":"object"}',
    );
  });

  it('recurses into schema arrays such as anyOf and items', () => {
    const schema = canonicalSchema({
      anyOf: [{ type: 'string', minLength: 1 }],
      items: { type: 'x', a: 1 },
    });
    assert.equal(
      JSON.stringify(schema),
      '{"anyOf":[{"minLength":1,"type":"string"}],"items":{"a":1,"type":"x"}}',
    );
  });
});

describe('fitToolCallId', () => {
  it('keeps a fitting id and maps others deterministically within the limit', () => {
    assert.equal(fitToolCallId('call_abc', 40), 'call_abc');
    const long = 'toolu_' + 'x'.repeat(60);
    const fitted = fitToolCallId(long, 40);
    assert.equal(fitted, fitToolCallId(long, 40));
    assert.ok(fitted.length <= 40);
    assert.match(fitted, /^[A-Za-z0-9_-]+$/);
    const odd = fitToolCallId('a:b/c', 64);
    assert.match(odd, /^call_[A-Za-z0-9_-]+$/);
    assert.notEqual(fitToolCallId('a:b', 64), fitToolCallId('a/b', 64));
  });
});

describe('decodeBase64Text', () => {
  it('decodes UTF-8 text', () => {
    assert.equal(decodeBase64Text('aMOpbGxv'), 'héllo');
  });
});

describe('parseStreamedInput', () => {
  it('parses objects, treats empty as {}, and wraps anything else', () => {
    assert.deepEqual(parseStreamedInput(''), {});
    assert.deepEqual(parseStreamedInput('{"a":1}'), { a: 1 });
    assert.deepEqual(parseStreamedInput('{"a":'), { INVALID_JSON: '{"a":' });
    assert.deepEqual(parseStreamedInput('[1]'), { INVALID_JSON: '[1]' });
    assert.deepEqual(parseStreamedInput('null'), { INVALID_JSON: 'null' });
  });
});
