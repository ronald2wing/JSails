/** Tests for `parseSettingsSchema`: the closed settings-schema subset. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSettingsSchema } from '../../../src/plugins/settings-schema/index.js';

function issues(raw: unknown): readonly { path: string; code: string }[] {
  const result = parseSettingsSchema(raw);
  assert.equal(result.ok, false, 'the schema must be refused');
  return result.ok
    ? []
    : result.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
}

function withField(field: unknown): Record<string, unknown> {
  return { type: 'object', properties: { field } };
}

describe('parseSettingsSchema', () => {
  it('parses every field kind and normalizes required', () => {
    const result = parseSettingsSchema({
      type: 'object',
      title: 'Tasks',
      properties: {
        siteName: { type: 'string', title: 'Site name', maxLength: 80, default: 'Tasks' },
        contact: { type: 'string', format: 'email' },
        homepage: { type: 'string', format: 'uri' },
        intro: { type: 'string', format: 'textarea' },
        apiKey: { type: 'string', format: 'secret', description: 'The provider key.' },
        theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
        ratio: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        retries: { type: 'integer', minimum: 0, maximum: 10 },
        enabled: { type: 'boolean', default: true },
        tags: { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: 5, default: [] },
        channels: { type: 'array', items: { type: 'string', enum: ['mail', 'sms'] }, minItems: 1 },
      },
      required: ['apiKey'],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.schema.required, ['apiKey']);
    assert.deepEqual(result.schema.properties['theme'], {
      type: 'string',
      enum: ['light', 'dark'],
      default: 'light',
    });
    assert.ok(Object.isFrozen(result.schema));
    assert.ok(Object.isFrozen(result.schema.properties));
    assert.ok(Object.isFrozen(result.schema.properties['tags']));
    assert.deepEqual(parseSettingsSchema({ type: 'object', properties: {} }), {
      ok: true,
      schema: { type: 'object', properties: {}, required: [] },
    });
  });

  it('rejects a non-object schema and a wrong root type', () => {
    assert.deepEqual(issues(null), [{ path: '', code: 'invalid_type' }]);
    assert.deepEqual(issues([]), [{ path: '', code: 'invalid_type' }]);
    assert.deepEqual(issues({ type: 'array', properties: {} }), [
      { path: 'type', code: 'invalid_type' },
    ]);
    assert.deepEqual(issues({ type: 'object' }), [{ path: 'properties', code: 'invalid_type' }]);
  });

  it('rejects every keyword outside the subset', () => {
    for (const keyword of ['pattern', '$ref', 'oneOf', 'minLength', 'additionalProperties']) {
      assert.deepEqual(
        issues(withField({ type: 'string', [keyword]: 'x' })),
        [{ path: `properties.field.${keyword}`, code: 'unknown_keyword' }],
        keyword,
      );
    }
    assert.deepEqual(issues({ type: 'object', properties: {}, $schema: 'x' }), [
      { path: '$schema', code: 'unknown_keyword' },
    ]);
    assert.deepEqual(issues(withField({ type: 'boolean', maximum: 1 })), [
      { path: 'properties.field.maximum', code: 'unknown_keyword' },
    ]);
  });

  it('reports a keyword that is not a plain identifier once, at its object', () => {
    assert.deepEqual(issues(withField({ type: 'boolean', 'a\nb': 1, '../x': 2 })), [
      { path: 'properties.field', code: 'unknown_keyword' },
    ]);
  });

  it('rejects nested objects and unknown field types', () => {
    assert.deepEqual(issues(withField({ type: 'object', properties: {} })), [
      { path: 'properties.field.type', code: 'invalid_field_type' },
    ]);
    assert.deepEqual(issues(withField('string')), [
      { path: 'properties.field', code: 'invalid_type' },
    ]);
    assert.deepEqual(issues(withField({ type: 'array', items: { type: 'number' } })), [
      { path: 'properties.field.items', code: 'invalid_items' },
    ]);
  });

  it('rejects keys outside the key pattern without naming them', () => {
    for (const key of ['__proto__x', 'Upper', '1st', 'has-dash', '']) {
      assert.deepEqual(
        issues({ type: 'object', properties: { [key]: { type: 'boolean' } } }),
        [{ path: 'properties', code: 'invalid_key' }],
        key,
      );
    }
  });

  it('checks formats, bounds, and enums', () => {
    assert.deepEqual(issues(withField({ type: 'string', format: 'date' })), [
      { path: 'properties.field.format', code: 'invalid_format' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', maxLength: 0 })), [
      { path: 'properties.field.maxLength', code: 'invalid_bound' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', maxLength: 1e9 })), [
      { path: 'properties.field.maxLength', code: 'invalid_bound' },
    ]);
    assert.deepEqual(issues(withField({ type: 'integer', minimum: 0.5 })), [
      { path: 'properties.field.minimum', code: 'invalid_bound' },
    ]);
    assert.deepEqual(issues(withField({ type: 'number', minimum: 2, maximum: 1 })), [
      { path: 'properties.field', code: 'invalid_bounds' },
    ]);
    assert.deepEqual(
      issues(withField({ type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 2 })),
      [{ path: 'properties.field', code: 'invalid_bounds' }],
    );
    assert.deepEqual(issues(withField({ type: 'string', enum: [] })), [
      { path: 'properties.field.enum', code: 'invalid_enum' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', enum: ['a', 'a'] })), [
      { path: 'properties.field.enum.1', code: 'duplicate_enum' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', enum: ['a'], format: 'email' })), [
      { path: 'properties.field', code: 'conflicting_keywords' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', title: ' ' })), [
      { path: 'properties.field.title', code: 'invalid_type' },
    ]);
  });

  it('checks defaults against their field', () => {
    assert.deepEqual(issues(withField({ type: 'string', maxLength: 2, default: 'abc' })), [
      { path: 'properties.field.default', code: 'invalid_default' },
    ]);
    assert.deepEqual(issues(withField({ type: 'integer', default: 1.5 })), [
      { path: 'properties.field.default', code: 'invalid_default' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', enum: ['a'], default: 'b' })), [
      { path: 'properties.field.default', code: 'invalid_default' },
    ]);
    assert.deepEqual(issues(withField({ type: 'string', format: 'uri', default: 'ftp://x' })), [
      { path: 'properties.field.default', code: 'invalid_default' },
    ]);
  });

  it('refuses a default for a secret', () => {
    assert.deepEqual(issues(withField({ type: 'string', format: 'secret', default: 'x' })), [
      { path: 'properties.field.default', code: 'secret_default' },
    ]);
  });

  it('checks required', () => {
    assert.deepEqual(
      issues({ type: 'object', properties: { a: { type: 'boolean' } }, required: ['b'] }),
      [{ path: 'required.0', code: 'unknown_required' }],
    );
    assert.deepEqual(
      issues({ type: 'object', properties: { a: { type: 'boolean' } }, required: ['a', 'a'] }),
      [{ path: 'required.1', code: 'duplicate_required' }],
    );
    assert.deepEqual(
      issues({ type: 'object', properties: { a: { type: 'boolean' } }, required: 'a' }),
      [{ path: 'required', code: 'invalid_type' }],
    );
  });

  it('bounds the number of fields', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`f${index}`, { type: 'boolean' }]),
    );
    assert.deepEqual(issues({ type: 'object', properties }), [
      { path: 'properties', code: 'too_many_fields' },
    ]);
  });
});
