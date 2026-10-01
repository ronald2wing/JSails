/**
 * Nested server-component slots inside a bound root: what the root reports as
 * held, how a morph keeps a held child, and how a parent's refresh effect
 * finds its children.
 *
 * Every nested child sits in a wrapper the server renders with its slot
 * (`data-jsails-nested-slot`), its component (`data-jsails-nested-component`),
 * and an id derived from the parent instance and the slot. An update reports
 * the children a root holds by `(slot, component)` ({@link collectHeldSlots});
 * the server answers a kept child with the same wrapper holding only a keep
 * marker, and {@link keepsNestedWrapper} tells the morph to leave that wrapper
 * (the child's DOM, controller, typed values, and errors) untouched. A keep
 * marker that still lands in the DOM (the child went away while the request
 * was in flight) is found by {@link hasUnkeptMarker}, and the parent re-renders
 * once with a full render.
 */

import {
  COMPONENT_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  NESTED_COMPONENT_ATTRIBUTE,
  NESTED_KEEP_ATTRIBUTE,
  NESTED_SLOT_ATTRIBUTE,
} from '../../server-components/protocol.js';
import {
  MAX_SLOT_COMPONENT_LENGTH,
  MAX_SLOT_LENGTH,
  type ComponentHeldSlot,
} from '../../wire/protocol.js';
import { ISLAND_ATTRIBUTE } from '../islands.js';
import type { ComponentElement } from './dom-contract.js';

const ROOT_SELECTOR = `[${COMPONENT_ATTRIBUTE}]`;
const WRAPPER_SELECTOR = `[${NESTED_SLOT_ATTRIBUTE}]`;
const KEEP_SELECTOR = `[${NESTED_KEEP_ATTRIBUTE}]`;
const OUT_OF_SCOPE_SELECTORS = [`[${ISLAND_ATTRIBUTE}]`, `[${IGNORE_ATTRIBUTE}]`] as const;

/** A wrapper of one nested child directly inside a root, with its child root when present. */
interface NestedWrapper {
  readonly element: ComponentElement;
  readonly slot: string;
  readonly component: string;
  readonly child: ComponentElement | null;
}

/** The direct child of `parent` matching `selector`, or `null`. */
function directChild(parent: ComponentElement, selector: string): ComponentElement | null {
  const found = parent.querySelector(selector);
  return found !== null && found.parentElement === parent ? found : null;
}

/**
 * The nested-child wrappers whose nearest enclosing root is `root`, in
 * document order, skipping wrappers inside an island or an ignored subtree
 * and wrappers whose slot or component exceeds the protocol's bounds.
 */
function nestedWrappers(root: ComponentElement): NestedWrapper[] {
  const wrappers: NestedWrapper[] = [];
  for (const element of Array.from(root.querySelectorAll(WRAPPER_SELECTOR))) {
    if (element.parentElement?.closest(ROOT_SELECTOR) !== root) {
      continue;
    }
    if (OUT_OF_SCOPE_SELECTORS.some((selector) => element.closest(selector) !== null)) {
      continue;
    }
    const slot = element.getAttribute(NESTED_SLOT_ATTRIBUTE);
    const component = element.getAttribute(NESTED_COMPONENT_ATTRIBUTE);
    if (
      slot === null ||
      slot === '' ||
      slot.length > MAX_SLOT_LENGTH ||
      component === null ||
      component === '' ||
      component.length > MAX_SLOT_COMPONENT_LENGTH
    ) {
      continue;
    }
    wrappers.push({ element, slot, component, child: directChild(element, ROOT_SELECTOR) });
  }
  return wrappers;
}

/**
 * The children `root` holds, by `(slot, component)`: every direct wrapper
 * whose child root is bound to a live, unblocked controller (`isLive`). A
 * child that is not live is left out, so the server mounts it fresh.
 */
export function collectHeldSlots(
  root: ComponentElement,
  isLive: (child: ComponentElement) => boolean,
): ComponentHeldSlot[] {
  const held: ComponentHeldSlot[] = [];
  for (const wrapper of nestedWrappers(root)) {
    if (wrapper.child !== null && isLive(wrapper.child)) {
      held.push({ slot: wrapper.slot, component: wrapper.component });
    }
  }
  return held;
}

/** The child root in `root`'s wrapper for `slot`, or `null`. */
export function nestedChildAt(root: ComponentElement, slot: string): ComponentElement | null {
  for (const wrapper of nestedWrappers(root)) {
    if (wrapper.slot === slot) {
      return wrapper.child;
    }
  }
  return null;
}

/** True when a wrapper directly inside `root` carries a keep marker instead of its child. */
export function hasUnkeptMarker(root: ComponentElement): boolean {
  return nestedWrappers(root).some(
    (wrapper) => wrapper.child === null && directChild(wrapper.element, KEEP_SELECTOR) !== null,
  );
}

/** The structural slice of an element the keep predicate reads. */
interface MorphElement {
  getAttribute(name: string): string | null;
  querySelector(selector: string): MorphElement | null;
  readonly parentElement: unknown;
}

function isMorphElement(value: unknown): value is MorphElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getAttribute?: unknown }).getAttribute === 'function' &&
    typeof (value as { querySelector?: unknown }).querySelector === 'function'
  );
}

/**
 * True when a morph about to rewrite `current` with `next` must leave
 * `current` as it is: both are the same nested wrapper (id, slot, and
 * component), `next` holds the server's keep marker, and `current` still holds
 * its child root. Wired to Turbo's cancelable `turbo:before-morph-element`.
 */
export function keepsNestedWrapper(current: unknown, next: unknown): boolean {
  if (!isMorphElement(current) || !isMorphElement(next)) {
    return false;
  }
  const slot = current.getAttribute(NESTED_SLOT_ATTRIBUTE);
  const id = current.getAttribute('id');
  if (slot === null || id === null || id === '') {
    return false;
  }
  if (
    next.getAttribute('id') !== id ||
    next.getAttribute(NESTED_SLOT_ATTRIBUTE) !== slot ||
    next.getAttribute(NESTED_COMPONENT_ATTRIBUTE) !==
      current.getAttribute(NESTED_COMPONENT_ATTRIBUTE)
  ) {
    return false;
  }
  const marker = next.querySelector(KEEP_SELECTOR);
  const child = current.querySelector(ROOT_SELECTOR);
  return marker !== null && marker.parentElement === next && child?.parentElement === current;
}
