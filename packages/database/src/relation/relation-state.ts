/**
 * Whether a record holds a relation, how it came to hold it, and the
 * accessors that make an unloaded relation impossible to mistake for an
 * empty one.
 *
 * `defineModel` installs, on the class prototype, one accessor per relation:
 * reading it throws `relation.not_loaded`; assigning it gives the record an
 * own, enumerable data property of that name. A load does the same. The own
 * property shadows the accessor, so a loaded or assigned relation reads and
 * writes as a plain property (JSON and spreading see it), while an unloaded
 * one is invisible to `Object.keys`, JSON and spreading and throws when read.
 * "The record holds the relation" is therefore exactly "it has the own
 * property", which is what autosave and the loader read ({@link heldRelation}).
 *
 * How the record came to hold it matters to autosave, which must not undo a
 * key the application changed: a load records the records it attached
 * ({@link loadedMember}), an assignment forgets them, and a save that
 * pointed the keys at what the relation holds records it as loaded again
 * ({@link settleRelation}).
 *
 * The accessors resolve the record's own model when they run: a subclass of
 * a model is a model of its own, so a relation it repeats is its own (it
 * installs its own accessor over the inherited one), and a relation of the
 * parent it does not declare is no relation of it (reading one throws
 * `query.unknown_relation`, or reads `undefined` when the subclass has a
 * column or attachment of that name).
 *
 * A `defineTable` row has no class to carry accessors: its loaded relations
 * are own properties too, and an unloaded one reads `undefined`.
 */

import { ModelSpecError } from '../model/model-error.js';
import type { NormalizedSpec } from '../model/model-spec.js';
import { QueryErrors } from '../query/query-errors.js';
import { RelationErrors } from './relation-errors.js';

/** Per record, per relation name, the records the last load (or settled save) attached. */
const LOADED = new WeakMap<object, Map<string, ReadonlySet<object>>>();

/** The spec of each model prototype `installRelationAccessors` was given. */
const MODEL_PROTOTYPES = new WeakMap<object, NormalizedSpec>();

/** The relation getters `installRelationAccessors` installed, to tell them from class members. */
const RELATION_GETTERS = new WeakSet<object>();

function membersOf(value: unknown): ReadonlySet<object> {
  const items: readonly unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  const members = new Set<object>();
  for (const item of items) if (item !== null && typeof item === 'object') members.add(item);
  return members;
}

function defineHeld(record: object, name: string, value: unknown): void {
  Object.defineProperty(record, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Give `record` the relation `name` holding `value`, as the application assigned it. */
export function attachRelation(record: object, name: string, value: unknown): void {
  defineHeld(record, name, value);
  LOADED.get(record)?.delete(name);
}

/** Give `record` the relation `name` holding `value`, as a load read it from the database. */
export function attachLoadedRelation(record: object, name: string, value: unknown): void {
  defineHeld(record, name, value);
  let loaded = LOADED.get(record);
  if (loaded === undefined) {
    loaded = new Map();
    LOADED.set(record, loaded);
  }
  loaded.set(name, membersOf(value));
}

/** The value of relation `name` that `record` holds (loaded or assigned), or `undefined`. */
export function heldRelation(record: object, name: string): unknown {
  return Object.hasOwn(record, name) ? (record as Record<string, unknown>)[name] : undefined;
}

/**
 * Whether `item` is one of the records the relation `name` of `record` held
 * when it was last loaded (or settled), rather than one the application
 * assigned or added since.
 */
export function loadedMember(record: object, name: string, item: object): boolean {
  return LOADED.get(record)?.get(name)?.has(item) === true;
}

/**
 * Record what relation `name` of `record` holds now as loaded: a save has
 * pointed the keys at it, so a later change of those keys is the
 * application's to keep. Returns the undo that puts the previous state back,
 * for a rollback that takes the save's keys back.
 */
export function settleRelation(record: object, name: string): () => void {
  let loaded = LOADED.get(record);
  if (loaded === undefined) {
    loaded = new Map();
    LOADED.set(record, loaded);
  }
  const map = loaded;
  const previous = map.get(name);
  map.set(name, membersOf(heldRelation(record, name)));
  return () => {
    if (previous === undefined) map.delete(name);
    else map.set(name, previous);
  };
}

/** Drop every relation `record` holds, so each reads as not loaded again. */
export function unloadRelations(record: object, spec: NormalizedSpec): void {
  for (const name of Object.keys(spec.relations)) Reflect.deleteProperty(record, name);
  LOADED.delete(record);
}

/** The spec of the nearest model in `record`'s prototype chain, starting with `record`. */
function modelOf(record: object): NormalizedSpec | undefined {
  for (let level: object | null = record; level !== null; level = Object.getPrototypeOf(level)) {
    const spec = MODEL_PROTOTYPES.get(level);
    if (spec !== undefined) return spec;
  }
  return undefined;
}

/** Whether `name` is a column property or an attachment of `spec`. */
function isProperty(spec: NormalizedSpec, name: string): boolean {
  return (
    Object.hasOwn(spec.attachments, name) ||
    spec.columns.some((resolved) => resolved.property === name)
  );
}

/**
 * Whether `name` is a member of `prototype` or its chain other than a
 * relation accessor a model's definition installed.
 */
function classMember(prototype: object, name: string): boolean {
  for (let level: object | null = prototype; level !== null; level = Object.getPrototypeOf(level)) {
    const descriptor = Object.getOwnPropertyDescriptor(level, name);
    if (descriptor === undefined) continue;
    if (descriptor.get === undefined || !RELATION_GETTERS.has(descriptor.get)) return true;
  }
  return false;
}

function relationGetter(name: string, installer: NormalizedSpec): (this: object) => unknown {
  return function (this: object): unknown {
    const spec = modelOf(this) ?? installer;
    if (Object.hasOwn(spec.relations, name)) {
      throw new RelationErrors.Error('not_loaded', { model: spec.name, relation: name });
    }
    if (isProperty(spec, name)) return undefined;
    throw new QueryErrors.Error('unknown_relation', { model: spec.name, relation: name });
  };
}

/**
 * Install the relation accessors of `spec` on `Class.prototype`, and record
 * the prototype as `spec`'s model.
 *
 * @throws `ModelSpecError('invalid_relation')` when a relation name is
 *   already a member of the class or its prototype chain (a method, a getter,
 *   `toString`): the accessor would hide it, or it would hide the relation.
 *   A relation accessor a parent model's definition installed is no such
 *   member: the subclass's own accessor replaces it.
 */
export function installRelationAccessors(
  Class: abstract new (...args: never[]) => object,
  spec: NormalizedSpec,
): void {
  const prototype: unknown = Class.prototype;
  if (prototype === null || typeof prototype !== 'object') {
    throw new ModelSpecError('invalid_spec', { model: spec.name, field: 'class' });
  }
  const names = Object.keys(spec.relations);
  for (const name of names) {
    if (classMember(prototype, name)) {
      throw new ModelSpecError('invalid_relation', {
        model: spec.name,
        field: `relations.${name}`,
      });
    }
  }
  for (const name of names) {
    const get = relationGetter(name, spec);
    RELATION_GETTERS.add(get);
    Object.defineProperty(prototype, name, {
      get,
      set(this: object, value: unknown) {
        attachRelation(this, name, value);
      },
      enumerable: false,
      configurable: false,
    });
  }
  MODEL_PROTOTYPES.set(prototype, spec);
}
