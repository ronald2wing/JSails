/**
 * Render-time directives and status markers for the component binding layer.
 *
 * `applyStateDirectives` (`show`/`text`) is shared with client islands; it is
 * idempotent and safe to run after every render or state change.
 * `syncMarkers` reflects a component controller's in-flight and dirty status
 * onto the root, its bound controls, and an optional loading target.
 */

import {
  DIRTY_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  TEXT_ATTRIBUTE,
} from '../../server-components/protocol.js';
import type { ComponentController } from '../component-controller.js';
import { MODEL_SELECTOR, type ResolveOwner } from './control-values.js';
import type { ComponentElement } from './dom-contract.js';

/** Attribute set on a `show` target that has no `hidden` property, for CSS to hide. */
const HIDDEN_FALLBACK_ATTRIBUTE = 'data-jsails-hidden';

/** The element members the state directives touch. */
interface DirectiveElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hidden?: boolean;
  textContent: string | null;
}

/** A subtree the state directives scan. */
interface DirectiveRoot {
  querySelectorAll(selector: string): ArrayLike<DirectiveElement>;
}

/**
 * Apply `data-jsails-show` (hide when the named field is falsy or missing) and
 * `data-jsails-text` (set `textContent` to the field's string form) across
 * `root`. Text is never written as HTML: a field value is untrusted user
 * content.
 */
export function applyStateDirectives(
  root: DirectiveRoot,
  state: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const element of Array.from(root.querySelectorAll(`[${SHOW_ATTRIBUTE}]`))) {
    const field = element.getAttribute(SHOW_ATTRIBUTE);
    if (field === null || field === '') {
      continue;
    }
    const visible = !!state?.[field];
    if (typeof element.hidden === 'boolean') {
      element.hidden = !visible;
    } else if (visible) {
      element.removeAttribute(HIDDEN_FALLBACK_ATTRIBUTE);
    } else {
      element.setAttribute(HIDDEN_FALLBACK_ATTRIBUTE, '');
    }
  }

  for (const element of Array.from(root.querySelectorAll(`[${TEXT_ATTRIBUTE}]`))) {
    const field = element.getAttribute(TEXT_ATTRIBUTE);
    if (field === null || field === '') {
      continue;
    }
    const value = state?.[field];
    if (value === null || value === undefined) {
      element.textContent = '';
    } else if (typeof value === 'object') {
      element.textContent = JSON.stringify(value);
    } else {
      element.textContent = String(value);
    }
  }
}

/** Set or clear `marker` on `element` from `on`. */
function toggleMarker(element: DirectiveElement, marker: string, on: boolean): void {
  if (on) {
    element.setAttribute(marker, 'true');
  } else {
    element.removeAttribute(marker);
  }
}

/** The slice of a live binding the marker pass touches. */
interface MarkerBindingView {
  readonly element: ComponentElement;
  readonly controller: ComponentController;
  readonly disposed: boolean;
}

/**
 * Reflect the controller's status: the loading marker on the root (and on the
 * root's `data-jsails-loading-target` element), the dirty marker on the root
 * and each owned bound control, then re-apply the state directives.
 */
export function syncMarkers(binding: MarkerBindingView, resolveOwner: ResolveOwner): void {
  if (binding.disposed) {
    return;
  }
  const { element: root, controller } = binding;
  const loading = controller.inflight > 0;
  toggleMarker(root, LOADING_ATTRIBUTE, loading);
  toggleMarker(root, DIRTY_ATTRIBUTE, controller.isDirty());
  for (const control of Array.from(root.querySelectorAll(MODEL_SELECTOR))) {
    if (resolveOwner(control) !== root) {
      continue;
    }
    const name = control.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      continue;
    }
    toggleMarker(control, DIRTY_ATTRIBUTE, controller.isDirty(name));
  }

  const loadingTarget = root.getAttribute(LOADING_TARGET_ATTRIBUTE);
  if (loadingTarget !== null && loadingTarget !== '') {
    try {
      const target = root.querySelector(loadingTarget);
      if (target !== null) {
        toggleMarker(target, LOADING_ATTRIBUTE, loading);
      }
    } catch {
      // A malformed selector only loses the advisory marker, never the binding.
    }
  }
  applyStateDirectives(root, controller.state);
}
