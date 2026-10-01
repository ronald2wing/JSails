/**
 * Reading a plugin's contributions without running its setup.
 *
 * A contribution slot (`schema`, `jobs`, `schedules`, `release`) is a lazily
 * loaded module, so listing a plugin in a config imports none of it; a tool
 * that needs one slot (`db:push` the schema, a worker the jobs) loads that
 * module alone. This module checks the outer shape the kernel defines (an
 * array of objects, or the schema's arrays: model classes, table and data
 * migration objects) and freezes it; the package that reads the slot
 * validates each element against its own contract.
 */

import { isRecord } from '../../json/shape.js';
import { PluginErrors } from './errors.js';
import {
  isPluginInstance,
  runtimeDefinitionOf,
  type PluginContributions,
  type PluginContributionSlot,
  type PluginDefinition,
  type PluginInstance,
  type PluginRuntimeDefinition,
} from './instance.js';

/** Something that carries a definition: an instance, or the factory `definePlugin` returned. */
type DefinitionCarrier = PluginInstance | { readonly definition: PluginDefinition };

/** Each key of the schema contribution, and whether its elements are classes or objects. */
const SCHEMA_KEYS: ReadonlyMap<string, 'class' | 'object'> = new Map([
  ['models', 'class'],
  ['tables', 'object'],
  ['dataMigrations', 'object'],
]);

function isObjectList(value: unknown): value is readonly object[] {
  return (
    Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === 'object')
  );
}

function isClassList(value: unknown): value is readonly object[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'function');
}

function definitionOf(carrier: DefinitionCarrier): PluginRuntimeDefinition {
  if (isPluginInstance(carrier)) return runtimeDefinitionOf(carrier);
  return carrier.definition as PluginRuntimeDefinition;
}

/** The checked, frozen value of one slot's module default export. */
function checkContribution<S extends PluginContributionSlot>(
  plugin: string,
  slot: S,
  value: unknown,
): PluginContributions[S] {
  const invalid = (): Error => new PluginErrors.Error('invalid_contribution', { plugin, slot });
  if (slot !== 'schema') {
    if (!isObjectList(value)) throw invalid();
    return Object.freeze([...value]);
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !SCHEMA_KEYS.has(key))) throw invalid();
  const schema: Record<string, readonly object[]> = {};
  for (const [key, element] of SCHEMA_KEYS) {
    const list = value[key];
    if (list === undefined) continue;
    const valid = element === 'class' ? isClassList(list) : isObjectList(list);
    if (!valid || !Array.isArray(list)) throw invalid();
    schema[key] = Object.freeze([...(list as readonly object[])]);
  }
  return Object.freeze(schema) as unknown as PluginContributions[S];
}

/**
 * Load what `plugin` contributes to `slot`, or `undefined` when it fills no
 * such slot. Throws `plugin.invalid_contribution` when the module's default
 * export does not have the slot's shape.
 *
 * @public
 */
export async function loadPluginContribution<S extends PluginContributionSlot>(
  plugin: DefinitionCarrier,
  slot: S,
): Promise<PluginContributions[S] | undefined> {
  const definition = definitionOf(plugin);
  const module = definition.contributions[slot];
  if (module === undefined) return undefined;
  const loaded: unknown = await module.load();
  const value: unknown = isRecord(loaded) ? loaded['default'] : undefined;
  return checkContribution(definition.name, slot, value);
}
