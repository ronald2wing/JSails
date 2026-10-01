/**
 * Plugin-owned schema discovery.
 *
 * A plugin may declare `schema.entities` statically. The schema commands read
 * that declaration without calling `setup`, so a plugin can own tables without
 * making every app list its entities by hand. Entity order follows plugin order;
 * duplicates are removed by class identity.
 *
 * A plugin whose tables are created by its own migrator (Better Auth's, for
 * `@jsails/auth`) declares their names in `schema.unmanagedTables` instead, so
 * the schema commands leave those live tables alone rather than planning drops.
 */

import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import { JsailsError } from '../errors/jsails-error.js';
import { isValidIdentifier } from '../migrations/schema-validation.js';

/** Stable failure code carried by {@link PluginSchemaError}. */
export type PluginSchemaErrorCode = 'invalid_plugin_schema';

/** Raised for a malformed plugin schema declaration. Value-free. */
export class PluginSchemaError extends JsailsError {
  readonly code: PluginSchemaErrorCode = 'invalid_plugin_schema';
}

/** Return a plugin's schema declaration, or `undefined` when it has none. */
function pluginSchema(plugin: JsailsPlugin): JsailsPlugin['schema'] {
  const schema = plugin.schema;
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new PluginSchemaError('plugin schema must be an object');
  }
  return schema;
}

/**
 * Collect the entity classes declared by every plugin. Plugins without a schema
 * contribute nothing. The returned array is frozen and deduplicated by identity.
 */
export function collectPluginSchemaEntities(plugins: readonly JsailsPlugin[]): readonly Function[] {
  const entities = new Set<Function>();
  for (const plugin of plugins) {
    const declared = pluginSchema(plugin)?.entities;
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

/**
 * Collect the table names every plugin declares as unmanaged: owned by the
 * plugin's own migrator, so `db:push`/`db:diff` plan no operation for them.
 * Each name must be a plain SQL identifier. The returned array is frozen,
 * deduplicated, and in plugin order.
 */
export function collectPluginUnmanagedTables(plugins: readonly JsailsPlugin[]): readonly string[] {
  const tables = new Set<string>();
  for (const plugin of plugins) {
    const declared = pluginSchema(plugin)?.unmanagedTables;
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      throw new PluginSchemaError('plugin schema unmanagedTables must be an array');
    }
    for (const table of declared) {
      if (!isValidIdentifier(table)) {
        throw new PluginSchemaError('plugin schema unmanagedTables must be table names');
      }
      tables.add(table);
    }
  }
  return Object.freeze([...tables]);
}
