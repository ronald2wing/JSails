/**
 * The lifecycle of one bound component root: creating the controller from the
 * server-rendered snapshot and CSRF markers, morphing every render back into
 * the root, dispatching actions, and disposing the binding.
 *
 * A render morphs the full server root (outer replace, `method` morph),
 * retargets the binding when the morph replaces the root element, and
 * reapplies working values without disturbing an unchanged control's caret.
 * A fatal controller error shows a fixed plaintext message and never injects
 * raw response HTML; a 422 validation render is morphed from the server's own
 * HTML. Nested islands inside a morphed root are torn down and remounted
 * through the shared {@link IslandManager} (`beforeMorph`/`afterMorph`), never
 * a second manager.
 */

import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
} from '../../server-components/protocol.js';
import {
  ComponentController,
  ComponentControllerError,
  type ComponentControllerOptions,
  type ComponentRender,
} from '../component-controller.js';
import type { ComponentUploadProgress } from '../component-upload.js';
import { ISLAND_ATTRIBUTE, ISLAND_HYDRATED_ATTRIBUTE, type IslandManager } from '../islands.js';
import { captureBoundValues, reapplyWorkingValues } from './control-values.js';
import { cancelAllDebounce } from './debounce.js';
import { syncMarkers } from './directives.js';
import {
  ComponentBindingError,
  type ComponentDocument,
  type ComponentElement,
} from './dom-contract.js';
import {
  observeIntersections,
  type IntersectionObserverFactory,
  type IntersectionObserverLike,
} from './intersections.js';
import { parsePollMarker, startPolling, type PollHandle, type PollSignals } from './polling.js';
import { findUploadInput } from './uploads.js';

/** Fixed plaintext shown when a component is permanently blocked. */
export const COMPONENT_BLOCKED_MESSAGE =
  'This component could not be updated. Reload the page to try again.';

/** Selector for a component root. */
export const ROOT_SELECTOR = `[${COMPONENT_ATTRIBUTE}]`;

/** Selector for a client island (its controls are out of scope). */
const ISLAND_SELECTOR = `[${ISLAND_ATTRIBUTE}]`;

/** Selector for an ignored subtree (its controls are out of scope). */
const IGNORE_SELECTOR = `[${IGNORE_ATTRIBUTE}]`;

/** A morph function: render `html` into the element with `target` id. */
export type ComponentMorph = (target: string, html: string) => Promise<void>;

/** The explicit JSON arguments an action trigger carries. */
export type ActionArgs = Parameters<ComponentController['commit']>[1];

/** A live binding between one component root and its controller. */
export interface RootBinding {
  element: ComponentElement;
  readonly controller: ComponentController;
  /** Upload error elements keyed by the file input they belong to. */
  readonly uploadErrors: WeakMap<ComponentElement, ComponentElement>;
  /** Per-field debounce timers keyed by model field name. */
  readonly debounce: Map<string, ReturnType<typeof setTimeout>>;
  /** Poll loop, present when the root carries a valid poll marker. */
  poll: PollHandle | null;
  disposed: boolean;
  /** Observer of the root's `[data-jsails-intersect]` elements, `null` when none. */
  intersectionObserver: IntersectionObserverLike<ComponentElement> | null;
}

/** What a root binding needs from the binding manager that owns it. */
export interface RootBindingHost {
  readonly document: ComponentDocument;
  /** Morphs server HTML into the root by element id. */
  readonly morph: ComponentMorph;
  /** Shared island manager, used to tear down/remount nested islands. */
  readonly islands: IslandManager | undefined;
  /** Trusted http(s) origin bound into each controller. */
  readonly origin: string;
  /** Fetch implementation forwarded to each controller. */
  readonly fetch: ComponentControllerOptions['fetch'] | undefined;
  /** XHR factory forwarded to each controller for file uploads. */
  readonly uploadRequest: ComponentControllerOptions['uploadRequest'] | undefined;
  /** Receives upload progress for a bound file input. */
  readonly onUploadProgress:
    | ((field: string, input: ComponentElement, progress: ComponentUploadProgress) => void)
    | undefined;
  /** Navigation callback for a server-signaled redirect; falls back to `location.assign`. */
  readonly navigate: ((url: string) => void) | undefined;
  /** Injectable `IntersectionObserver` factory; the intersect directive is a no-op without one. */
  readonly createIntersectionObserver: IntersectionObserverFactory<ComponentElement> | undefined;
  /** Visibility/connectivity signals driving poll pause/resume. */
  readonly pollSignals: PollSignals;
  /** Report a non-fatal binding failure. */
  readonly report: (error: unknown, element: ComponentElement) => void;
  /** Re-key the binding after a morph replaced its root element. */
  readonly retarget: (binding: RootBinding, previous: ComponentElement) => void;
}

/** Resolve the nearest component root for an event target, if any. */
export function rootFor(target: ComponentElement | null): ComponentElement | null {
  if (target === null) {
    return null;
  }
  if (target.closest(ISLAND_SELECTOR) !== null || target.closest(IGNORE_SELECTOR) !== null) {
    return null;
  }
  return target.closest(ROOT_SELECTOR);
}

/** The element whose `data-jsails-ref` equals `name` within `root`, or `null`. */
export function findRef(root: ComponentElement, name: string): ComponentElement | null {
  if (name === '') {
    return null;
  }
  // Iterate descendants directly rather than using a CSS attribute-value
  // selector, so the lookup works against minimal test doubles whose
  // `querySelectorAll` only supports `[attr]` presence checks (no value
  // matching). In a real browser both approaches are equivalent.
  for (const element of Array.from(root.querySelectorAll(`[${REF_ATTRIBUTE}]`))) {
    if (element.getAttribute(REF_ATTRIBUTE) === name) {
      return element;
    }
  }
  return null;
}

/**
 * Dispatch one action from `trigger`: capture the latest bound values and
 * cancel pending debounces first, because the action carries the dirty diff.
 */
export function dispatchAction(
  host: RootBindingHost,
  binding: RootBinding,
  trigger: ComponentElement,
  action: string,
  args: ActionArgs,
): void {
  captureBoundValues(binding, rootFor, host.report);
  cancelAllDebounce(binding);
  void binding.controller.commit(action, args).catch((error: unknown) => {
    host.report(error, trigger);
  });
}

/** Observe the root's intersect elements, replacing any previous observer. */
function observeRoot(host: RootBindingHost, binding: RootBinding): void {
  binding.intersectionObserver?.disconnect();
  binding.intersectionObserver = observeIntersections(
    Array.from(binding.element.querySelectorAll(`[${INTERSECT_ATTRIBUTE}]`)),
    (element, action) => {
      if (!binding.disposed) {
        dispatchAction(host, binding, element, action, {});
      }
    },
    host.createIntersectionObserver,
  );
}

/** Morph a render into the root, retargeting and reapplying local edits. */
async function applyRender(
  host: RootBindingHost,
  binding: RootBinding,
  render: ComponentRender,
): Promise<void> {
  if (binding.disposed) {
    return;
  }
  const targetId = binding.element.id;
  if (targetId === '') {
    throw new ComponentBindingError('component root must have an id');
  }

  // Tear down nested islands before the subtree is replaced, then remount
  // them (and any new ones) through the shared manager.
  const restore = host.islands?.beforeMorph(binding.element);
  try {
    await host.morph(targetId, render.html);
  } finally {
    const next = host.document.getElementById(targetId);
    if (next !== null && next !== binding.element) {
      const previous = binding.element;
      binding.element = next;
      // The controller and its working state are preserved by identity; only
      // the element key changes.
      host.retarget(binding, previous);
    }
    restore?.();
    host.islands?.mountWithin(binding.element);
  }

  if (binding.disposed) {
    return;
  }
  // The server HTML carries the new snapshot, but pin it explicitly so a
  // cache snapshot taken before the next render is never stale.
  binding.element.setAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE, render.snapshot);
  // The morph may have replaced the root; re-mark it ready.
  binding.element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
  reapplyWorkingValues(binding, rootFor);
  syncMarkers(binding, rootFor);
  // The previous observer watches elements the morph removed.
  observeRoot(host, binding);
  // The redirect URL was validated server-side (scheme check, no control
  // chars), so it is trusted producer output. Without `navigate` or
  // `location` (Node/test) it is ignored; tests assert on the render object.
  if (render.redirect !== undefined) {
    if (typeof host.navigate === 'function') {
      host.navigate(render.redirect);
    } else {
      const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location;
      if (typeof loc?.assign === 'function') {
        loc.assign(render.redirect);
      }
    }
  }
}

/**
 * Bootstrap a controller for `element` from its snapshot and CSRF markers.
 * Returns `null` (after reporting) when the markers are missing or the
 * controller rejects its options.
 */
export function createRootBinding(
  host: RootBindingHost,
  element: ComponentElement,
): RootBinding | null {
  const snapshot = element.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE);
  const csrfToken = element.getAttribute(COMPONENT_CSRF_ATTRIBUTE);
  if (snapshot === null || snapshot === '' || csrfToken === null || csrfToken === '') {
    host.report(
      new ComponentBindingError('component root is missing its snapshot or CSRF marker'),
      element,
    );
    return null;
  }

  // The controller callbacks close over `binding`, assigned right after
  // construction; none of them fires synchronously.
  let binding: RootBinding;
  let controller: ComponentController;
  const { fetch, uploadRequest, onUploadProgress } = host;
  try {
    controller = new ComponentController({
      snapshot,
      csrfToken,
      origin: host.origin,
      ...(fetch === undefined ? {} : { fetch }),
      ...(uploadRequest === undefined ? {} : { uploadRequest }),
      ...(onUploadProgress === undefined
        ? {}
        : {
            onUploadProgress: (field, progress) => {
              if (binding.disposed) {
                return;
              }
              const input = findUploadInput(binding, field);
              if (input === null) {
                return;
              }
              onUploadProgress(field, input, progress);
            },
          }),
      onRender: (render) => applyRender(host, binding, render),
      onInflightChange: () => {
        syncMarkers(binding, rootFor);
      },
      onError: (error) => {
        if (binding.disposed) {
          return;
        }
        // A fatal controller error permanently blocks the component; show a
        // fixed plaintext message rather than any response body.
        if (error instanceof ComponentControllerError && error.code !== 'invalid_options') {
          binding.element.textContent = COMPONENT_BLOCKED_MESSAGE;
        }
        host.report(error, binding.element);
      },
    });
  } catch (error) {
    host.report(error, element);
    return null;
  }

  binding = {
    element,
    controller,
    uploadErrors: new WeakMap(),
    debounce: new Map(),
    poll: null,
    disposed: false,
    intersectionObserver: null,
  };
  element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
  syncMarkers(binding, rootFor);

  // The poll marker is read once here; a later morph does not restart or
  // retune a running poll.
  const pollOptions = parsePollMarker(element.getAttribute(POLL_ATTRIBUTE));
  if (pollOptions !== null) {
    binding.poll = startPolling({
      options: pollOptions,
      signals: host.pollSignals,
      isActive: () => !binding.disposed && !binding.controller.blocked,
      refresh: () => binding.controller.refresh(),
    });
  }
  observeRoot(host, binding);
  return binding;
}

/** Stop polling, debounces, and observers, then dispose the controller. Idempotent. */
export function disposeRootBinding(binding: RootBinding): void {
  if (binding.disposed) {
    return;
  }
  binding.disposed = true;
  binding.poll?.stop();
  binding.poll = null;
  cancelAllDebounce(binding);
  binding.intersectionObserver?.disconnect();
  binding.intersectionObserver = null;
  binding.controller.dispose();
  binding.element.removeAttribute(ISLAND_HYDRATED_ATTRIBUTE);
}
