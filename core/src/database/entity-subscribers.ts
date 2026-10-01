/**
 * Typed, per-entity lifecycle hooks delivered as a TypeORM entity subscriber.
 *
 * {@link defineEntityHooks} declares the hooks for one entity; {@link
 * createEntitySubscriber} compiles one or more such declarations into a single
 * `@EventSubscriber()` class that {@link JsailsDataSource} (and, through it,
 * TypeORM's `DataSource`) can include through its `subscribers` option:
 *
 * ```ts
 * import { JsailsDataSource, defineEntityHooks, createEntitySubscriber } from 'jsails';
 *
 * const hooks = defineEntityHooks(User, {
 *   beforeInsert({ entity, manager }) { /* mutate entity, or use manager *\/ },
 *   afterUpdate({ entity, data, changedColumns }) { /* audit the change *\/ },
 * });
 *
 * const dataSource = new JsailsDataSource({
 *   // ...entities, driver, etc.
 *   subscribers: [createEntitySubscriber(hooks)],
 * });
 * ```
 *
 * Hooks run in declaration order and are awaited, so an async hook can perform
 * its own work (including queries through the transaction-scoped `manager`)
 * before the next hook or the statement itself proceeds. A hook that throws
 * rejects the caller's `save`/`remove`/`find` and aborts the transaction; the
 * error is surfaced unchanged (TypeORM's broadcaster awaits the subscriber
 * promises before/after the DML).
 *
 * The mapping onto TypeORM's subscriber events is deliberately narrow. The
 * row hooks (`beforeUpdate`, `afterDelete`, ...) fire only when TypeORM hands
 * over a whole row: the Active Record subject path (`save`, `remove`), entity
 * loads, and inserts (a query-builder insert carries the full row it writes).
 * A query-builder `update` (`Model.update()`, `repository.update()`,
 * `increment()`) carries only its SET map and no row, and a query-builder
 * `delete` carries nothing at all, as do the relation-id bookkeeping updates
 * TypeORM issues for a parent's collection. Running a row hook or a
 * validation schema on such an event would see `undefined` for every column
 * the statement does not write, so the row hooks are skipped for it. A
 * query-builder update instead fires `beforeBulkUpdate` / `afterBulkUpdate`,
 * whose context is the SET map itself (see {@link EntityBulkUpdateContext}),
 * which is how attribute encryption and validation still cover it.
 *
 * There is no global or module-level state: every {@link createEntitySubscriber}
 * call builds a fresh class closing over its own compiled registry, so two data
 * sources in the same process never share hook state.
 */

import { EntitySchema, EventSubscriber } from 'typeorm';
import { assertEntityTarget } from './entity-target.js';
import type {
  EntityManager,
  EntitySubscriberInterface,
  EntityTarget,
  InsertEvent,
  LoadEvent,
  ObjectLiteral,
  RemoveEvent,
  UpdateEvent,
} from 'typeorm';
import type { Awaitable } from '../contracts/awaitable.js';
import { JsailsError } from '../errors/jsails-error.js';

/** The row lifecycle events: their hooks receive an {@link EntityHookContext}. */
export type EntityRowHookEvent =
  | 'beforeInsert'
  | 'afterInsert'
  | 'beforeUpdate'
  | 'afterUpdate'
  | 'beforeDelete'
  | 'afterDelete'
  | 'afterLoad';

/** The query-builder UPDATE events: their hooks receive an {@link EntityBulkUpdateContext}. */
export type EntityBulkHookEvent = 'beforeBulkUpdate' | 'afterBulkUpdate';

/** The lifecycle events a hook can subscribe to. */
export type EntityHookEvent = EntityRowHookEvent | EntityBulkHookEvent;

/**
 * Context passed to every hook.
 *
 * `entity` is the entity instance the event concerns. For update events it is
 * the pre-change database snapshot (with its generated id and prior values),
 * so a hook can compare stable fields against the incoming `data`. `data` is
 * the partial attribute data being written (the new values on update, the
 * entity itself on insert/delete/load). `changedColumns` names the entity
 * properties an update modified; it is present only for update events.
 */
export interface EntityHookContext<Entity extends ObjectLiteral> {
  /** The entity instance the event concerns (pre-change snapshot on update). */
  readonly entity: Entity;
  /** The partial attribute data being written or read by this event. */
  readonly data: Partial<Entity>;
  /** The entity manager scoped to the event's transaction. */
  readonly manager: EntityManager;
  /** Property names of columns changed by an update (update events only). */
  readonly changedColumns?: readonly string[];
}

/**
 * Context passed to `beforeBulkUpdate` / `afterBulkUpdate`: a query-builder
 * UPDATE (`Model.update()`, `repository.update()`, `increment()`), which
 * names the columns it writes but carries no row. `values` is the SET map
 * keyed by property name, the very object the statement will render, so a
 * `beforeBulkUpdate` hook may rewrite a value in place (attribute encryption
 * does). A value that is a function is a raw SQL expression, not data.
 */
export interface EntityBulkUpdateContext {
  /** The SET map of the UPDATE, keyed by property name. */
  readonly values: Record<string, unknown>;
  /** The entity manager scoped to the event's transaction. */
  readonly manager: EntityManager;
}

/** A bulk-update hook: an async-or-sync function of the bulk-update context. */
export type EntityBulkUpdateHook = (context: EntityBulkUpdateContext) => Awaitable<void>;

/** A single lifecycle hook: an async-or-sync function of the hook context. */
export type EntityHook<Entity extends ObjectLiteral> = (
  context: EntityHookContext<Entity>,
) => Awaitable<void>;

/**
 * The optional hooks for one entity, keyed by lifecycle event. Declared with
 * method syntax so the parameter type is bivariant: a `User`-scoped hook
 * declaration widens cleanly to an `ObjectLiteral`-scoped one, letting
 * {@link createEntitySubscriber} combine declarations of distinct entity types
 * into a single subscriber.
 *
 * The hooks are method signatures on purpose: method parameters are checked
 * bivariantly, which lets an `EntityHooksDefinition<User>` flow into the
 * `EntityHooksDefinition<ObjectLiteral>` list a subscriber is built from.
 */
export interface EntityHooks<Entity extends ObjectLiteral> {
  beforeInsert?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterInsert?(context: EntityHookContext<Entity>): Awaitable<void>;
  beforeUpdate?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterUpdate?(context: EntityHookContext<Entity>): Awaitable<void>;
  beforeDelete?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterDelete?(context: EntityHookContext<Entity>): Awaitable<void>;
  afterLoad?(context: EntityHookContext<Entity>): Awaitable<void>;
  beforeBulkUpdate?(context: EntityBulkUpdateContext): Awaitable<void>;
  afterBulkUpdate?(context: EntityBulkUpdateContext): Awaitable<void>;
}

/** Machine-readable reason for an {@link EntityHooksError}. */
export type EntityHooksErrorCode = 'invalid_definition';

/** Raised for an invalid hooks declaration. Messages are value-free. */
export class EntityHooksError extends JsailsError {
  readonly code: EntityHooksErrorCode = 'invalid_definition';
}

/**
 * An immutable, validated hook declaration for one entity: the entity target
 * plus its handlers. Produced by {@link defineEntityHooks} and consumed by
 * {@link createEntitySubscriber}.
 */
export interface EntityHooksDefinition<Entity extends ObjectLiteral> {
  readonly entity: EntityTarget<Entity>;
  readonly hooks: Readonly<EntityHooks<Entity>>;
}

/** The constructor shape of the subscriber class returned by {@link createEntitySubscriber}. */
export type EntitySubscriberClass = new () => EntitySubscriberInterface<ObjectLiteral>;

/** An internal compiled hook entry: one event handler for one entity. */
type HookEntry =
  | {
      readonly kind: 'row';
      readonly event: EntityRowHookEvent;
      readonly hook: EntityHook<ObjectLiteral>;
    }
  | {
      readonly kind: 'bulk';
      readonly event: EntityBulkHookEvent;
      readonly hook: EntityBulkUpdateHook;
    };

const ROW_HOOK_EVENTS: readonly EntityRowHookEvent[] = [
  'beforeInsert',
  'afterInsert',
  'beforeUpdate',
  'afterUpdate',
  'beforeDelete',
  'afterDelete',
  'afterLoad',
];

const BULK_HOOK_EVENTS: readonly EntityBulkHookEvent[] = ['beforeBulkUpdate', 'afterBulkUpdate'];

const HOOK_EVENTS: readonly EntityHookEvent[] = [...ROW_HOOK_EVENTS, ...BULK_HOOK_EVENTS];

/**
 * Declare the lifecycle hooks for a single entity. Returns an immutable,
 * validated definition; combine several definitions by passing them all to
 * {@link createEntitySubscriber}. A handler that is not a function is rejected
 * with an {@link EntityHooksError} before any data source is constructed.
 */
export function defineEntityHooks<Entity extends ObjectLiteral>(
  entity: EntityTarget<Entity>,
  hooks: EntityHooks<Entity>,
): EntityHooksDefinition<Entity> {
  assertEntityTarget(entity, () => {
    throw new EntityHooksError(
      'defineEntityHooks: "entity" must be a class, an EntitySchema, or an entity name',
    );
  });
  assertHooksObject(hooks, 'defineEntityHooks');
  const copied: EntityHooks<Entity> = {};
  for (const event of ROW_HOOK_EVENTS) {
    const hook = hooks[event];
    if (hook !== undefined) copied[event] = hook;
  }
  for (const event of BULK_HOOK_EVENTS) {
    const hook = hooks[event];
    if (hook !== undefined) copied[event] = hook;
  }
  return Object.freeze({ entity, hooks: Object.freeze(copied) });
}

/**
 * Compile one or more {@link defineEntityHooks} declarations into a TypeORM
 * entity subscriber class suitable for a data source's `subscribers` option.
 * Multiple declarations for the same entity run in the order they are given.
 *
 * The returned class is decorated with `@EventSubscriber()`, which TypeORM
 * requires for any subscriber listed under `options.subscribers`. Each call
 * builds a distinct class closing over its own registry, so hook state never
 * leaks between data sources.
 */
export function createEntitySubscriber(
  ...definitions: readonly EntityHooksDefinition<ObjectLiteral>[]
): EntitySubscriberClass {
  const registry = new Map<unknown, HookEntry[]>();
  for (const definition of definitions) {
    assertDefinition(definition);
    const key = entityKey(definition.entity);
    const entries = registry.get(key) ?? [];
    for (const event of ROW_HOOK_EVENTS) {
      const hook = definition.hooks[event];
      if (hook !== undefined) entries.push({ kind: 'row', event, hook });
    }
    for (const event of BULK_HOOK_EVENTS) {
      const hook = definition.hooks[event];
      if (hook !== undefined) entries.push({ kind: 'bulk', event, hook });
    }
    registry.set(key, entries);
  }

  @EventSubscriber()
  class JsailsEntityHooksSubscriber {
    beforeInsert(event: InsertEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'beforeInsert', event, {
        entity: event.entity,
        data: event.entity,
        manager: event.manager,
      });
    }

    afterInsert(event: InsertEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'afterInsert', event, {
        entity: event.entity,
        data: event.entity,
        manager: event.manager,
      });
    }

    beforeUpdate(event: UpdateEvent<ObjectLiteral>): Awaitable<void> {
      return dispatchUpdate(registry, 'before', event);
    }

    afterUpdate(event: UpdateEvent<ObjectLiteral>): Awaitable<void> {
      return dispatchUpdate(registry, 'after', event);
    }

    beforeRemove(event: RemoveEvent<ObjectLiteral>): Awaitable<void> {
      const context = removeContext(event);
      return context === undefined ? undefined : run(registry, 'beforeDelete', event, context);
    }

    afterRemove(event: RemoveEvent<ObjectLiteral>): Awaitable<void> {
      const context = removeContext(event);
      return context === undefined ? undefined : run(registry, 'afterDelete', event, context);
    }

    afterLoad(entity: ObjectLiteral, event: LoadEvent<ObjectLiteral>): Awaitable<void> {
      return run(registry, 'afterLoad', event, {
        entity,
        data: entity,
        manager: event.manager,
      });
    }
  }

  return JsailsEntityHooksSubscriber;
}

/**
 * Resolve the registry key for an entity target. A class (or an EntitySchema
 * bound to one) is keyed by the constructor identity so two same-named classes
 * in one process stay distinct; a schema without a target and a plain name are
 * keyed by the entity name, which is what the event metadata carries.
 */
function entityKey(entity: EntityTarget<unknown>): unknown {
  if (typeof entity === 'function') {
    return entity;
  }
  if (typeof entity === 'string') {
    return entity;
  }
  if (entity instanceof EntitySchema) {
    const target = entity.options.target;
    return typeof target === 'function' ? target : entity.options.name;
  }
  return entity.name;
}

/**
 * Route an update event. TypeORM fires the same subscriber method for two
 * different things:
 *
 * - a subject update from `save()`: `entity` is the instance being saved and
 *   `databaseEntity` the row loaded before it, so the row hooks run;
 * - a query-builder UPDATE: `entity` is the SET map, there is no
 *   `databaseEntity`, and no column or relation diff, so the bulk hooks run
 *   with that map.
 *
 * Anything else (a relation-id update TypeORM derives for a parent's
 * collection, which carries neither the row nor the instance) has no data a
 * hook could act on and runs nothing.
 */
function dispatchUpdate(
  registry: ReadonlyMap<unknown, HookEntry[]>,
  phase: 'before' | 'after',
  event: UpdateEvent<ObjectLiteral>,
): Awaitable<void> {
  const { entity, databaseEntity } = event;
  if (entity === undefined || entity === null) return undefined;
  if (databaseEntity !== undefined && databaseEntity !== null) {
    return run(registry, phase === 'before' ? 'beforeUpdate' : 'afterUpdate', event, {
      entity: databaseEntity,
      data: entity,
      manager: event.manager,
      changedColumns: event.updatedColumns.map((column) => column.propertyName),
    });
  }
  if (event.updatedColumns.length > 0 || event.updatedRelations.length > 0) return undefined;
  return runBulk(registry, phase === 'before' ? 'beforeBulkUpdate' : 'afterBulkUpdate', event, {
    values: entity,
    manager: event.manager,
  });
}

/**
 * Build the context for a remove event, or `undefined` for a query-builder
 * DELETE, which names no row (only a WHERE clause) and so has nothing a
 * delete hook could inspect.
 */
function removeContext(
  event: RemoveEvent<ObjectLiteral>,
): EntityHookContext<ObjectLiteral> | undefined {
  const entity: ObjectLiteral | undefined = event.databaseEntity ?? event.entity;
  if (entity === undefined || entity === null) return undefined;
  return { entity, data: entity, manager: event.manager };
}

interface HookEventTarget {
  readonly metadata: { readonly target: Function | string; readonly name: string };
}

/**
 * The hooks registered for the event's entity, in declaration order. The
 * event metadata supplies the lookup key; a miss is a cheap no-op (the
 * subscriber listens to every entity and filters internally).
 */
function entriesFor(
  registry: ReadonlyMap<unknown, HookEntry[]>,
  event: HookEventTarget,
): readonly HookEntry[] {
  return registry.get(event.metadata.target) ?? registry.get(event.metadata.name) ?? [];
}

/** Run every row hook registered for `eventName` on the event's entity. */
async function run(
  registry: ReadonlyMap<unknown, HookEntry[]>,
  eventName: EntityRowHookEvent,
  event: HookEventTarget,
  context: EntityHookContext<ObjectLiteral>,
): Promise<void> {
  for (const entry of entriesFor(registry, event)) {
    if (entry.kind === 'row' && entry.event === eventName) {
      await entry.hook(context);
    }
  }
}

/** Run every bulk-update hook registered for `eventName` on the event's entity. */
async function runBulk(
  registry: ReadonlyMap<unknown, HookEntry[]>,
  eventName: EntityBulkHookEvent,
  event: HookEventTarget,
  context: EntityBulkUpdateContext,
): Promise<void> {
  for (const entry of entriesFor(registry, event)) {
    if (entry.kind === 'bulk' && entry.event === eventName) {
      await entry.hook(context);
    }
  }
}

function assertHooksObject(hooks: unknown, label: string): void {
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new EntityHooksError(`${label}: "hooks" must be an object`);
  }
  const record = hooks as Record<EntityHookEvent, unknown>;
  for (const event of HOOK_EVENTS) {
    const hook = record[event];
    if (hook !== undefined && typeof hook !== 'function') {
      throw new EntityHooksError(`${label}: hook "${event}" must be a function`);
    }
  }
}

function assertDefinition(
  definition: unknown,
): asserts definition is EntityHooksDefinition<ObjectLiteral> {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new EntityHooksError('createEntitySubscriber: every definition must be an object');
  }
  const record = definition as { entity?: unknown; hooks?: unknown };
  assertEntityTarget(record.entity, () => {
    throw new EntityHooksError(
      'createEntitySubscriber: "entity" must be a class, an EntitySchema, or an entity name',
    );
  });
  assertHooksObject(record.hooks, 'createEntitySubscriber');
}
