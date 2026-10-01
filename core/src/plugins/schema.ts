/**
 * Plugin-owned schema discovery.
 *
 * A plugin may declare `schema.entities` statically. The schema commands read
 * that declaration without calling `setup`, so a plugin can own tables without
 * making every app list its entities by hand. Entity order follows plugin order;
 * duplicates are removed by class identity.
 */

import type { JsailsPlugin } from '../extensions/plugin-contract.js';

/** Raised for a malformed plugin schema declaration. Value-free. */
export class PluginSchemaError extends Error {
  readonly code = 'invalid_plugin_schema';

  constructor(message: string) {
    super(message);
    this.name = 'PluginSchemaError';
  }
}

/**
 * Collect the entity classes declared by every plugin. Plugins without a schema
 * contribute nothing. The returned array is frozen and deduplicated by identity.
 */
export function collectPluginSchemaEntities(plugins: readonly JsailsPlugin[]): readonly Function[] {
  const entities = new Set<Function>();
  for (const plugin of plugins) {
    const schema = plugin.schema;
    if (schema === undefined) continue;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new PluginSchemaError('plugin schema must be an object');
    }
    const declared = schema.entities;
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      throw new PluginSchemaError('plugin schema entities must be an array');
    }
    for (const entity of declared) {
      if (typeof entity !== 'function') {
        throw new PluginSchemaError('plugin schema entities must be entity classes');
      }
      entities.add(entity);
    }
  }
  return Object.freeze([...entities]);
}
