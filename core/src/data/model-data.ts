/**
 * Model-field data-contract registry.
 *
 * `@jsails.data(Contract)` runs as a property decorator, before the generated
 * `defineModel` call. The decorator records the contract here; `defineModel`
 * reads it back and wires persistence-time validation.
 *
 * The registry is keyed by the entity constructor, so a re-imported model never
 * leaks a contract onto another class. It is intentionally not exported from
 * `jsails/data`: model wiring is an internal concern of the model layer.
 */

import type { AnyDataContract } from './define-data.js';

const dataContractsByEntity = new WeakMap<object, Map<string, AnyDataContract>>();

/** Read the data contract attached to a model field, if any. */
export function resolveDataContract(entity: object, property: string): AnyDataContract | undefined {
  return dataContractsByEntity.get(entity)?.get(property);
}

/** Record a data contract for a model field. */
export function registerDataContract(
  target: object,
  property: string | symbol,
  contract: AnyDataContract,
): void {
  if (typeof property !== 'string') return;
  const constructor = (target as { constructor?: object }).constructor;
  if (constructor === undefined) return;
  let fields = dataContractsByEntity.get(constructor);
  if (fields === undefined) {
    fields = new Map<string, AnyDataContract>();
    dataContractsByEntity.set(constructor, fields);
  }
  fields.set(property, contract);
}
