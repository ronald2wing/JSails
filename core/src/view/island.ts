/**
 * Islands on the server side of the page: `defineIsland` names a component
 * with the id the browser hydrates it under, and `<Island>` renders it where
 * a page, a layout or a view mounts it (a compiled `.jsails` island tag
 * lowers to it).
 *
 * The id lives on the component itself, so the module the server renders and
 * the module the browser registers (`startClient({ islands: [Counter] })`)
 * cannot name the island differently. `<Island>` encodes the props, decodes
 * them back with the browser's own decoder (`island-props.ts`) and renders
 * the component from that copy inside the marker element, so the first paint
 * is what the hydrating render produces.
 *
 * An island renders inside an island scope (a Preact context): `<Island>`
 * met inside one renders its component directly, because the island around
 * it hydrates that subtree already. The server opens the scope inside its
 * marker element and the browser hydrates through {@link islandTree}, which
 * opens the same scope, so a view that mounts an island renders the same
 * markup on both sides whether or not it is itself inside an island.
 *
 * Browser-safe: Preact and the props codec.
 */

import { createContext, createElement, type ComponentType, type VNode } from 'preact';

import type { ComponentChild } from './component-types.js';
import {
  encodeIslandProps,
  isIslandId,
  IslandErrors,
  ISLAND_ATTRIBUTE,
  ISLAND_ELEMENT,
  ISLAND_PROPS_ATTRIBUTE,
} from './island-props.js';

/**
 * A component named as an island: it renders as a function component, and
 * carries the id it hydrates under.
 *
 * @public
 */
export type DefinedIsland<P> = ((props: P) => ComponentChild) & { readonly islandId: string };

/**
 * The JSON part of a value type: what survives `JSON.stringify` and
 * `JSON.parse`. `unknown` stays `unknown`: a value nothing describes yet,
 * such as a prop decoded from a marker.
 */
type JsonPart<T> = unknown extends T
  ? T
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends bigint | symbol | ((...args: never[]) => unknown)
      ? never
      : T extends object
        ? { [K in keyof T]: JsonPart<T[K]> }
        : never;

/**
 * The props of an island as they cross to the browser, as JSON: each prop of
 * `P` narrowed to its JSON part. Where the server mounts an island, a
 * function, a `bigint` or a `symbol` prop becomes `never`, and an object type
 * is narrowed member by member, so a `Date`, a `Map` or a class instance does
 * not fit; an optional callback prop may still be left out. Without `P`, it
 * is the untyped record the browser decodes from an island's marker.
 *
 * @public
 */
export type IslandProps<P = Record<string, unknown>> = { [K in keyof P]: JsonPart<P[K]> };

/**
 * The props of {@link Island}: the defined island and its props.
 *
 * @public
 */
export interface IslandMount<P> {
  readonly component: DefinedIsland<P>;
  readonly props: IslandProps<NoInfer<P>>;
}

/** Whether a component is an island inside another island's hydrated subtree. */
const IslandScope = createContext(false);

/**
 * Name `component` as the island `id`, the name the browser registry and the
 * server markup share, and return it. A compiled `.jsails` island calls it
 * with its path id (`islands/load-more.jsails` is `load-more`). Throws
 * `island.invalid_id` for an id the registry could not hold, and
 * `island.redefined` when the component is already an island under another
 * id.
 *
 * @public
 */
export function defineIsland<P>(
  id: string,
  component: (props: P) => ComponentChild,
): DefinedIsland<P> {
  if (!isIslandId(id)) throw new IslandErrors.Error('invalid_id');
  if (typeof component !== 'function') throw new IslandErrors.Error('not_defined');
  const existing = islandIdOf(component);
  if (existing !== undefined) {
    if (existing !== id) throw new IslandErrors.Error('redefined');
    return component as DefinedIsland<P>;
  }
  Object.defineProperty(component, 'islandId', { value: id, enumerable: false });
  return component as DefinedIsland<P>;
}

/** The id of a defined island, or `undefined` for any other value. */
export function islandIdOf(component: unknown): string | undefined {
  if (typeof component !== 'function' || !Object.hasOwn(component, 'islandId')) return undefined;
  const id = (component as { readonly islandId?: unknown }).islandId;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The tree an island hydrates: its component with `props`, inside the island
 * scope. The browser runtime hydrates exactly this into the marker element.
 */
export function islandTree(
  component: unknown,
  props: Record<string, unknown>,
): VNode<{ value: boolean }> {
  return createElement(IslandScope.Provider, {
    value: true,
    children: createElement(component as ComponentType<Record<string, unknown>>, props),
  });
}

/**
 * Mount a defined island: on its own, the marker element (a
 * `<jsails-island>`, which `ISLAND_STYLE` (`island-props.ts`) lays out with
 * `display: contents`) holding the island's id, its props as bounded JSON
 * and its server render; inside another island, the component alone. Throws `island.not_defined` for a component
 * without an island id and `island.props_*` for props the browser would
 * refuse.
 *
 * @public
 */
export function Island<P>(mount: IslandMount<P>): ComponentChild {
  return createElement(IslandScope.Consumer, {
    children: (inside: boolean) => renderIsland(mount, inside),
  });
}

function renderIsland<P>(mount: IslandMount<P>, inside: boolean): ComponentChild {
  const id = islandIdOf(mount.component);
  if (id === undefined) throw new IslandErrors.Error('not_defined');
  const component = mount.component as unknown as ComponentType<Record<string, unknown>>;
  if (inside) return createElement(component, mount.props as Record<string, unknown>);
  const { text, decoded } = encodeIslandProps(mount.props);
  return createElement(
    ISLAND_ELEMENT,
    { [ISLAND_ATTRIBUTE]: id, [ISLAND_PROPS_ATTRIBUTE]: text },
    islandTree(component, decoded),
  );
}
