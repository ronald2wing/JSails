/**
 * Include trees: which relations a query loads with its records, compiled
 * once where they are written, and loaded level by level.
 *
 * `compileIncludes` turns an include spec (a relation name, a list of names,
 * or an object of names to `true` or to load options) into frozen nodes,
 * each with its relation plan and its conditions, order and limit compiled
 * against the target, so an unknown relation, column or option fails where
 * the include is written. Options per relation kind: `where` on every kind
 * but a polymorphic `belongsTo` (it has no single target); `order` on a
 * to-many or `hasOne` relation; `limit` (per parent) on a to-many relation;
 * `maxRows` and `include` everywhere. A polymorphic `belongsTo`'s own
 * `include` names relations of its targets, so it is compiled for each
 * target model when rows of it are loaded.
 *
 * `loadIncludes` loads each node for every record of a level: one statement
 * per key chunk (`load-relation.ts`), the values attached to the records as
 * loaded relations, then the node's own includes for the records it loaded,
 * so a tree of depth `d` costs `d` statements per chunk beyond the root.
 */

import type { ModelCodecs } from '../codec/model-codecs.js';
import type { OrderTerm, Predicate } from '../engine/statement.js';
import { TRUE } from '../statement/builders.js';
import type { StatementCatalog } from '../statement/statement-catalog.js';
import { compileOrder, compileWhere, type OrderBy, type WhereInput } from '../statement/where.js';
import { loadLevel, type LevelOptions, type LevelValues, type LoadScope } from './load-relation.js';
import { RelationErrors } from './relation-errors.js';
import { polymorphicTarget, resolveLoadPlan, type RelationPlan } from './relation-plan.js';
import { attachLoadedRelation } from './relation-state.js';

/** One compiled include: a relation, how it is loaded, and what is loaded under it. */
export interface IncludeNode extends LevelOptions {
  readonly name: string;
  readonly plan: RelationPlan;
  /** The includes of the loaded records, compiled for the relation's target. */
  readonly children: readonly IncludeNode[];
  /** A polymorphic `belongsTo`'s include spec, compiled per target when loaded. */
  readonly pending?: unknown;
}

const OPTION_KEYS: ReadonlySet<string> = new Set(['where', 'order', 'limit', 'maxRows', 'include']);

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The `[name, options]` entries of an include spec, each relation once. */
function entries(owner: ModelCodecs, spec: unknown): readonly (readonly [string, unknown])[] {
  const invalid = (): never => {
    throw new RelationErrors.Error('invalid_include', { model: owner.spec.name });
  };
  let list: (readonly [string, unknown])[];
  if (typeof spec === 'string') list = [[spec, true]];
  else if (Array.isArray(spec)) {
    list = spec.map((name: unknown) => (typeof name === 'string' ? [name, true] : invalid()));
  } else if (isPlainObject(spec)) list = Object.entries(spec);
  else return invalid();
  if (list.length === 0 || new Set(list.map(([name]) => name)).size !== list.length) invalid();
  return list;
}

/**
 * Compile the load of relation `name` of `owner` with `options` (`true` or
 * an options object).
 *
 * @throws `relation.invalid_option`, `relation.invalid_include`,
 *   `query.unknown_relation`, `query.unsupported_relation`, and the
 *   `statement.*` codes of a malformed `where` or `order`.
 */
export function compileInclude(
  catalog: StatementCatalog,
  owner: ModelCodecs,
  name: string,
  options: unknown,
): IncludeNode {
  const plan = resolveLoadPlan(catalog, owner, name);
  const invalid = (
    option: 'options' | 'where' | 'order' | 'limit' | 'maxRows' | 'include',
  ): never => {
    throw new RelationErrors.Error('invalid_option', {
      model: owner.spec.name,
      relation: name,
      option,
    });
  };
  if (options !== true && !isPlainObject(options)) return invalid('options');
  const given: Readonly<Record<string, unknown>> = options === true ? {} : options;
  for (const key of Object.keys(given)) if (!OPTION_KEYS.has(key)) invalid('options');
  const { where, order, limit, maxRows, include } = given;
  const polymorphic = plan.kind === 'polymorphic';
  let condition: Predicate = TRUE;
  let terms: readonly OrderTerm[] = [];
  if (where !== undefined) {
    if (polymorphic) invalid('where');
    else condition = compileWhere(plan.target, where as WhereInput<object>, plan.target.spec.table);
  }
  if (order !== undefined) {
    if (polymorphic || plan.kind === 'belongsTo') invalid('order');
    else {
      terms = compileOrder(plan.target, order as OrderBy<object>, plan.target.spec.table);
    }
  }
  if (limit !== undefined && (polymorphic || !plan.many || !isCount(limit) || limit === 0)) {
    invalid('limit');
  }
  if (maxRows !== undefined && !isCount(maxRows)) invalid('maxRows');
  let children: readonly IncludeNode[] = [];
  if (include !== undefined && !polymorphic) {
    children = compileIncludes(catalog, plan.target, include);
  }
  return Object.freeze({
    name,
    plan,
    where: condition,
    order: terms,
    limit: limit as number | undefined,
    maxRows: maxRows as number | undefined,
    children,
    ...(include !== undefined && polymorphic ? { pending: include } : {}),
  });
}

/**
 * Compile the include spec `spec` of `owner`'s records, after the nodes
 * `existing` (an earlier `includes` of the same query).
 *
 * @throws `relation.invalid_include` for a malformed spec or a relation
 *   included twice, and the refusals of {@link compileInclude}.
 */
export function compileIncludes(
  catalog: StatementCatalog,
  owner: ModelCodecs,
  spec: unknown,
  existing: readonly IncludeNode[] = [],
): readonly IncludeNode[] {
  const nodes = [...existing];
  for (const [name, options] of entries(owner, spec)) {
    if (nodes.some((node) => node.name === name)) {
      throw new RelationErrors.Error('invalid_include', { model: owner.spec.name });
    }
    nodes.push(compileInclude(catalog, owner, name, options));
  }
  return Object.freeze(nodes);
}

/** The records a level loaded, each once. */
function loadedRecords(values: LevelValues): object[] {
  const records = new Set<object>();
  for (const value of values.values()) {
    if (Array.isArray(value)) for (const item of value as object[]) records.add(item);
    else if (value !== null && typeof value === 'object') records.add(value);
  }
  return [...records];
}

/** The includes under a polymorphic node for records of `target`, compiled once per target. */
const PENDING = new WeakMap<IncludeNode, WeakMap<ModelCodecs, readonly IncludeNode[]>>();

function pendingChildren(
  catalog: StatementCatalog,
  node: IncludeNode,
  target: ModelCodecs,
): readonly IncludeNode[] {
  let byTarget = PENDING.get(node);
  if (byTarget === undefined) {
    byTarget = new WeakMap();
    PENDING.set(node, byTarget);
  }
  let children = byTarget.get(target);
  if (children === undefined) {
    children = compileIncludes(catalog, target, node.pending);
    byTarget.set(target, children);
  }
  return children;
}

/**
 * Load the value of `node`'s relation for each of `parents`, and the node's
 * own includes for what it loaded.
 */
export async function loadNode(
  scope: LoadScope,
  node: IncludeNode,
  parents: readonly object[],
): Promise<LevelValues> {
  const values = await loadLevel(scope, node.plan, parents, node);
  if (node.pending === undefined && node.children.length === 0) return values;
  if (node.pending === undefined) {
    await loadIncludes(scope, node.children, loadedRecords(values));
    return values;
  }
  const { plan } = node;
  if (plan.kind !== 'polymorphic') return values;
  // The records of each target model, found from their parents' type column.
  const { catalog } = scope.context;
  const byTarget = new Map<ModelCodecs, Set<object>>();
  const targets = new Map<string, ModelCodecs>();
  for (const [parent, value] of values) {
    if (value === null || typeof value !== 'object') continue;
    const type = (parent as Record<string, unknown>)[plan.typeColumn.property] as string;
    let target = targets.get(type);
    if (target === undefined) {
      target = polymorphicTarget(catalog, plan, type).target;
      targets.set(type, target);
    }
    const group = byTarget.get(target);
    if (group === undefined) byTarget.set(target, new Set([value]));
    else group.add(value);
  }
  for (const [target, records] of byTarget) {
    await loadIncludes(scope, pendingChildren(catalog, node, target), [...records]);
  }
  return values;
}

/** Load every node of `nodes` onto `records`, attaching each value as a loaded relation. */
export async function loadIncludes(
  scope: LoadScope,
  nodes: readonly IncludeNode[],
  records: readonly object[],
): Promise<void> {
  if (records.length === 0) return;
  for (const node of nodes) {
    const values = await loadNode(scope, node, records);
    for (const [record, value] of values) attachLoadedRelation(record, node.name, value);
  }
}
