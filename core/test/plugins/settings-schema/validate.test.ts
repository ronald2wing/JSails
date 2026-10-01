/** Tests for `validateSettings` and `describeSettings`. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeSettings,
  parseSettingsSchema,
  validateSettings,
  type SettingsSchema,
} from '../../../src/plugins/settings-schema/index.js';

function schema(raw: unknown): SettingsSchema {
  const result = parseSettingsSchema(raw);
  assert.ok(result.ok, 'the fixture schema must parse');
  return result.schema;
}

const TASKS = schema({
  type: 'object',
  properties: {
    siteName: { type: 'string', title: 'Site name', maxLength: 10, default: 'Tasks' },
    contact: { type: 'string', format: 'email' },
    homepage: { type: 'string', format: 'uri' },
    intro: { type: 'string', format: 'textarea' },
    apiKey: { type: 'string', format: 'secret' },
    theme: { type: 'string', enum: ['light', 'dark'] },
    ratio: { type: 'number', minimum: 0, maximum: 1 },
    retries: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
    enabled: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string', maxLength: 5 }, maxItems: 2 },
    channels: { type: 'array', items: { type: 'string', enum: ['mail', 'sms'] }, minItems: 1 },
  },
  required: ['apiKey'],
});

function codes(value: unknown): readonly { path: string; code: string }[] {
  const result = validateSettings(TASKS, value);
  assert.equal(result.ok, false, 'the value must be refused');
  return result.ok
    ? []
    : result.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
}

describe('validateSettings', () => {
  it('accepts a value, fills defaults, and returns only schema keys', () => {
    const result = validateSettings(TASKS, {
      apiKey: 'k',
      contact: 'ops@example.com',
      homepage: 'https://example.com/a',
      intro: 'line one\nline two',
      theme: 'dark',
      ratio: 0.25,
      enabled: false,
      tags: ['a', 'b'],
      channels: ['sms'],
    });
    assert.ok(result.ok);
    assert.deepEqual(result.value, {
      siteName: 'Tasks',
      contact: 'ops@example.com',
      homepage: 'https://example.com/a',
      intro: 'line one\nline two',
      apiKey: 'k',
      theme: 'dark',
      ratio: 0.25,
      retries: 3,
      enabled: false,
      tags: ['a', 'b'],
      channels: ['sms'],
    });
    assert.ok(Object.isFrozen(result.value));
    assert.ok(Object.isFrozen(result.value['tags']));
  });

  it('treats an undefined value as absent', () => {
    const result = validateSettings(TASKS, { apiKey: 'k', contact: undefined });
    assert.ok(result.ok);
    assert.equal(Object.hasOwn(result.value, 'contact'), false);
  });

  it('requires a required field with no default', () => {
    assert.deepEqual(codes({}), [{ path: 'apiKey', code: 'required' }]);
  });

  it('refuses a non-object value', () => {
    for (const value of [null, [], 'x', 1]) {
      assert.deepEqual(codes(value), [{ path: '', code: 'invalid_type' }]);
    }
  });

  it('reports an unknown key once, at the root, without naming it', () => {
    assert.deepEqual(codes({ apiKey: 'k', secretExtra: 1, another: 2 }), [
      { path: '', code: 'unknown_key' },
    ]);
  });

  it('checks every rule', () => {
    const cases: readonly (readonly [string, unknown, string, string?])[] = [
      ['siteName', 5, 'invalid_type'],
      ['siteName', 'x'.repeat(11), 'too_long'],
      ['siteName', 'a\nb', 'invalid_format'],
      ['contact', 'not-an-email', 'invalid_format'],
      ['contact', 'a b@example.com', 'invalid_format'],
      ['homepage', 'javascript:alert(1)', 'invalid_format'],
      ['homepage', 'not a url', 'invalid_format'],
      ['apiKey', 'line\nbreak', 'invalid_format'],
      ['theme', 'blue', 'invalid_enum'],
      ['ratio', Number.NaN, 'invalid_type'],
      ['ratio', 2, 'too_big'],
      ['ratio', -1, 'too_small'],
      ['retries', 1.5, 'not_integer'],
      ['retries', '3', 'invalid_type'],
      ['enabled', 'true', 'invalid_type'],
      ['tags', 'a', 'invalid_type'],
      ['tags', ['a', 'b', 'c'], 'too_many'],
      ['tags', ['toolong'], 'too_long', 'tags.0'],
      ['tags', [1], 'invalid_type', 'tags.0'],
      ['channels', [], 'too_few'],
      ['channels', ['fax'], 'invalid_enum', 'channels.0'],
    ];
    for (const [key, value, code, path] of cases) {
      assert.deepEqual(
        codes({ apiKey: 'k', [key]: value }),
        [{ path: path ?? key, code }],
        `${key}: ${code}`,
      );
    }
  });

  it('bounds an unbounded string and list', () => {
    const open = schema({
      type: 'object',
      properties: {
        text: { type: 'string', format: 'textarea' },
        list: { type: 'array', items: { type: 'string' } },
      },
    });
    const long = validateSettings(open, { text: 'x'.repeat(65_537) });
    assert.equal(long.ok, false);
    const many = validateSettings(open, { list: Array.from({ length: 1001 }, () => 'a') });
    assert.equal(many.ok, false);
  });
});

describe('describeSettings', () => {
  it('projects every field into a form descriptor in schema order', () => {
    const fields = describeSettings(TASKS);
    assert.deepEqual(
      fields.map((field) => [field.key, field.control]),
      [
        ['siteName', 'text'],
        ['contact', 'email'],
        ['homepage', 'uri'],
        ['intro', 'textarea'],
        ['apiKey', 'secret'],
        ['theme', 'select'],
        ['ratio', 'number'],
        ['retries', 'integer'],
        ['enabled', 'checkbox'],
        ['tags', 'list'],
        ['channels', 'multiselect'],
      ],
    );
    assert.deepEqual(fields[0], {
      key: 'siteName',
      control: 'text',
      label: 'Site name',
      required: false,
      default: 'Tasks',
      maxLength: 10,
    });
    assert.deepEqual(fields[4], {
      key: 'apiKey',
      control: 'secret',
      label: 'apiKey',
      required: true,
    });
    assert.deepEqual(fields[5]?.options, ['light', 'dark']);
    assert.deepEqual(
      { minimum: fields[6]?.minimum, maximum: fields[6]?.maximum },
      { minimum: 0, maximum: 1 },
    );
    assert.deepEqual(
      { maxLength: fields[9]?.maxLength, maxItems: fields[9]?.maxItems },
      { maxLength: 5, maxItems: 2 },
    );
    assert.deepEqual(fields[10]?.minItems, 1);
    assert.ok(Object.isFrozen(fields));
    assert.ok(fields.every((field) => Object.isFrozen(field)));
  });
});
