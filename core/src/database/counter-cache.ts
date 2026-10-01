/**
 * Hook bridges for counter caches, touch timestamps, autosave, and nested
 * attributes — each returns an {@link EntityHooksDefinition} that can be wired
 * into a data source's subscriber list via {@link createEntitySubscriber}.
 *
 * Every bridge attaches hooks to an entity and operates on its relations. The
 * counter and timestamp writes are bookkeeping: they go through
 * {@link bookkeepingUpdate}, an UPDATE with TypeORM's listeners off, so the
 * parent's own hooks and validation never see them (they carry one column,
 * not a row). Autosave and nested attributes are real saves of the related
 * rows, through `manager.save` guarded by an in-progress set so a cycle of
 * hooks cannot recurse. Errors are value-free and never echo entity data.
 */

import type { EntityManager, EntityTarget, ObjectLiteral, UpdateResult } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';

import type { EntityHookContext } from './entity-subscribers.js';
import { defineEntityHooks, type EntityHooksDefinition } from './entity-subscribers.js';
import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link CounterCacheError}. */
export type CounterCacheErrorCode = 'invalid_options';

/** Raised for invalid counter-cache / touch / autosave / nested-attributes inputs. */
export class CounterCacheError extends JsailsError {
  readonly code: CounterCacheErrorCode = 'invalid_options';
}

// ---------------------------------------------------------------------------
// Recursion guard
// ---------------------------------------------------------------------------

/**
 * A per-hook-definition set that tracks entities currently being processed.
 * When the same entity instance is encountered inside a nested save the mark
 * collides and the hook short-circuits, preventing re-entrant autosave /
 * nested-attribute loops.
 *
 * An entity is added before `manager.save()` and removed after it completes,
 * so a re-entrant hook triggered by the same save will see the entity marked
 * and skip it. The WeakSet lets entities be GC'd once the processing tree
 * unwinds — no leak, no global state.
 */
function createProcessingGuard() {
  const inProgress = new WeakSet<object>();

  return {
    /** Mark an entity as in-progress; returns `true` if it was already marked. */
    tryMark(entity: object): boolean {
      if (inProgress.has(entity)) return true;
      inProgress.add(entity);
      return false;
    },
    /** Remove an entity from the in-progress set. */
    unmark(entity: object): void {
      inProgress.delete(entity);
    },
  };
}

// ---------------------------------------------------------------------------
// Bookkeeping writes
// ---------------------------------------------------------------------------

/**
 * An UPDATE the framework issues on its own behalf (a counter cache, a touch
 * timestamp), with TypeORM's listeners and subscribers off. Such a write sets
 * one bookkeeping column, so firing the target's hooks would hand them a
 * one-column partial instead of a row: validation would reject every child
 * save, and a user hook would act on `undefined` fields. The tenant guard is
 * not a listener and still applies.
 */
export function bookkeepingUpdate(
  manager: EntityManager,
  target: EntityTarget<ObjectLiteral>,
  where: ObjectLiteral,
  values: QueryDeepPartialEntity<ObjectLiteral>,
): Promise<UpdateResult> {
  return manager
    .createQueryBuilder()
    .update(target)
    .set(values)
    .where(where)
    .callListeners(false)
    .execute();
}

/** Add `delta` to a counter column as a {@link bookkeepingUpdate}. */
function bumpCounter(
  manager: EntityManager,
  target: Function,
  where: ObjectLiteral,
  column: string,
  delta: number,
): Promise<UpdateResult> {
  const metadata = manager.connection.getMetadata(target);
  const counter = metadata.findColumnWithPropertyPath(column);
  if (counter === undefined) {
    throw new CounterCacheError('counterCache: column is not a column of the parent entity');
  }
  const escaped = manager.connection.driver.escape(counter.databaseName);
  const expression = `${escaped} ${delta < 0 ? '-' : '+'} ${Math.abs(delta)}`;
  return bookkeepingUpdate(manager, target, where, { [column]: () => expression });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A parent row to update: its entity class and its primary-key `where` map. */
interface ParentRef {
  readonly target: Function;
  readonly where: ObjectLiteral;
}

/** A key value a driver can hand back: integers, bigints as strings, uuids. */
function isKeyValue(value: unknown): value is string | number | bigint {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0) ||
    typeof value === 'bigint'
  );
}

/**
 * Resolve the parent row a child points at through `relation`. Resolves the
 * relation metadata from the connection at runtime so string-named relations
 * (e.g. `@ManyToOne('Post', ...)`) are resolved correctly even when the entity
 * class is locally-defined. Primary keys are read through metadata, so a key
 * not named `id`, a string or bigint key, and a composite key all work.
 *
 * The parent key is tried in order:
 * 1. The loaded relation object (e.g. `child.post`).
 * 2. The FK value on the child (a scalar FK property, or the relation property
 *    holding a bare key).
 * 3. A query for the FK column (needed for `beforeRemove`, where the database
 *    entity carries no relations). It goes through the query builder so the
 *    driver supplies identifier quoting and placeholders.
 */
async function resolveParent(
  child: ObjectLiteral,
  manager: EntityManager,
  childEntity: EntityTarget<ObjectLiteral>,
  relation: string,
): Promise<ParentRef | null> {
  const childMetadata = manager.connection.getMetadata(childEntity);
  const rel = childMetadata.findRelationWithPropertyPath(relation);
  if (!rel) return null;

  const parentMetadata = rel.inverseEntityMetadata;
  const target = parentMetadata.target;
  if (typeof target !== 'function') return null;

  const parent = child[relation];
  if (parent !== null && typeof parent === 'object') {
    const where = parentMetadata.getEntityIdMap(parent);
    if (where !== undefined && Object.values(where).every(isKeyValue)) return { target, where };
  }

  // Only a single-column FK has an unambiguous scalar value to read back.
  const joinCol = rel.joinColumns.length === 1 ? rel.joinColumns[0] : undefined;
  const referenced = joinCol?.referencedColumn;
  if (joinCol === undefined || referenced === undefined) return null;
  const parentWhere = (value: unknown): ParentRef | null =>
    isKeyValue(value) ? { target, where: { [referenced.propertyName]: value } } : null;

  const scalarFk = childMetadata.columns.find(
    (column) =>
      column.databaseName === joinCol.databaseName && column.relationMetadata === undefined,
  );
  const direct = parentWhere(
    scalarFk !== undefined ? child[scalarFk.propertyName] : isKeyValue(parent) ? parent : undefined,
  );
  if (direct !== null) return direct;

  const childWhere = childMetadata.getEntityIdMap(child);
  if (childWhere === undefined || !Object.values(childWhere).every(isKeyValue)) return null;
  const builder = manager.createQueryBuilder(childMetadata.target, 'child');
  const row: Record<string, unknown> | undefined = await builder
    .select(`${builder.escape('child')}.${builder.escape(joinCol.databaseName)}`, 'fk')
    .where(childWhere)
    .getRawOne();
  return parentWhere(row?.fk);
}

/** Property names that hold `relation`'s FK on the child: the relation and any scalar FK. */
function foreignKeyProperties(
  manager: EntityManager,
  childEntity: EntityTarget<ObjectLiteral>,
  relation: string,
): ReadonlySet<string> {
  const childMetadata = manager.connection.getMetadata(childEntity);
  const rel = childMetadata.findRelationWithPropertyPath(relation);
  const fkColumns = new Set(rel?.joinColumns.map((column) => column.databaseName) ?? []);
  const names = new Set([relation]);
  for (const column of childMetadata.columns) {
    if (fkColumns.has(column.databaseName)) names.add(column.propertyName);
  }
  return names;
}

/** Whether two parent references name the same row. */
function sameParent(a: ParentRef | null, b: ParentRef | null): boolean {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a.where);
  return (
    a.target === b.target &&
    keys.length === Object.keys(b.where).length &&
    keys.every((key) => String(a.where[key]) === String(b.where[key]))
  );
}

// ---------------------------------------------------------------------------
// counterCache
// ---------------------------------------------------------------------------

/**
 * Increment or decrement a parent entity's counter column when a child entity
 * is inserted or deleted.
 *
 * The hook fires on the *child* entity. When `incrementOn` is `'afterInsert'`
 * the parent's column is incremented by 1; for `'afterDelete'` it is
 * decremented by 1. The `'afterInsert'` bridge also follows a child whose
 * parent changes on update: the old parent is decremented and the new one
 * incremented. (It is the one of the pair `has_many` registers that owns this,
 * so a move is counted once.)
 *
 * The update is a {@link bookkeepingUpdate}: it fires none of the parent's
 * hooks, so the parent's validation and its own hooks never see it.
 *
 * @param entity   - The child entity target (class, `EntitySchema`, or name).
 * @param relation - The name of the many-to-one relation on the child that
 *                   references the parent entity.
 * @param column   - The integer column on the parent to increment/decrement.
 * @param incrementOn - Which lifecycle event triggers the counter change.
 * @throws {CounterCacheError} for invalid options (value-free).
 */
export function counterCache<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  options: {
    readonly relation: string;
    readonly column: string;
    readonly incrementOn: 'afterInsert' | 'afterDelete';
  },
): EntityHooksDefinition<T> {
  const { relation, column, incrementOn } = options;

  if (typeof relation !== 'string' || relation.length === 0) {
    throw new CounterCacheError('counterCache: relation must be a non-empty string');
  }
  if (typeof column !== 'string' || column.length === 0) {
    throw new CounterCacheError('counterCache: column must be a non-empty string');
  }
  if (incrementOn !== 'afterInsert' && incrementOn !== 'afterDelete') {
    throw new CounterCacheError('counterCache: incrementOn must be "afterInsert" or "afterDelete"');
  }

  const delta = incrementOn === 'afterInsert' ? 1 : -1;

  async function updateCounter(ctx: EntityHookContext<ObjectLiteral>): Promise<void> {
    const parent = await resolveParent(ctx.entity, ctx.manager, entity, relation);
    if (parent === null) return;

    await bumpCounter(ctx.manager, parent.target, parent.where, column, delta);
  }

  /** Move the count when an update points the child at another parent. */
  async function moveCounter(ctx: EntityHookContext<ObjectLiteral>): Promise<void> {
    // TypeORM reports a changed relation object in its relation diff, not in
    // `changedColumns`, so a present relation value is compared directly; a
    // scalar FK property does show up in `changedColumns`.
    const fkProperties = foreignKeyProperties(ctx.manager, entity, relation);
    const scalarChanged =
      ctx.changedColumns?.some((name) => name !== relation && fkProperties.has(name)) ?? false;
    if (!scalarChanged && (ctx.data as ObjectLiteral)[relation] === undefined) return;
    const before = await resolveParent(ctx.entity, ctx.manager, entity, relation);
    const after = await resolveParent(ctx.data, ctx.manager, entity, relation);
    if (sameParent(before, after)) return;
    if (before !== null) await bumpCounter(ctx.manager, before.target, before.where, column, -1);
    if (after !== null) await bumpCounter(ctx.manager, after.target, after.where, column, 1);
  }

  // For decrement, fire on beforeDelete so the entity's FK column is still
  // available. afterDelete (TypeORM afterRemove) may have stripped it.
  if (incrementOn === 'afterDelete') {
    return defineEntityHooks<T>(entity, { beforeDelete: updateCounter });
  }
  return defineEntityHooks<T>(entity, { afterInsert: updateCounter, afterUpdate: moveCounter });
}

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------

/**
 * Update a parent entity's timestamp column when a child entity is saved or
 * deleted.
 *
 * The hook fires on the *child* entity on `afterInsert`, `afterUpdate`, and
 * `afterDelete`. The parent's column is set to the current date/time by a
 * {@link bookkeepingUpdate}, which fires none of the parent's hooks.
 *
 * @param entity   - The child entity target (class, `EntitySchema`, or name).
 * @param relation - The name of the many-to-one relation on the child that
 *                   references the parent entity.
 * @param column   - The datetime/timestamp column on the parent to touch.
 * @throws {CounterCacheError} for invalid options (value-free).
 */
export function touch<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  options: { readonly relation: string; readonly column: string },
): EntityHooksDefinition<T> {
  const { relation, column } = options;

  if (typeof relation !== 'string' || relation.length === 0) {
    throw new CounterCacheError('touch: relation must be a non-empty string');
  }
  if (typeof column !== 'string' || column.length === 0) {
    throw new CounterCacheError('touch: column must be a non-empty string');
  }

  async function touchParent(ctx: EntityHookContext<ObjectLiteral>): Promise<void> {
    const parent = await resolveParent(ctx.entity, ctx.manager, entity, relation);
    if (parent === null) return;

    await bookkeepingUpdate(ctx.manager, parent.target, parent.where, { [column]: new Date() });
  }

  // Fire on beforeDelete so the entity's FK column is still available.
  return defineEntityHooks<T>(entity, {
    afterInsert: touchParent,
    afterUpdate: touchParent,
    beforeDelete: touchParent,
  });
}

/**
 * Resolve the child entity target and the child's FK property that points back
 * to the parent, from the parent entity's relation metadata. Returns `null`
 * when the relation is not found. `fkProperty` is the child-side many-to-one
 * property name whose join column carries the parent's id (e.g. `postId`), or
 * `null` when the relation has no ownable join column (a one-to-one inverse).
 */
function resolveRelationInfo(
  manager: EntityManager,
  parentEntity: EntityTarget<ObjectLiteral>,
  relation: string,
): { childTarget: EntityTarget<ObjectLiteral>; fkProperty: string | null } | null {
  const parentMetadata = manager.connection.getMetadata(parentEntity);
  const rel = parentMetadata.findRelationWithPropertyPath(relation);
  if (!rel) return null;
  const childMetadata = rel.inverseEntityMetadata;
  const childTarget = childMetadata.target;
  if (childTarget === undefined || childTarget === null) return null;

  // The child's many-to-one relation whose inverse is this parent owns the
  // join column carrying the parent's id.
  for (const childRel of childMetadata.manyToOneRelations) {
    if (childRel.inverseRelation?.propertyName === relation) {
      return { childTarget, fkProperty: childRel.propertyName };
    }
  }
  return { childTarget, fkProperty: null };
}

/**
 * The instance the caller saved: the context's `data`. On insert `entity` is
 * the same object, but on update `entity` is the row loaded before the
 * change, which holds none of the related objects the caller attached.
 */
function savedInstance(ctx: EntityHookContext<ObjectLiteral>): ObjectLiteral {
  return ctx.data;
}

// ---------------------------------------------------------------------------
// autosave
// ---------------------------------------------------------------------------

/**
 * Persist dirty related entities when the parent entity is saved.
 *
 * The hook fires on the *parent* entity on `afterInsert` and `afterUpdate`
 * so the parent has its generated id before children are persisted. For each
 * named relation, if the related entity (or each entity in a collection) is
 * present on the instance being saved, it is passed to `manager.save()`. The
 * hook is guarded against
 * re-entrant saves: an entity already being processed in the current call
 * tree is skipped.
 *
 * @param entity    - The parent entity target (class, `EntitySchema`, or name).
 * @param relations - Names of relations whose entities should be auto-saved.
 * @throws {CounterCacheError} for invalid options (value-free).
 */
export function autosave<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  options: { readonly relations: readonly string[] },
): EntityHooksDefinition<T> {
  const { relations } = options;

  if (!Array.isArray(relations) || relations.length === 0) {
    throw new CounterCacheError('autosave: relations must be a non-empty array of strings');
  }
  for (const rel of relations) {
    if (typeof rel !== 'string' || rel.length === 0) {
      throw new CounterCacheError('autosave: every relation must be a non-empty string');
    }
  }

  const guard = createProcessingGuard();

  async function saveRelated(
    value: unknown,
    manager: EntityManager,
    childTarget: EntityTarget<ObjectLiteral>,
    parentId: unknown,
    fkProperty: string | null,
  ): Promise<void> {
    if (value === null || value === undefined || typeof value !== 'object') return;
    if (guard.tryMark(value)) return;
    try {
      // The parent's generated primary key is assigned only after its INSERT,
      // and the child may hold a reference to the parent object whose `id` was
      // not yet populated when it was assigned. Set the child's FK column
      // explicitly from the parent's now-available id so the row is never
      // inserted with a NULL foreign key.
      if (fkProperty !== null && parentId !== undefined) {
        (value as Record<string, unknown>)[fkProperty] = parentId;
      }
      await manager.save(childTarget, value);
    } finally {
      guard.unmark(value);
    }
  }

  async function autosaveHook(ctx: EntityHookContext<ObjectLiteral>): Promise<void> {
    const parent = savedInstance(ctx);
    const parentId = parent['id'];
    for (const rel of relations) {
      const info = resolveRelationInfo(ctx.manager, entity, rel);
      if (info === null) continue;
      const related = parent[rel];
      if (Array.isArray(related)) {
        for (const item of related) {
          await saveRelated(item, ctx.manager, info.childTarget, parentId, info.fkProperty);
        }
      } else {
        await saveRelated(related, ctx.manager, info.childTarget, parentId, info.fkProperty);
      }
    }
  }

  return defineEntityHooks<T>(entity, {
    afterInsert: autosaveHook,
    afterUpdate: autosaveHook,
  });
}

// ---------------------------------------------------------------------------
// nestedAttributes
// ---------------------------------------------------------------------------

/**
 * Persist related child entities when the parent is saved, stripping
 * non-allowlisted fields from each child entity before it reaches the
 * database.
 *
 * The hook fires on the *parent* entity on `afterInsert` and `afterUpdate`
 * so the parent has its generated id before children are persisted. For the
 * named relation, every child entity has its non-allowlisted (and
 * non-relational) fields deleted; then it is passed to `manager.save()`.
 *
 * Re-entrant saves are guarded by the same in-progress set as
 * {@link autosave}.
 *
 * @param entity   - The parent entity target (class, `EntitySchema`, or name).
 * @param relation - The name of the relation whose child entities are persisted.
 * @param fields   - Allowlist of field names accepted from each child entity.
 * @throws {CounterCacheError} for invalid options (value-free).
 */
export function nestedAttributes<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  options: { readonly relation: string; readonly fields: readonly string[] },
): EntityHooksDefinition<T> {
  const { relation, fields } = options;

  if (typeof relation !== 'string' || relation.length === 0) {
    throw new CounterCacheError('nestedAttributes: relation must be a non-empty string');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new CounterCacheError('nestedAttributes: fields must be a non-empty array of strings');
  }
  for (const f of fields) {
    if (typeof f !== 'string' || f.length === 0) {
      throw new CounterCacheError('nestedAttributes: every field must be a non-empty string');
    }
  }

  const guard = createProcessingGuard();

  // Cache of FK property names + child target resolved at hook runtime per
  // connection. EntitySchema-based entities need the child target passed to
  // `manager.save(target, entity)` because plain objects cannot be resolved by
  // type introspection.
  const hookInfoCache = new WeakMap<
    object,
    {
      propNames: ReadonlySet<string>;
      childTarget: EntityTarget<ObjectLiteral> | null;
      fkProperty: string | null;
    }
  >();

  function getHookInfo(manager: EntityManager): {
    propNames: ReadonlySet<string>;
    childTarget: EntityTarget<ObjectLiteral> | null;
    fkProperty: string | null;
  } {
    const cached = hookInfoCache.get(manager.connection);
    if (cached) return cached;

    const names = new Set<string>();
    let childTarget: EntityTarget<ObjectLiteral> | null = null;
    let fkProperty: string | null = null;

    const parentMetadata = manager.connection.getMetadata(entity);
    const parentRel = parentMetadata.findRelationWithPropertyPath(relation);
    if (parentRel) {
      childTarget = parentRel.inverseEntityMetadata.target ?? null;
      const childMetadata = parentRel.inverseEntityMetadata;
      for (const r of childMetadata.manyToOneRelations) {
        names.add(r.propertyName);
        // The FK property is the child's many-to-one whose inverse is THIS
        // parent relation. When a child has several many-to-one relations
        // (e.g. `Post` and `Author` both exposing `comments`), only the one
        // inverse to this exact relation owns the FK column — stop at the
        // first match instead of letting a later relation overwrite it
        // (a duplicate-inverse child would otherwise persist the wrong FK).
        if (r.inverseRelation?.propertyName === relation) {
          fkProperty = r.propertyName;
          break;
        }
      }
    }
    const info = {
      propNames: Object.freeze(new Set(names)) as ReadonlySet<string>,
      childTarget,
      fkProperty,
    };
    hookInfoCache.set(manager.connection, info);
    return info;
  }

  function stripFields(value: Record<string, unknown>, propNames: ReadonlySet<string>): void {
    for (const key of Object.keys(value)) {
      if (key === 'id') continue;
      if (fields.includes(key)) continue;
      if (propNames.has(key)) continue;
      delete value[key];
    }
  }

  async function persistNested(
    value: unknown,
    manager: EntityManager,
    propNames: ReadonlySet<string>,
    childTarget: EntityTarget<ObjectLiteral> | null,
    fkProperty: string | null,
    parentId: unknown,
  ): Promise<void> {
    if (value === null || value === undefined || typeof value !== 'object') return;
    if (guard.tryMark(value)) return;
    try {
      stripFields(value as Record<string, unknown>, propNames);
      // Set the child's FK column from the parent's now-assigned id before
      // saving, so a nested child is never inserted with a NULL foreign key
      // (the parent's generated primary key exists only after its own INSERT).
      if (fkProperty !== null && parentId !== undefined) {
        (value as Record<string, unknown>)[fkProperty] = parentId;
      }
      if (childTarget) {
        await manager.save(childTarget, value);
      } else {
        await manager.save(value);
      }
    } finally {
      guard.unmark(value);
    }
  }

  async function nestedHook(ctx: EntityHookContext<ObjectLiteral>): Promise<void> {
    const parent = savedInstance(ctx);
    const related = parent[relation];
    const { propNames, childTarget, fkProperty } = getHookInfo(ctx.manager);
    const parentId = parent['id'];
    if (Array.isArray(related)) {
      for (const item of related) {
        await persistNested(item, ctx.manager, propNames, childTarget, fkProperty, parentId);
      }
    } else {
      await persistNested(related, ctx.manager, propNames, childTarget, fkProperty, parentId);
    }
  }

  return defineEntityHooks<T>(entity, {
    afterInsert: nestedHook,
    afterUpdate: nestedHook,
  });
}
