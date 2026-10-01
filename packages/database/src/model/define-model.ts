/**
 * `defineModel(Class, spec)` and `defineTable(spec)`: validate a spec,
 * normalize and freeze it, and attach it under
 * `Symbol.for('jsails.model.spec')`, a registry-wide symbol, so a second copy
 * of this package reads a model the first copy defined. Neither imports an
 * engine or keeps a module-level registry: the model list of a data source is
 * whatever the application passes it.
 */

import { checkBehavior, type RecordBehavior } from '../record/hooks.js';
import { installRelationAccessors } from '../relation/relation-state.js';
import { ModelSpecError } from './model-error.js';
import type { ModelDefinition, ModelSpec, ModelTarget, NormalizedSpec } from './model-spec.js';
import { normalizeSpec } from './spec-validation.js';

/** The symbol a model's {@link ModelDefinition} is attached under. */
export const MODEL_SPEC: unique symbol = Symbol.for('jsails.model.spec') as never;

/** A class `defineModel` attached a spec to. */
export type ModelClass<
  T extends abstract new (...args: never[]) => object = abstract new (...args: never[]) => object,
> = T & { readonly [MODEL_SPEC]: ModelDefinition };

/** What `defineTable` returns: a class-less model. */
export interface TableDefinition extends ModelDefinition {
  readonly kind: 'table';
  readonly [MODEL_SPEC]: ModelDefinition;
}

function attach(target: object, definition: ModelDefinition): void {
  Object.defineProperty(target, MODEL_SPEC, {
    value: definition,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * Attach `spec` to `Class` and return the class. The class's name is the
 * model's name unless the spec sets `name`. A class can be defined once; a
 * subclass of a model is not that model and needs its own definition.
 * `behavior` holds the record hooks and validation the write pipeline runs
 * around a record write (`record/hooks.ts`); it is checked and frozen here.
 * Each relation becomes an accessor on the class prototype that throws
 * `relation.not_loaded` until the record holds the relation
 * (`relation/relation-state.ts`); a relation named like a member of the
 * class is refused.
 */
export function defineModel<T extends abstract new (...args: never[]) => object>(
  Class: T,
  spec: ModelSpec,
  behavior?: RecordBehavior<InstanceType<T>>,
): ModelClass<T> {
  if (typeof Class !== 'function') throw new ModelSpecError('invalid_spec', { field: 'class' });
  if (Object.hasOwn(Class, MODEL_SPEC)) {
    throw new ModelSpecError('already_defined', { model: Class.name });
  }
  const normalized = normalizeSpec(spec, Class.name === '' ? undefined : Class.name);
  const definition: ModelDefinition = Object.freeze({
    kind: 'model',
    spec: normalized,
    ...(behavior === undefined ? {} : { behavior: checkBehavior(behavior, normalized.name) }),
  });
  installRelationAccessors(Class, normalized);
  attach(Class, definition);
  return Class as ModelClass<T>;
}

/**
 * A class-less model, for tables that need no record class (link tables,
 * tables another package reads with plain statements). Relations may target
 * it as they target a model class.
 */
export function defineTable(spec: ModelSpec): TableDefinition {
  const table: { kind: 'table'; spec: NormalizedSpec } = {
    kind: 'table',
    spec: normalizeSpec(spec, undefined),
  };
  attach(table, table);
  return Object.freeze(table) as TableDefinition;
}

/**
 * The definition attached to `target` by `defineModel` or `defineTable`, or
 * `undefined`. Only an own definition counts, so a subclass of a model is
 * not mistaken for it.
 */
export function modelDefinition(target: unknown): ModelDefinition | undefined {
  if ((typeof target !== 'function' && typeof target !== 'object') || target === null) {
    return undefined;
  }
  if (!Object.hasOwn(target, MODEL_SPEC)) return undefined;
  const definition = (target as { [MODEL_SPEC]?: unknown })[MODEL_SPEC];
  if (definition === null || typeof definition !== 'object') return undefined;
  const { kind, spec } = definition as Partial<ModelDefinition>;
  return (kind === 'model' || kind === 'table') && spec !== undefined
    ? (definition as ModelDefinition)
    : undefined;
}

/** The normalized spec of a model or table; throws when `target` is neither. */
export function modelSpec(target: ModelTarget): NormalizedSpec {
  const definition = modelDefinition(target);
  if (definition === undefined) throw new ModelSpecError('unresolved_relation');
  return definition.spec;
}
