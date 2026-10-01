/**
 * Tests for `collectPluginSchema`: entity and unmanaged-table collection from
 * legacy plugins' `schema` declarations and from `definePlugin` instances'
 * lazy `schema` contributions, and its value-free validation errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { definePlugin, type JsailsPlugin } from '../../src/extensions/plugin-contract.js';
import { definePlugin as defineKernelPlugin } from '../../src/plugins/contract/define-plugin.js';
import { PluginErrors } from '../../src/plugins/contract/errors.js';
import { lazy, type PluginSchemaContribution } from '../../src/plugins/contract/instance.js';
import { collectPluginSchema, PluginSchemaError } from '../../src/plugins/schema.js';

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

/** An instance whose `schema` module default-exports `contribution`; its setup is never run. */
function contributor(name: string, contribution: unknown) {
  return defineKernelPlugin({
    name,
    schema: lazy(async () => ({ default: contribution as PluginSchemaContribution })),
    setup() {
      throw new Error('setup ran');
    },
  })();
}

describe('collectPluginSchema: legacy declarations', () => {
  it('collects and deduplicates entities in plugin order', async () => {
    const first = entity();
    const second = entity();
    const result = await collectPluginSchema([
      plugin({ entities: [first, second] }),
      plugin({ entities: [second] }),
      plugin(),
    ]);
    assert.deepEqual(result.entities, [first, second]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.entities));
  });

  it('collects and deduplicates unmanaged table names in plugin order', async () => {
    const result = await collectPluginSchema([
      plugin({ unmanagedTables: ['user', 'session'] }),
      plugin({ entities: [entity()], unmanagedTables: ['session', 'twoFactor'] }),
      plugin(),
    ]);
    assert.deepEqual(result.unmanagedTables, ['user', 'session', 'twoFactor']);
    assert.equal(Object.isFrozen(result.unmanagedTables), true);
  });

  it('rejects malformed entity declarations value-free', async () => {
    for (const entities of [[{}], 'not-an-array']) {
      await assert.rejects(
        collectPluginSchema([plugin({ entities: entities as never })]),
        (error) => error instanceof PluginSchemaError && error.code === 'invalid_plugin_schema',
      );
    }
  });

  it('rejects malformed unmanaged tables value-free', async () => {
    for (const unmanagedTables of ['user', ['user; drop table posts'], [42]]) {
      await assert.rejects(
        collectPluginSchema([plugin({ unmanagedTables: unmanagedTables as never })]),
        (error) =>
          error instanceof PluginSchemaError &&
          error.code === 'invalid_plugin_schema' &&
          !error.message.includes('drop table'),
      );
    }
  });
});

describe('collectPluginSchema: definePlugin contributions', () => {
  it('collects contributed models beside legacy entities, without running setup', async () => {
    const legacy = entity();
    const model = entity();
    const result = await collectPluginSchema([
      plugin({ entities: [legacy] }),
      contributor('owner', { models: [model, legacy], tables: [], dataMigrations: [] }),
      defineKernelPlugin({ name: 'plain', setup() {} })(),
    ]);
    assert.deepEqual(result.entities, [legacy, model]);
    assert.deepEqual(result.unmanagedTables, []);
  });

  it('refuses table specs and data migrations the schema commands cannot apply', async () => {
    for (const [part, contribution] of [
      ['tables', { models: [entity()], tables: [{ name: 'owner_rows' }] }],
      ['dataMigrations', { dataMigrations: [{ name: 'backfill' }] }],
    ] as const) {
      await assert.rejects(
        collectPluginSchema([contributor('owner', contribution)]),
        (error: unknown) =>
          PluginErrors.is(error, 'unsupported_contribution') &&
          error.context['plugin'] === 'owner' &&
          error.context['part'] === part,
      );
    }
  });

  it('refuses models that are not classes', async () => {
    await assert.rejects(
      collectPluginSchema([contributor('owner', { models: [{ name: 'Post' }] })]),
      (error: unknown) =>
        PluginErrors.is(error, 'invalid_contribution') && error.context['slot'] === 'schema',
    );
  });
});
