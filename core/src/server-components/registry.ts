/**
 * The app-owned server-component registry: every component an application
 * serves, keyed by its component id.
 *
 * A component id is the identity the runtime signs into every credential
 * (snapshot, download reference) and looks components up by. The build
 * derives it from the component's file (`components/task-list.tsx` is
 * `task-list`, see `componentIdFor` in the compiler conventions) and emits it
 * into `.jsails/components.registry.ts`; an explicit `components` map on the
 * plugin supplies it as the map key. Until the build manifest owns ids, every
 * definition still carries `name`, and it must equal its id, so a component
 * can never be served under one identity and signed under another.
 *
 * {@link createComponentRegistry} builds one frozen registry per application
 * from its entries and refuses a duplicate id at assembly: two entries under
 * one id would let one module take over the other's snapshots. Nothing here is
 * module-level state, so two applications in one process never share
 * components.
 *
 * Server-only: reached through the server-components extension and runtime.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { isPlainObject } from '../json/shape.js';
import type { ServerComponentDefinition } from './component.js';

/**
 * The component id grammar: what an error context `identifier` accepts, so an
 * id can be named in a value-free assembly error. Path-derived ids
 * (`task-list`, `admin/user-card`) and package-scoped ids
 * (`@acme/blog:post-list`) both match.
 */
const COMPONENT_ID = /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/;

const COMPONENT_REGISTRY_ERRORS = {
  duplicate_id: {
    kind: 'conflict',
    message: 'two server components share the id {id}',
    context: { id: 'identifier' },
    suggestion: 'rename one component file, or give the explicit components map distinct keys',
  },
  invalid_id: {
    kind: 'invalid',
    message: 'a server component id is not a valid identifier',
    suggestion: 'use the path-derived id: letters, digits and _ . : @ / -, at most 128 characters',
  },
  invalid_definition: {
    kind: 'invalid',
    message: 'the server component registered as {id} is not a component definition',
    context: { id: 'identifier' },
    suggestion: 'default-export the result of defineComponent or defineServerComponent',
  },
  name_mismatch: {
    kind: 'invalid',
    message: 'the server component registered as {id} declares a different name',
    context: { id: 'identifier' },
    suggestion: 'set the definition name to its component id (the file path under components/)',
  },
  invalid_entries: {
    kind: 'invalid',
    message: 'the server component entries are not a list of id and definition records',
  },
} as const;

/**
 * The registry's assembly codes, `component_registry.*`: a duplicate, a
 * malformed id, a value that is not a definition, and a name that disagrees
 * with its id.
 *
 * @public
 */
export const ComponentRegistryErrors: ErrorRegistry<
  'component_registry',
  typeof COMPONENT_REGISTRY_ERRORS
> = defineErrors('component_registry', COMPONENT_REGISTRY_ERRORS);

/**
 * One component and the id it is served and signed under.
 *
 * @public
 */
export interface ComponentEntry {
  readonly id: string;
  readonly definition: ServerComponentDefinition<any>;
}

/**
 * An application's components, keyed by id, in entry order.
 *
 * @public
 */
export interface ComponentRegistry {
  /** The definition registered under `id`, or `undefined`. */
  get(id: string): ServerComponentDefinition<any> | undefined;
  /** Every id, in entry order. */
  ids(): readonly string[];
  /** Every entry, in entry order. */
  entries(): readonly ComponentEntry[];
  readonly size: number;
}

/** True when `value` is a well-formed component id. */
export function isComponentId(value: unknown): value is string {
  return typeof value === 'string' && COMPONENT_ID.test(value);
}

/**
 * Build an application's registry from its entries, refusing a malformed id,
 * a value that is not a definition, a definition whose `name` differs from its
 * id, and a second entry under a taken id.
 *
 * @public
 */
export function createComponentRegistry(entries: Iterable<ComponentEntry>): ComponentRegistry {
  if (entries === null || typeof entries !== 'object' || !(Symbol.iterator in entries)) {
    throw new ComponentRegistryErrors.Error('invalid_entries');
  }
  const byId = new Map<string, ServerComponentDefinition<any>>();
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw new ComponentRegistryErrors.Error('invalid_entries');
    }
    const { id, definition } = entry as Partial<ComponentEntry>;
    if (!isComponentId(id)) {
      throw new ComponentRegistryErrors.Error('invalid_id');
    }
    if (!isPlainObject(definition) || typeof definition.render !== 'function') {
      throw new ComponentRegistryErrors.Error('invalid_definition', { id });
    }
    if (definition.name !== id) {
      throw new ComponentRegistryErrors.Error('name_mismatch', { id });
    }
    if (byId.has(id)) {
      throw new ComponentRegistryErrors.Error('duplicate_id', { id });
    }
    byId.set(id, definition);
  }
  const frozenEntries: readonly ComponentEntry[] = Object.freeze(
    [...byId].map(([id, definition]) => Object.freeze({ id, definition })),
  );
  const ids: readonly string[] = Object.freeze([...byId.keys()]);
  return Object.freeze({
    get: (id: string) => byId.get(id),
    ids: () => ids,
    entries: () => frozenEntries,
    size: byId.size,
  });
}

/** The introspection view of one registered component: its id and declared surface. */
export interface ComponentDescription {
  readonly name: string;
  readonly actions: readonly string[];
  readonly writableKeys: readonly string[];
}

/**
 * Describe every registered component by id, action names, and writable keys,
 * never its state, schemas, or callbacks. The runtime, the plugin descriptor,
 * and static `jsails describe` all report through this one projection.
 */
export function describeComponentRegistry(
  registry: ComponentRegistry,
): readonly ComponentDescription[] {
  return Object.freeze(
    registry.entries().map(({ id, definition }) =>
      Object.freeze({
        name: id,
        actions: Object.freeze(Object.keys(definition.actions ?? {})),
        writableKeys: Object.freeze([...(definition.writableKeys ?? [])]),
      }),
    ),
  );
}

/** Build a registry from a plain `{ id: definition }` map (explicit or test wiring). */
export function componentRegistryFromMap(
  components: Readonly<Record<string, ServerComponentDefinition<any>>>,
): ComponentRegistry {
  if (!isPlainObject(components)) {
    throw new ComponentRegistryErrors.Error('invalid_entries');
  }
  return createComponentRegistry(
    Object.entries(components).map(([id, definition]) => ({ id, definition })),
  );
}
