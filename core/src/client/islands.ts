/**
 * Browser island runtime: registration and hydration of Preact "island"
 * components over server-rendered markup.
 *
 * An island is a server-rendered element carrying three markers:
 *
 * - `data-jsails-island="name"`   — the registered component name
 * - `data-jsails-props="json"`    — the serialized props (bounded JSON)
 * - `data-hydrated="true"`        — readiness signal, set on hydrate,
 *   removed when the island is restored to its SSR markup
 *
 * The element `id` is optional in general but REQUIRED for a permanent island
 * (`data-turbo-permanent`), because Turbo Drive preserves a permanent element
 * by matching its `id` between the old and the new document.
 *
 * Hydration is tracked per DOM element object (a `WeakMap`), never by the
 * `data-hydrated` attribute alone: a cache restore or a Turbo clone can carry
 * the attribute without a live Preact root behind it. The `WeakMap` is not
 * iterable, so a `Set` of the same elements backs the unmount/cleanup passes;
 * entries leave both collections when a root unmounts or its element leaves the
 * document, keeping the strong `Set` bounded by live islands.
 *
 * This module is browser-safe and Node-import safe: it imports Preact only
 * (which never touches the DOM at module scope) and models the DOM surface it
 * needs with minimal structural types, so it compiles and imports without a
 * DOM lib — matching the `src/broadcast/client.ts` convention.
 *
 * The manager also exposes scoped `beforeMorph`/`afterMorph` hooks so a morph
 * owner (the component binding layer) can tear down and remount the islands
 * nested inside a subtree it is about to morph, reusing this single manager
 * rather than owning a second one. An island the morph leaves unchanged (same
 * name, same props) keeps its live state instead of being remounted.
 */

import { hydrate, render } from 'preact';
import type { ContainerNode, FunctionComponent } from 'preact';

import { formatError } from '../errors/inspect.js';
import { JsailsError } from '../errors/jsails-error.js';
import { islandIdOf, islandTree, type DefinedIsland, type IslandProps } from '../view/island.js';
import {
  decodeIslandProps,
  ISLAND_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
} from '../view/island-props.js';

// ---------------------------------------------------------------------------
// Marker attributes (the SSR/author contract)
// ---------------------------------------------------------------------------

// The name and props markers are defined beside the props codec, which the
// server's `<Island>` shares (`view/island-props.ts`).
export { ISLAND_ATTRIBUTE, ISLAND_PROPS_ATTRIBUTE };

/** Readiness marker, set on hydrate (or binding) and removed on restore. */
export const ISLAND_HYDRATED_ATTRIBUTE = 'data-hydrated';

/** Turbo Drive permanent-element marker (matched by element `id`). */
export const TURBO_PERMANENT_ATTRIBUTE = 'data-turbo-permanent';

// ---------------------------------------------------------------------------
// Minimal structural DOM types
// ---------------------------------------------------------------------------

/**
 * The slice of a DOM element the island runtime touches. Declared structurally
 * (no DOM lib) so the module stays Node-importable; a real `HTMLElement`
 * satisfies every member, and Preact receives the element through its own
 * `ContainerNode` contract at the hydrate boundary.
 */
export interface JsailsElement {
  /** Stable id, required for `data-turbo-permanent` preservation. */
  readonly id: string;
  /** False once the element has been removed from the document. */
  readonly isConnected: boolean;
  /** Serializable inner markup, captured before hydrate and restored after. */
  innerHTML: string;
  /** Plain-text content; set (never HTML) for the generic frame-missing message. */
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  querySelectorAll(selector: string): ArrayLike<JsailsElement>;
}

/** A DOM event as the runtime consumes it. */
export interface JsailsEvent {
  readonly type: string;
  readonly target: JsailsElement | null;
  readonly detail?: unknown;
  preventDefault(): void;
}

/**
 * The slice of `document` the runtime touches. `addEventListener`/
 * `removeEventListener` carry the Turbo event wiring; `dispatchEvent` carries
 * the `jsails:before-navigation` hook.
 */
export interface JsailsDocument {
  querySelectorAll(selector: string): ArrayLike<JsailsElement>;
  addEventListener(type: string, listener: (event: JsailsEvent) => void, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: JsailsEvent) => void,
    options?: unknown,
  ): void;
  dispatchEvent(event: JsailsEvent): boolean;
}

// ---------------------------------------------------------------------------
// Island registry
// ---------------------------------------------------------------------------

// The props an island receives: untyped, the record decoded from its
// `data-jsails-props` marker; the one declaration is the server's
// (`view/island.ts`), where a typed island narrows them to JSON.
export type { IslandProps };

/** A typed Preact island component. */
export type IslandComponent<P extends IslandProps = IslandProps> = FunctionComponent<P>;

/** A name -> component map accepted by `startClient({ islands })`. */
export type IslandMap = Readonly<Record<string, IslandComponent>>;

/**
 * The islands `startClient({ islands })` registers: a name -> component map,
 * or a list of defined islands (`defineIsland`, every compiled `.jsails`
 * island), each registered under its own id, the id its server markup names.
 *
 * @public
 */
export type IslandInput = IslandMap | readonly DefinedIsland<never>[];

/** The live registry keyed by island name. */
export type IslandRegistry = Map<string, IslandComponent>;

/** Stable machine codes carried by {@link IslandRegistryError}. */
export type IslandRegistryErrorCode =
  | 'invalid_island_name'
  | 'invalid_island_component'
  | 'invalid_islands'
  | 'duplicate_island'
  | 'not_found';

/** Raised when a registration violates the name/component contract. */
export class IslandRegistryError extends JsailsError {
  constructor(
    readonly code: IslandRegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const defaultRegistry: IslandRegistry = new Map();

function assertValidIslandName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new IslandRegistryError('invalid_island_name', 'island name must be a non-empty string');
  }
  if (name in Object.prototype) {
    throw new IslandRegistryError(
      'invalid_island_name',
      'island name must not shadow an object prototype member',
    );
  }
}

function assertValidIslandComponent(component: IslandComponent): void {
  if (typeof component !== 'function') {
    throw new IslandRegistryError(
      'invalid_island_component',
      'island component must be a function',
    );
  }
}

/** Register `component` into `registry`, rejecting invalid or conflicting names. */
function registerInto(registry: IslandRegistry, name: string, component: IslandComponent): void {
  assertValidIslandName(name);
  assertValidIslandComponent(component);
  const existing = registry.get(name);
  if (existing !== undefined && existing !== component) {
    throw new IslandRegistryError('duplicate_island', `island "${name}" is already registered`);
  }
  registry.set(name, component);
}

/**
 * Register an island component under `name`.
 *
 * The component is a typed Preact `FunctionComponent`; its props type is
 * preserved for callers, while the runtime hands it `IslandProps` decoded from
 * the marker (JSON is untyped at the boundary). Re-registering the same name
 * with the same component is a no-op; a different component under an existing
 * name is rejected.
 */
export function registerIsland<P extends IslandProps>(
  name: string,
  component: IslandComponent<P>,
): void {
  registerInto(defaultRegistry, name, component as IslandComponent);
}

/**
 * Build a registry from the default plus the declarative `islands`: a map,
 * or a list of defined islands registered under their ids.
 */
export function createIslandRegistry(islands?: IslandInput): IslandRegistry {
  const registry: IslandRegistry = new Map(defaultRegistry);
  if (islands === undefined) {
    return registry;
  }
  if (Array.isArray(islands)) {
    for (const island of islands as readonly unknown[]) {
      const name = islandIdOf(island);
      if (name === undefined) {
        throw new IslandRegistryError(
          'invalid_island_component',
          'each island in a list must be a defined island',
        );
      }
      registerInto(registry, name, island as IslandComponent);
    }
    return registry;
  }
  const prototype = Object.getPrototypeOf(islands);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IslandRegistryError('invalid_islands', 'islands must be a plain object');
  }
  for (const [name, component] of Object.entries(islands)) {
    registerInto(registry, name, component);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Island manager (mount / unmount / restore)
// ---------------------------------------------------------------------------

/** A hydrated root: its element and the SSR markup captured before hydrate. */
interface IslandMountRecord {
  readonly element: JsailsElement;
  readonly originalMarkup: string;
}

/** Coordinates hydration across a document, keyed by element identity. */
export interface IslandManager {
  readonly registry: IslandRegistry;
  /** Hydrate every un-hydrated island in the document. Idempotent per element. */
  mountAll(): void;
  /** Hydrate `root` (if it is an island) and every island inside it. */
  mountWithin(root: JsailsElement): void;
  /** Unmount non-permanent roots and restore their SSR markup (pre-cache). */
  unmountNonPermanent(): void;
  /** Unmount roots whose element is no longer connected (post-render cleanup). */
  collectRemoved(): void;
  /**
   * Prepare the non-permanent islands inside `root` (not `root` itself) for a
   * Turbo morph and return a callback to run once it lands. An island the
   * morph changes or removes is torn down just before Turbo touches it and
   * re-hydrated by the callback when still connected; an island whose name
   * and props are unchanged keeps its live state. Used by a morph owner
   * without a second island manager.
   */
  beforeMorph(root: JsailsElement): () => void;
  /**
   * Tear down the non-permanent islands inside `root` and re-hydrate the ones
   * still connected, for a DOM change that dispatches no Turbo morph events
   * (so no island can be proven unchanged).
   */
  afterMorph(root: JsailsElement): void;
}

interface IslandManagerOptions {
  document: JsailsDocument;
  registry: IslandRegistry;
  /** Called instead of `console.warn` when an element cannot be hydrated. */
  onError?: (error: unknown, element: JsailsElement) => void;
}

/** Create an island manager over a document and registry. */
export class IslandManagerImpl implements IslandManager {
  readonly registry: IslandRegistry;

  // Identity-keyed hydration state: an element's hydrated-ness is a property of
  // the element object, not of its (forgeable) `data-hydrated` attribute.
  #mounted = new WeakMap<JsailsElement, IslandMountRecord>();
  // The WeakMap is not iterable; this mirrors its live keys for sweep passes.
  #mountedElements = new Set<JsailsElement>();
  #doc: JsailsDocument;
  #onError: ((error: unknown, element: JsailsElement) => void) | undefined;

  constructor(options: IslandManagerOptions) {
    const { document: doc, registry, onError } = options;
    this.#doc = doc;
    this.#onError = onError;
    this.registry = registry;
  }

  #report(error: unknown, element: JsailsElement): void {
    if (this.#onError !== undefined) {
      this.#onError(error, element);
      return;
    }
    const message = formatError(error);
    console.warn(`jsails: skipping island hydration: ${message}`);
  }

  #isPermanentRoot(element: JsailsElement): boolean {
    return element.hasAttribute(TURBO_PERMANENT_ATTRIBUTE) && element.id.trim() !== '';
  }

  #hydrateElement(element: JsailsElement): void {
    if (this.#mounted.has(element)) {
      return;
    }
    const name = element.getAttribute(ISLAND_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }
    const component = this.registry.get(name);
    if (component === undefined) {
      this.#report(new IslandRegistryError('not_found', `unknown island "${name}"`), element);
      return;
    }
    let props: IslandProps;
    try {
      props = decodeIslandProps(element.getAttribute(ISLAND_PROPS_ATTRIBUTE));
    } catch (error) {
      this.#report(error, element);
      return;
    }

    const originalMarkup = element.innerHTML;
    try {
      // The island scope `<Island>` opens on the server is opened here too, so
      // an island the component mounts renders inline on both sides.
      hydrate(islandTree(component, props), element as unknown as ContainerNode);
    } catch (error) {
      // A component render error must not break the navigation pipeline: report
      // it and skip this island, leaving the others to hydrate.
      this.#report(error, element);
      return;
    }
    element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
    this.#mounted.set(element, { element, originalMarkup });
    this.#mountedElements.add(element);
  }

  #unmountElement(element: JsailsElement): void {
    const record = this.#mounted.get(element);
    if (record === undefined) {
      return;
    }
    // Tear down Preact's effects/cleanups, then restore the exact SSR markup so
    // a cached snapshot holds clean server HTML rather than hydrated DOM.
    render(null, element as unknown as ContainerNode);
    element.innerHTML = record.originalMarkup;
    element.removeAttribute(ISLAND_HYDRATED_ATTRIBUTE);
    this.#mounted.delete(element);
    this.#mountedElements.delete(element);
  }

  #mountElements(elements: ArrayLike<JsailsElement>): void {
    for (const element of Array.from(elements)) {
      this.#hydrateElement(element);
    }
  }

  mountAll(): void {
    this.#mountElements(this.#doc.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`));
  }

  mountWithin(root: JsailsElement): void {
    this.#hydrateElement(root);
    this.#mountElements(root.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`));
  }

  unmountNonPermanent(): void {
    for (const element of Array.from(this.#mountedElements)) {
      if (!this.#isPermanentRoot(element)) {
        this.#unmountElement(element);
      }
    }
  }

  collectRemoved(): void {
    for (const element of Array.from(this.#mountedElements)) {
      if (!element.isConnected) {
        this.#unmountElement(element);
      }
    }
  }

  /**
   * Keep the non-permanent islands inside `root` (never `root` itself) mounted
   * through a morph when the incoming markup carries the same island with the
   * same props, and tear down only the ones it changes or removes.
   *
   * Turbo dispatches a cancelable `turbo:before-morph-element` for every
   * element it is about to morph or remove. For a mounted island whose
   * incoming element names the same island with identical props, the event is
   * cancelled, so Idiomorph leaves the hydrated subtree (its Preact state,
   * focus, and listeners) alone. Any other island is unmounted right there,
   * restoring its SSR markup before the morph diffs it, and the returned
   * callback re-hydrates it when still connected. An island the morph
   * detached without an event (a wholesale replace) is unmounted by the
   * callback. Permanent roots are always left mounted: Turbo preserves them by
   * id. Cached page snapshots still hold clean server markup, because
   * `unmountNonPermanent` runs before Turbo caches a page.
   */
  beforeMorph(root: JsailsElement): () => void {
    const watched = new Set<JsailsElement>();
    for (const element of Array.from(root.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`))) {
      if (this.#mounted.has(element) && !this.#isPermanentRoot(element)) {
        watched.add(element);
      }
    }
    const tornDown: JsailsElement[] = [];
    const onBeforeMorphElement = (event: JsailsEvent): void => {
      const element = event.target;
      if (element === null || !watched.has(element)) {
        return;
      }
      if (isSameIsland(element, incomingElement(event.detail))) {
        event.preventDefault();
        return;
      }
      watched.delete(element);
      this.#unmountElement(element);
      tornDown.push(element);
    };
    this.#doc.addEventListener(BEFORE_MORPH_ELEMENT_EVENT, onBeforeMorphElement);
    return () => {
      this.#doc.removeEventListener(BEFORE_MORPH_ELEMENT_EVENT, onBeforeMorphElement);
      for (const element of watched) {
        if (!element.isConnected) {
          this.#unmountElement(element);
        }
      }
      for (const element of tornDown) {
        if (element.isConnected) {
          this.#hydrateElement(element);
        }
      }
    };
  }

  afterMorph(root: JsailsElement): void {
    const tornDown: JsailsElement[] = [];
    for (const element of Array.from(root.querySelectorAll(`[${ISLAND_ATTRIBUTE}]`))) {
      if (this.#mounted.has(element) && !this.#isPermanentRoot(element)) {
        this.#unmountElement(element);
        tornDown.push(element);
      }
    }
    for (const element of tornDown) {
      if (element.isConnected) {
        this.#hydrateElement(element);
      }
    }
  }
}

/** Turbo's cancelable per-element morph hook (Idiomorph `beforeNodeMorphed`/`beforeNodeRemoved`). */
const BEFORE_MORPH_ELEMENT_EVENT = 'turbo:before-morph-element';

/** The incoming element of a `turbo:before-morph-element` event; absent on a removal. */
function incomingElement(detail: unknown): JsailsElement | null {
  if (detail === null || typeof detail !== 'object') {
    return null;
  }
  const next = (detail as { newElement?: unknown }).newElement;
  if (next === null || typeof next !== 'object') {
    return null;
  }
  return typeof (next as { getAttribute?: unknown }).getAttribute === 'function'
    ? (next as JsailsElement)
    : null;
}

/** True when `next` renders the same island as `current` with identical props. */
function isSameIsland(current: JsailsElement, next: JsailsElement | null): boolean {
  return (
    next !== null &&
    next.getAttribute(ISLAND_ATTRIBUTE) === current.getAttribute(ISLAND_ATTRIBUTE) &&
    next.getAttribute(ISLAND_PROPS_ATTRIBUTE) === current.getAttribute(ISLAND_PROPS_ATTRIBUTE)
  );
}
