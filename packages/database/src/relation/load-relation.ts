/**
 * One level of a relation load: the related records of a set of parents,
 * read with one statement per key chunk (`load-statement.ts`) and grouped by
 * the column each row carries, so nothing is read twice. The result maps
 * every parent to its value: a fresh array for a to-many relation (empty when
 * nothing matched), the record or `null` otherwise. One fetched row is one
 * record, so parents that share a `belongsTo` target share the object.
 *
 * A parent's key is read from its current column value, so a load agrees
 * with the record as it is now; a parent whose key is `null` or unset has an
 * empty value and costs nothing. A level whose keys are all missing runs no
 * statement.
 *
 * `maxRows` bounds a level: a plain load asks for at most `maxRows + 1` rows
 * (over all its chunks), a windowed one is bounded by its per-parent limit,
 * and reading more than `maxRows` throws `relation.too_many_rows`. Nothing
 * is ever cut off silently.
 */

import { hydrate } from '../codec/hydrate.js';
import { decodeColumn, encodeColumn, type ModelCodecs } from '../codec/model-codecs.js';
import type { Row, SqlValue } from '../engine/contract.js';
import type { OrderTerm, Predicate, SelectStatement } from '../engine/statement.js';
import type { QueryContext } from '../query/query-context.js';
import { DataSourceErrors } from '../record/record-errors.js';
import {
  keyCapacity,
  keyChunks,
  keyIdentity,
  loadStatement,
  OWNER_KEY,
  residualParameters,
  type LoadShape,
} from './load-statement.js';
import { RelationErrors } from './relation-errors.js';
import { polymorphicTarget, type LoadPlan, type RelationPlan } from './relation-plan.js';

/** Where a load runs: its query context, and the lease its statements run on. */
export interface LoadScope {
  readonly context: QueryContext;
  run(statement: SelectStatement): Promise<readonly Row[]>;
}

/** How a level is loaded, compiled. */
export interface LevelOptions {
  readonly where: Predicate;
  readonly order: readonly OrderTerm[];
  readonly limit: number | undefined;
  readonly maxRows: number | undefined;
}

/** Each parent's value of one relation. */
export type LevelValues = Map<object, unknown>;

/** The distinct stored keys of `parents` under `plan`, and each parent's key identity. */
export function parentKeys(
  plan: LoadPlan,
  parents: readonly object[],
): { readonly keys: readonly SqlValue[]; readonly of: Map<object, string> } {
  const distinct = new Map<string, SqlValue>();
  const of = new Map<object, string>();
  for (const parent of parents) {
    const value = (parent as Record<string, unknown>)[plan.parentKey.property];
    if (value === null || value === undefined) continue;
    const stored = encodeColumn(plan.match.column, value);
    const identity = keyIdentity(stored);
    distinct.set(identity, stored);
    of.set(parent, identity);
  }
  return { keys: [...distinct.values()], of };
}

/**
 * Refuse to make records of `target` in a context that may not: a data
 * handle's owned context makes records of its owned models only, since a
 * record of a read grant could be saved back through the model's binding.
 */
function assertRecords(context: QueryContext, target: ModelCodecs): void {
  if (context.recordModels !== undefined && !context.recordModels.has(target.target)) {
    throw new DataSourceErrors.Error('not_granted', {
      model: target.spec.name,
      access: 'write',
    });
  }
}

/** The rows of `plan` for every key in `keys`, grouped by key identity, and how many were read. */
async function fetchGroups(
  scope: LoadScope,
  plan: LoadPlan,
  keys: readonly SqlValue[],
  options: LevelOptions,
): Promise<{ readonly groups: Map<string, object[]>; readonly fetched: number }> {
  const groups = new Map<string, object[]>();
  const first = keys[0];
  if (first === undefined) return { groups, fetched: 0 };
  assertRecords(scope.context, plan.target);
  const { catalog } = scope.context;
  const shape = (cap: number | undefined): LoadShape => ({
    where: options.where,
    order: options.order,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(cap === undefined ? {} : { cap }),
  });
  const bounded = options.maxRows !== undefined && options.limit === undefined;
  const capacity =
    catalog.dialect === 'postgres'
      ? keyCapacity('postgres', 0)
      : keyCapacity(
          catalog.dialect,
          residualParameters(
            catalog,
            (sample) => loadStatement(plan, sample, shape(bounded ? 1 : undefined)),
            first,
          ),
        );
  let fetched = 0;
  for (const chunk of keyChunks(keys, capacity)) {
    const cap =
      bounded && options.maxRows !== undefined ? options.maxRows - fetched + 1 : undefined;
    const rows = await scope.run(loadStatement(plan, chunk, shape(cap)));
    fetched += rows.length;
    if (options.maxRows !== undefined && fetched > options.maxRows) {
      throw new RelationErrors.Error('too_many_rows', {
        model: plan.owner.spec.name,
        relation: plan.name,
      });
    }
    for (const row of rows) {
      const raw = plan.link === undefined ? row[plan.match.column.column] : row[OWNER_KEY];
      const identity = keyIdentity(
        encodeColumn(plan.match.column, decodeColumn(plan.match.column, raw)),
      );
      const record = hydrate<object>(plan.target, row);
      const group = groups.get(identity);
      if (group === undefined) groups.set(identity, [record]);
      else group.push(record);
    }
  }
  return { groups, fetched };
}

/** Load `plan` for `parents` into `into`; resolves to the rows read. */
async function loadDirect(
  scope: LoadScope,
  plan: LoadPlan,
  parents: readonly object[],
  options: LevelOptions,
  into: LevelValues,
): Promise<number> {
  const { keys, of } = parentKeys(plan, parents);
  const { groups, fetched } = await fetchGroups(scope, plan, keys, options);
  for (const parent of parents) {
    const identity = of.get(parent);
    const group = identity === undefined ? undefined : groups.get(identity);
    if (plan.many) into.set(parent, group === undefined ? [] : [...group]);
    else into.set(parent, group?.[0] ?? null);
  }
  return fetched;
}

/**
 * The value of `plan`'s relation for each of `parents`, read under `scope`.
 *
 * @throws `relation.too_many_rows`, `relation.unknown_target` (a polymorphic
 *   type naming no model of the catalog), `data_source.not_granted`, and the
 *   codec, policy and database failures of its statements.
 */
export async function loadLevel(
  scope: LoadScope,
  plan: RelationPlan,
  parents: readonly object[],
  options: LevelOptions,
): Promise<LevelValues> {
  const values: LevelValues = new Map();
  if (plan.kind !== 'polymorphic') {
    await loadDirect(scope, plan, parents, options, values);
    return values;
  }
  const byType = new Map<string, object[]>();
  for (const parent of parents) {
    const type = (parent as Record<string, unknown>)[plan.typeColumn.property];
    values.set(parent, null);
    if (typeof type !== 'string') continue;
    const group = byType.get(type);
    if (group === undefined) byType.set(type, [parent]);
    else group.push(parent);
  }
  // Each type is its own statement; maxRows bounds the level, so the types share it.
  let fetched = 0;
  for (const [type, group] of byType) {
    const target = polymorphicTarget(scope.context.catalog, plan, type);
    const maxRows = options.maxRows === undefined ? undefined : options.maxRows - fetched;
    fetched += await loadDirect(scope, target, group, { ...options, maxRows }, values);
  }
  return values;
}
