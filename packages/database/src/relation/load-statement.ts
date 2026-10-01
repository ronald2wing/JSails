/**
 * The statement of one relation load, and how its keys are split.
 *
 * One statement reads the target rows of every parent key in a chunk:
 * `SELECT target.* [, link.owner AS jsails_owner] FROM target [JOIN link]
 * WHERE match IN (keys) [AND type = ?] [AND where]`. Without a per-parent
 * limit it is ordered by `(match, order..., pk)`, so each parent's rows come
 * in its order with the primary key as tiebreak, and a foreign-key index
 * (which carries the primary key on SQLite and InnoDB) can deliver them
 * without a sort. With a limit it is a window over the match column
 * (`ROW_NUMBER() OVER (PARTITION BY match ORDER BY order..., pk)`), so the
 * database returns at most `limit` rows per parent. A `belongsTo` load is
 * unordered: each key names one row.
 *
 * Keys: PostgreSQL binds an `IN` list as one array parameter, so a level is
 * one statement whatever its size. MariaDB and SQLite bind one parameter per
 * key, so the keys are split into chunks of `bindLimit - residual`, the
 * residual being every other parameter of the guarded statement (tenant
 * values, condition values, the window limit), read off the statement
 * compiled with one key: a level costs exactly `ceil(keys / capacity)`
 * statements, run one after another.
 *
 * A key's identity is its stored form under the matched column's codec, as a
 * string ({@link keyIdentity}), so a parent's key and a row's grouping value
 * meet whatever JavaScript type each was decoded to.
 */

import type { ModelCodecs } from '../codec/model-codecs.js';
import type { Dialect, SqlValue } from '../engine/contract.js';
import { BIND_LIMITS } from '../engine/render.js';
import type { OrderTerm, Predicate, SelectColumn, SelectStatement } from '../engine/statement.js';
import { and, col, eq, inList, join, select, table, TRUE } from '../statement/builders.js';
import { compileGuarded } from '../statement/guarded-compile.js';
import type { StatementCatalog } from '../statement/statement-catalog.js';
import { modelColumns } from '../statement/where.js';
import type { LoadPlan } from './relation-plan.js';

/** The output name of a through load's link owner key, and of a grouped count's key. */
export const OWNER_KEY = 'jsails_owner';

/** The output name of a grouped count. */
export const COUNT_KEY = 'jsails_count';

/** What a load reads beyond its keys. */
export interface LoadShape {
  /** Conditions on the target, qualified by its table name. */
  readonly where: Predicate;
  readonly order: readonly OrderTerm[];
  /** At most this many rows per parent (a window). */
  readonly limit?: number;
  /** At most this many rows in all (a plain `LIMIT`; not with `limit`). */
  readonly cap?: number;
}

/** The identity of a stored key value. */
export function keyIdentity(value: SqlValue): string {
  switch (typeof value) {
    case 'number':
    case 'bigint':
      return `n${String(value)}`;
    case 'string':
      return `s${value}`;
    case 'boolean':
      return value ? 'b1' : 'b0';
    default:
      return value instanceof Uint8Array ? `x${Buffer.from(value).toString('hex')}` : 'null';
  }
}

function matchRef(plan: LoadPlan) {
  return col(plan.match.qualifier, plan.match.column.column);
}

function keyOrder(codecs: ModelCodecs): readonly OrderTerm[] {
  return codecs.spec.primaryKey.map((property) =>
    Object.freeze({
      column: col(codecs.spec.table, (codecs.property(property) as { column: string }).column),
    }),
  );
}

/** The conditions every statement of `plan` carries besides its keys. */
function conditions(plan: LoadPlan, keys: readonly SqlValue[], where: Predicate): Predicate {
  const type = plan.type;
  return and(
    inList(matchRef(plan), keys),
    type === undefined ? TRUE : eq(col(type.qualifier, type.column), type.value),
    where,
  );
}

function joins(plan: LoadPlan) {
  const link = plan.link;
  if (link === undefined) return {};
  const linkTable = link.codecs.spec.table;
  return {
    joins: [join(table(linkTable, link.alias === linkTable ? undefined : link.alias), link.on)],
  };
}

/** The statement loading the rows of `plan`'s target for `keys`. */
export function loadStatement(
  plan: LoadPlan,
  keys: readonly SqlValue[],
  shape: LoadShape,
): SelectStatement {
  const target = plan.target;
  const columns: SelectColumn[] = [...modelColumns(target, target.spec.table)];
  if (plan.link !== undefined) columns.push({ column: matchRef(plan), as: OWNER_KEY });
  const where = conditions(plan, keys, shape.where);
  const tiebreak = keyOrder(target);
  if (shape.limit !== undefined) {
    return select(table(target.spec.table), {
      columns,
      ...joins(plan),
      where,
      orderBy: [...shape.order, ...tiebreak],
      windowLimit: { partitionBy: [matchRef(plan)], limit: shape.limit },
    });
  }
  return select(table(target.spec.table), {
    columns,
    ...joins(plan),
    where,
    ...(plan.kind === 'belongsTo'
      ? {}
      : { orderBy: [{ column: matchRef(plan) }, ...shape.order, ...tiebreak] }),
    ...(shape.cap === undefined ? {} : { limit: shape.cap }),
  });
}

/** The statement counting the rows of `plan`'s target per key, for `keys`. */
export function countStatement(
  plan: LoadPlan,
  keys: readonly SqlValue[],
  where: Predicate,
): SelectStatement {
  return select(table(plan.target.spec.table), {
    columns: [
      { column: matchRef(plan), as: OWNER_KEY },
      { aggregate: 'count', as: COUNT_KEY },
    ],
    ...joins(plan),
    where: conditions(plan, keys, where),
    groupBy: [matchRef(plan)],
  });
}

/**
 * How many keys one statement may bind on `dialect`, when the statement
 * binds `residual` other parameters: unbounded on PostgreSQL, which binds a
 * key list as one array.
 */
export function keyCapacity(dialect: Dialect, residual: number): number {
  if (dialect === 'postgres') return Number.POSITIVE_INFINITY;
  return Math.max(1, BIND_LIMITS[dialect] - residual);
}

/** `keys` in consecutive chunks of at most `capacity`. */
export function keyChunks<K>(keys: readonly K[], capacity: number): readonly (readonly K[])[] {
  if (keys.length <= capacity) return [keys];
  const chunks: K[][] = [];
  for (let start = 0; start < keys.length; start += capacity) {
    chunks.push(keys.slice(start, start + capacity));
  }
  return chunks;
}

/**
 * The parameters `build` binds besides its keys, under the ambient tenant
 * scope: the guarded statement for one key, compiled, less that key.
 */
export function residualParameters(
  catalog: StatementCatalog,
  build: (keys: readonly SqlValue[]) => SelectStatement,
  sample: SqlValue,
): number {
  return compileGuarded(catalog, build([sample])).params.length - 1;
}
