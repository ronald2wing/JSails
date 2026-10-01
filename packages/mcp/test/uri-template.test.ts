/**
 * Strict RFC 6570 parsing limited to what the SDK matcher resolves, and
 * percent-decoding of matched values.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UriTemplate } from '@modelcontextprotocol/server';

import { McpDefinitionError } from '../src/errors.js';
import { decodeVariables, parseUriTemplate } from '../src/uri-template.js';

describe('parseUriTemplate', () => {
  it('parses supported expressions', () => {
    const parsed = parseUriTemplate('files:///{+path}{?rev,format}', 't');
    assert.deepEqual(
      parsed.variables.map((variable) => [variable.name, variable.operator]),
      [
        ['path', '+'],
        ['rev', '?'],
        ['format', '?'],
      ],
    );
    assert.deepEqual(parseUriTemplate('notes://{id}/{/segments*}', 't').variables[1], {
      name: 'segments',
      operator: '/',
      exploded: true,
    });
  });

  it('rejects malformed and unsupported templates', () => {
    const invalid = [
      '',
      'notes://plain',
      '{scheme}://x',
      'relative/{id}',
      'notes://{id',
      'notes://{}',
      'notes://{a{b}}',
      'notes://{;id}',
      'notes://{=id}',
      'notes://{id:3}',
      'notes://{a,b}',
      'notes://{bad-name}',
      'notes://{id}/{id}',
      'notes://a b/{id}',
      'notes://%zz/{id}',
      'notes://' + 'x'.repeat(2048) + '{id}',
      42,
    ];
    for (const template of invalid) {
      assert.throws(
        () => parseUriTemplate(template, 't'),
        (error: unknown) =>
          error instanceof McpDefinitionError && error.code === 'invalid_uri_template',
        String(template),
      );
    }
  });
});

describe('decodeVariables', () => {
  it('percent-decodes simple values and keeps reserved expansion reserved characters', () => {
    const parsed = parseUriTemplate('notes://{id}/{+rest}', 't');
    const matched = new UriTemplate('notes://{id}/{+rest}').match('notes://a%20b/c%2Fd/e');
    assert.ok(matched);
    assert.deepEqual(decodeVariables(parsed, matched), { id: 'a b', rest: 'c%2Fd/e' });
  });

  it('returns undefined for malformed percent-encoding', () => {
    const parsed = parseUriTemplate('notes://{id}', 't');
    assert.equal(decodeVariables(parsed, { id: '%E0%A4%A' }), undefined);
  });

  it('decodes exploded lists', () => {
    const parsed = parseUriTemplate('tags://{list*}', 't');
    assert.deepEqual(decodeVariables(parsed, { list: ['a%2Cb', 'c'] }), { list: ['a,b', 'c'] });
  });
});
