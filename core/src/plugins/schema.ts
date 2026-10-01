/**
 * Plugin-owned schema discovery.
 *
 * The schema commands (`db:push`, `db:diff`, and `jsails test`) read what each
 * plugin owns without calling `setup`, so a plugin can own tables without
 * making every app list its entities by hand. Entity order follows plugin
 * order; duplicates are removed by class identity.
 *
 * A `JsailsPlugin` declares `schema.entities` statically. A plugin whose
 * tables are created by its own migrator (Better Auth's, for `@jsails/auth`)
 * declares their names in `schema.unmanagedTables` instead, so the schema
 * commands leave those live tables alone rather than planning drops.
 *
 * A `definePlugin` instance contributes its schema through the lazy `schema`
 * slot, loaded here and nowhere at config load: its `models` join the entities.
 * Its `tables` and `dataMigrations` are the phased schema planner's shapes;
 * until that planner reads them, a contribution that carries any is refused
 * (`plugin.unsupported_contribution`), because planning without them would
 * leave the plugin's tables uncreated, or plan drops for live ones.
 */

import type { ExtensionEntry } from '../extensions/extension.js';
import type { JsailsPlugin } from '../extensions/plugin-contract.js';
import { isPluginInstance, type PluginInstance } from './contract/instance.js';
import { JsailsError } from '../errors/jsails-error.js';
import { isValidIdentifier } from '../migrations/schema-validation.js';

/** Stable failure code carried by {@link PluginSchemaError}. */
export type PluginSchemaErrorCode = 'invalid_plugin_schema';

/** Raised for a malformed plugin schema declaration. Value-free. */
export class PluginSchemaError extends JsailsError {
  readonly code: PluginSchemaErrorCode = 'invalid_plugin_schema';
}

/**
 * What the enabled plugins own, as the schema commands apply it.
 *
 * @public
 */
export interface PluginSchemaCollection {
  /** Entity (model) classes to register on the data source, in plugin order. */
  readonly entities: readonly Function[];
  /** Live tables a plugin's own migrator owns, which every plan leaves alone. */
  readonly unmanagedTables: readonly string[];
}

/** Return a legacy plugin's schema declaration, or `undefined` when it has none. */
function legacySchema(plugin: JsailsPlugin): JsailsPlugin['schema'] {
  const schema = plugin.schema;
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new PluginSchemaError('plugin schema must be an object');
  }
  return schema;
}

function legacyEntities(plugin: JsailsPlugin): readonly Function[] {
  const declared = legacySchema(plugin)?.entities;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    throw new PluginSchemaError('plugin schema entities must be an array');
  }
  for (const entity of declared) {
    if (typeof entity !== 'function') {
      throw new PluginSchemaError('plugin schema entities must be entity classes');
    }
  }
  return declared;
}

function legacyUnmanagedTables(plugin: JsailsPlugin): readonly string[] {
  const declared = legacySchema(plugin)?.unmanagedTables;
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    throw new PluginSchemaError('plugin schema unmanagedTables must be an array');
  }
  for (const table of declared) {
    if (!isValidIdentifier(table)) {
      throw new PluginSchemaError('plugin schema unmanagedTables must be table names');
    }
  }
  return declared;
}

/**
 * The model classes an instance's `schema` contribution carries; refuses parts
 * nothing applies. The contribution reader is imported here, on the schema
 * commands' path, so the `jsails/plugins` barrel does not load it.
 */
async function contributedModels(instance: PluginInstance): Promise<readonly Function[]> {
  const [{ loadPluginContribution }, { PluginErrors }] = await Promise.all([
    import('./contract/contributions.js'),
    import('./contract/errors.js'),
  ]);
  const schema = await loadPluginContribution(instance, 'schema');
  if (schema === undefined) return [];
  for (const part of ['tables', 'dataMigrations'] as const) {
    if ((schema[part]?.length ?? 0) > 0) {
      throw new PluginErrors.Error('unsupported_contribution', { plugin: instance.name, part });
    }
  }
  return schema.models ?? [];
}

/**
 * Collect what every plugin owns: entity classes (a legacy plugin's
 * `schema.entities`, an instance's contributed `models`) and unmanaged table
 * names (a legacy plugin's `schema.unmanagedTables`, each a plain SQL
 * identifier). Both lists are frozen, deduplicated, and in plugin order.
 * Throws {@link PluginSchemaError} for a malformed legacy declaration,
 * `plugin.invalid_contribution` for a malformed contribution, and
 * `plugin.unsupported_contribution` for one carrying tables or data
 * migrations.
 *
 * @public
 */
export async function collectPluginSchema(
  plugins: readonly ExtensionEntry[],
): Promise<PluginSchemaCollection> {
  const entities = new Set<Function>();
  const tables = new Set<string>();
  for (const plugin of plugins) {
    if (isPluginInstance(plugin)) {
      for (const model of await contributedModels(plugin)) entities.add(model);
      continue;
    }
    for (const entity of legacyEntities(plugin)) entities.add(entity);
    for (const table of legacyUnmanagedTables(plugin)) tables.add(table);
  }
  return Object.freeze({
    entities: Object.freeze([...entities]),
    unmanagedTables: Object.freeze([...tables]),
  });
}
