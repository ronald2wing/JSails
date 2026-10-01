import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectSettingsSchema, SettingsProjectionError } from '../../src/directory/index.js';

describe('projectSettingsSchema', () => {
  it('returns an empty frozen list for an absent schema', () => {
    const fields = projectSettingsSchema(undefined);
    assert.deepEqual(fields, []);
    assert.equal(Object.isFrozen(fields), true);
  });

  it('projects bare shorthand fields as the editable type', () => {
    const fields = projectSettingsSchema({
      retries: 'number',
      verbose: 'boolean',
      token: 'string',
    });
    assert.deepEqual(fields, [
      { key: 'retries', type: 'number', label: 'retries' },
      { key: 'verbose', type: 'boolean', label: 'verbose' },
      { key: 'token', type: 'string', label: 'token' },
    ]);
  });

  it('projects { type, label, default } objects and their scalar defaults', () => {
    const fields = projectSettingsSchema({
      retries: { type: 'number', label: 'Max retries', default: 3 },
      verbose: { type: 'boolean', label: 'Verbose', default: true },
      token: { type: 'string', label: 'API token' },
      mismatch: { type: 'number', label: 'Mismatched', default: 'not-a-number' },
    });
    assert.deepEqual(fields, [
      { key: 'retries', type: 'number', label: 'Max retries', defaultValue: 3 },
      { key: 'verbose', type: 'boolean', label: 'Verbose', defaultValue: true },
      { key: 'token', type: 'string', label: 'API token' },
      // A default of the wrong scalar type is dropped, never coerced.
      { key: 'mismatch', type: 'number', label: 'Mismatched' },
    ]);
  });

  it('projects unknown shapes as read-only', () => {
    const fields = projectSettingsSchema({
      complex: { type: 'object' },
      list: ['a', 'b'],
      scalar: 42,
      nested: { type: 'integer' },
    });
    assert.deepEqual(fields, [
      { key: 'complex', type: 'unknown', label: 'complex' },
      { key: 'list', type: 'unknown', label: 'list' },
      { key: 'scalar', type: 'unknown', label: 'scalar' },
      { key: 'nested', type: 'unknown', label: 'nested' },
    ]);
  });

  it('projects forbidden prototype keys as read-only', () => {
    const schema = JSON.parse('{"__proto__":"string","constructor":"string"}') as Record<
      string,
      unknown
    >;
    const fields = projectSettingsSchema(schema);
    assert.deepEqual(fields, [
      { key: '__proto__', type: 'unknown', label: '__proto__' },
      { key: 'constructor', type: 'unknown', label: 'constructor' },
    ]);
  });

  it('bounds the projection to the field limit', () => {
    const schema: Record<string, unknown> = {};
    for (let i = 0; i < 105; i += 1) {
      schema[`field${i}`] = 'string';
    }
    assert.equal(projectSettingsSchema(schema).length, 100);
  });

  it('rejects a non-object schema value-free', () => {
    assert.throws(
      () => projectSettingsSchema('not-a-schema' as unknown as Record<string, unknown>),
      (error: unknown) => error instanceof SettingsProjectionError,
    );
  });

  it('never exposes unknown field values and freezes descriptors', () => {
    const fields = projectSettingsSchema({
      secret: { password: 'hunter2' },
      retries: 'number',
    });
    const secret = fields[0];
    assert.ok(secret);
    assert.deepEqual(Object.keys(secret).sort(), ['key', 'label', 'type']);
    assert.equal(Object.isFrozen(secret), true);
    assert.equal(Object.isFrozen(fields), true);
  });
});
