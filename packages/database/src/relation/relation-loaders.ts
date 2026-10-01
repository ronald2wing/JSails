/**
 * The relation loaders outside a query, each on the data source `model` is
 * bound to and with one lease for all its statements:
 *
 * - `loadRelation(model, records, relation, options)` loads a relation (and
 *   its `include`) onto records already in hand, as `includes` does for a
 *   query's records, and resolves to the same records typed as loaded;
 * - `loadRelationMap(model, parents, relation, options)` resolves to each
 *   parent's value without attaching it, so it also takes plain rows (a
 *   projection, a data handle's read) carrying the key columns: it is what
 *   a batch resolver, such as the admin's relation columns, builds on;
 * - `relationCount(model, parents, relation, { where })` counts each
 *   parent's related rows with one grouped `COUNT(*)` per key chunk.
 *
 * Each costs one statement per level per key chunk; a parent whose key is
 * missing costs nothing and gets an empty value (or a count of 0).
 */

import type { ModelCodecs } from '../codec/model-codecs.js';
import type { SqlValue } from '../engine/contract.js';
import type { Predicate } from '../engine/statement.js';
import { modelDefinition } from '../model/define-model.js';
import type { ModelTarget } from '../model/model-spec.js';
import { dataSourceContext, withLease, type QueryContext } from '../query/query-context.js';
import { boundDataSource } from '../record/data-source.js';
import { DataSourceErrors } from '../record/record-errors.js';
import { TRUE } from '../statement/builders.js';
import { compileWhere, type WhereInput } from '../statement/where.js';
import { decodeColumn, encodeColumn } from '../codec/model-codecs.js';
import { compileInclude, loadNode } from './includes.js';
import { parentKeys, type LoadScope } from './load-relation.js';
import {
  countStatement,
  COUNT_KEY,
  keyCapacity,
  keyChunks,
  keyIdentity,
  OWNER_KEY,
  residualParameters,
} from './load-statement.js';
import { RelationErrors } from './relation-errors.js';
import { resolveLoadPlan, type LoadPlan } from './relation-plan.js';
import { attachLoadedRelation } from './relation-state.js';
import type {
  Loaded,
  RelationKey,
  RelationLoadOptions,
  RelationTarget,
  RelationValue,
} from './relation-types.js';

/** A class model, as the loaders take it. */
type ModelConstructor = abstract new (...args: never[]) => object;

/** Options of {@link relationCount}. */
export interface RelationCountOptions<S> {
  /** Count only the target rows matching this condition. */
  readonly where?: WhereInput<S>;
}

interface Bound {
  readonly context: QueryContext;
  readonly codecs: ModelCodecs;
}

function bound(model: ModelTarget): Bound {
  if (modelDefinition(model) === undefined) throw new DataSourceErrors.Error('not_a_model');
  const context = dataSourceContext(boundDataSource(model));
  return { context, codecs: context.catalog.codecs(model) };
}

function checkParents(
  codecs: ModelCodecs,
  parents: unknown,
  check: (parent: object) => boolean,
): readonly object[] {
  const invalid = (): never => {
    throw new RelationErrors.Error('invalid_parents', { model: codecs.spec.name });
  };
  if (!Array.isArray(parents)) return invalid();
  for (const parent of parents as readonly unknown[]) {
    if (parent === null || typeof parent !== 'object' || !check(parent)) invalid();
  }
  return parents as readonly object[];
}

function checkRelation(codecs: ModelCodecs, relation: unknown): string {
  if (typeof relation !== 'string') {
    throw new RelationErrors.Error('invalid_include', { model: codecs.spec.name });
  }
  return relation;
}

/**
 * Load `relation` of `model` (with `options`, nested `include` included)
 * onto `records`, records of `model` as its queries return them, and resolve
 * to them typed as loaded. Each record holds the relation afterwards, empty
 * or `null` when nothing matched.
 *
 * @throws `relation.invalid_parents` for something other than records of
 *   `model` (or a frozen one), `data_source.not_a_model`,
 *   `data_source.not_bound`, the refusals of a malformed relation or option,
 *   `relation.too_many_rows`, and the load's database failures.
 */
export function loadRelation<
  M extends ModelConstructor,
  T extends InstanceType<M>,
  K extends RelationKey<T>,
  const O extends RelationLoadOptions<RelationTarget<T[K]>> = Record<never, never>,
>(
  model: M,
  records: readonly T[],
  relation: K,
  options?: O,
): Promise<readonly Loaded<T, Readonly<Record<K, O>>>[]>;
export function loadRelation<T extends object = Record<string, unknown>>(
  model: ModelTarget,
  records: readonly T[],
  relation: string,
  options?: RelationLoadOptions<Record<string, unknown>>,
): Promise<readonly T[]>;
export async function loadRelation(
  model: ModelTarget,
  records: readonly object[],
  relation: string,
  options: unknown = true,
): Promise<readonly object[]> {
  const { context, codecs } = bound(model);
  const name = checkRelation(codecs, relation);
  const isClass = typeof model === 'function';
  const parents = checkParents(
    codecs,
    records,
    (record) =>
      Object.isExtensible(record) &&
      (!isClass || (record as { readonly constructor?: unknown }).constructor === model),
  );
  const node = compileInclude(context.catalog, codecs, name, options);
  await withLease(context, false, async (run) => {
    const scope: LoadScope = { context, run: async (statement) => (await run(statement)).rows };
    const values = await loadNode(scope, node, parents);
    for (const [record, value] of values) attachLoadedRelation(record, name, value);
  });
  return parents;
}

/**
 * Each parent's value of `relation` of `model` (with `options`): an array
 * for a to-many relation, the record or `null` otherwise. Nothing is
 * attached to the parents, which may be records or plain rows of `model`
 * carrying the columns the relation is keyed by (a parent missing them maps
 * to an empty value); the loaded records hold their nested `include`.
 *
 * @throws as {@link loadRelation}, with `relation.invalid_parents` for a
 *   parent that is not an object.
 */
export function loadRelationMap<
  M extends ModelConstructor,
  K extends RelationKey<InstanceType<M>>,
  P extends object,
>(
  model: M,
  parents: readonly P[],
  relation: K,
  options?: RelationLoadOptions<RelationTarget<InstanceType<M>[K]>>,
): Promise<ReadonlyMap<P, RelationValue<InstanceType<M>[K]>>>;
export function loadRelationMap<P extends object>(
  model: ModelTarget,
  parents: readonly P[],
  relation: string,
  options?: RelationLoadOptions<Record<string, unknown>>,
): Promise<ReadonlyMap<P, unknown>>;
export async function loadRelationMap(
  model: ModelTarget,
  parents: readonly object[],
  relation: string,
  options: unknown = true,
): Promise<ReadonlyMap<object, unknown>> {
  const { context, codecs } = bound(model);
  const name = checkRelation(codecs, relation);
  const checked = checkParents(codecs, parents, () => true);
  const node = compileInclude(context.catalog, codecs, name, options);
  return withLease(context, false, (run) =>
    loadNode({ context, run: async (statement) => (await run(statement)).rows }, node, checked),
  );
}

/** The count of each key identity of `plan`'s rows matching `where`, for `keys`. */
async function countKeys(
  context: QueryContext,
  plan: LoadPlan,
  keys: readonly SqlValue[],
  where: Predicate,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const first = keys[0];
  if (first === undefined) return counts;
  const { catalog } = context;
  await withLease(context, false, async (run) => {
    const capacity =
      catalog.dialect === 'postgres'
        ? keyCapacity('postgres', 0)
        : keyCapacity(
            catalog.dialect,
            residualParameters(catalog, (sample) => countStatement(plan, sample, where), first),
          );
    for (const chunk of keyChunks(keys, capacity)) {
      const { rows } = await run(countStatement(plan, chunk, where));
      for (const row of rows) {
        const key = encodeColumn(
          plan.match.column,
          decodeColumn(plan.match.column, row[OWNER_KEY]),
        );
        counts.set(keyIdentity(key), Number(row[COUNT_KEY] ?? 0));
      }
    }
  });
  return counts;
}

/**
 * How many rows of `relation` of `model` (matching `options.where`) each of
 * `parents` has, with one grouped `COUNT(*)` per key chunk. `parents` may be
 * records or plain rows carrying the key columns.
 *
 * @throws `relation.not_countable` for a `belongsTo`,
 *   `relation.invalid_option`, `relation.invalid_parents`, and the refusals
 *   and failures of {@link loadRelationMap}.
 */
export function relationCount<
  M extends ModelConstructor,
  K extends RelationKey<InstanceType<M>>,
  P extends object,
>(
  model: M,
  parents: readonly P[],
  relation: K,
  options?: RelationCountOptions<RelationTarget<InstanceType<M>[K]>>,
): Promise<ReadonlyMap<P, number>>;
export function relationCount<P extends object>(
  model: ModelTarget,
  parents: readonly P[],
  relation: string,
  options?: RelationCountOptions<Record<string, unknown>>,
): Promise<ReadonlyMap<P, number>>;
export async function relationCount(
  model: ModelTarget,
  parents: readonly object[],
  relation: string,
  options: RelationCountOptions<object> = {},
): Promise<ReadonlyMap<object, number>> {
  const { context, codecs } = bound(model);
  const name = checkRelation(codecs, relation);
  const checked = checkParents(codecs, parents, () => true);
  const plan = resolveLoadPlan(context.catalog, codecs, name);
  if (plan.kind === 'polymorphic' || plan.kind === 'belongsTo') {
    throw new RelationErrors.Error('not_countable', { model: codecs.spec.name, relation: name });
  }
  const invalid = (): never => {
    throw new RelationErrors.Error('invalid_option', {
      model: codecs.spec.name,
      relation: name,
      option: 'options',
    });
  };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid();
  for (const key of Object.keys(options)) if (key !== 'where') invalid();
  const where =
    options.where === undefined
      ? TRUE
      : compileWhere(plan.target, options.where, plan.target.spec.table);
  const { keys, of } = parentKeys(plan, checked);
  const counts = await countKeys(context, plan, keys, where);
  const result = new Map<object, number>();
  for (const parent of checked) {
    const identity = of.get(parent);
    result.set(parent, identity === undefined ? 0 : (counts.get(identity) ?? 0));
  }
  return result;
}
