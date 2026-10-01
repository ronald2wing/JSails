/**
 * Tests for `collectPluginSchemaEntities` and `collectPluginUnmanagedTables`:
 * plugin-owned schema collection and its validation errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { definePlugin, type JsailsPlugin } from '../../src/extensions/plugin-contract.js';
import {
  collectPluginSchemaEntities,
  collectPluginUnmanagedTables,
  PluginSchemaError,
} from '../../src/plugins/schema.js';

function entity(): Function {
  return class ExampleEntity {};
}

function plugin(schema?: JsailsPlugin['schema']): JsailsPlugin {
  return definePlugin({
    name: 'example',
    ...(schema === undefined ? {} : { schema }),
    setup() {},
  });
}

describe('collectPluginSchemaEntities', () => {
  it('collects and deduplicates entities in plugin order', () => {
    const first = entity();
    const second = entity();
    const result = collectPluginSchemaEntities([
      plugin({ entities: [first, second] }),
      plugin({ entities: [second] }),
      plugin(),
    ]);
    assert.deepEqual(result, [first, second]);
    assert.equal(Object.isFrozen(result), true);
  });

  it('rejects malformed schema declarations value-free', () => {
    assert.throws(
      () => collectPluginSchemaEntities([plugin({ entities: [{} as never] })]),
      (error) => error instanceof PluginSchemaError && error.code === 'invalid_plugin_schema',
    );
    assert.throws(
      () => collectPluginSchemaEntities([plugin({ entities: 'not-an-array' as never })]),
      (error) => error instanceof PluginSchemaError,
    );
  });
});

describe('collectPluginUnmanagedTables', () => {
  it('collects and deduplicates table names in plugin order', () => {
    const result = collectPluginUnmanagedTables([
      plugin({ unmanagedTables: ['user', 'session'] }),
      plugin({ entities: [entity()], unmanagedTables: ['session', 'twoFactor'] }),
      plugin(),
    ]);
    assert.deepEqual(result, ['user', 'session', 'twoFactor']);
    assert.equal(Object.isFrozen(result), true);
  });

  it('rejects malformed declarations value-free', () => {
    for (const unmanagedTables of ['user', ['user; drop table posts'], [42]]) {
      assert.throws(
        () => collectPluginUnmanagedTables([plugin({ unmanagedTables: unmanagedTables as never })]),
        (error) =>
          error instanceof PluginSchemaError &&
          error.code === 'invalid_plugin_schema' &&
          !error.message.includes('drop table'),
      );
    }
  });
});
