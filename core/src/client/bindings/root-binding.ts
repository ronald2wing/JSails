/**
 * The lifecycle of one bound component root: creating the controller from the
 * server-rendered snapshot marker, morphing every render back into
 * the root, dispatching actions, and disposing the binding.
 *
 * A render morphs the full server root (outer replace, `method` morph),
 * retargets the binding when the morph replaces the root element, and
 * reapplies working values without disturbing an unchanged control's caret.
 * A fatal controller error shows a fixed plaintext message and never injects
 * raw response HTML; a 422 validation render is morphed from the server's own
 * HTML. Nested islands inside a morphed root go through the shared
 * {@link IslandManager} (`beforeMorph`), never a second manager: an island
 * whose name and props are unchanged keeps its state, any other is torn down
 * and remounted. A transient controller failure leaves the root usable, and
 * an expired snapshot reloads the page for a fresh one.
 *
 * Nested server components: every update reports the nested children the
 * root holds (`have.slots`, see `nested-slots.ts`), so the server keeps them by
 * reference and the morph leaves them untouched; after each morph the host
 * reconciles the child bindings inside the root (see
 * {@link RootBindingHost.syncNested}), and a parent action's refresh effect
 * refreshes the named children, each through its own controller.
 *
 * A server that speaks another protocol version is answered with one page
 * reload, guarded in `sessionStorage` so a stale page cannot reload in a loop.
 */

import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_RENDER_ATTRIBUTE,
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
import { captureBoundValues, pendingLazyEdits, reapplyWorkingValues } from './control-values.js';
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
import { collectHeldSlots, hasUnkeptMarker, nestedChildAt } from './nested-slots.js';
import { parsePollMarker, startPolling, type PollHandle, type PollSignals } from '../polling.js';
import { findUploadInput } from './uploads.js';

/** Fixed plaintext shown when a component is permanently blocked. */
export const COMPONENT_BLOCKED_MESSAGE =
  'This component could not be updated. Reload the page to try again.';

/** Selector for a component root. */
export const ROOT_SELECTOR: string = `[${COMPONENT_ATTRIBUTE}]`;

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
  /**
   * The root element id at bind time. It embeds the component instance id, so
   * a morph that leaves this element in place under another id has swapped in
   * a different instance and the binding must be rebuilt.
   */
  readonly instanceId: string;
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
  /** The live binding for a component root element, if one is bound. */
  readonly bindingOf: (element: ComponentElement) => RootBinding | undefined;
  /**
   * Reconcile the nested component roots inside a just-morphed root: dispose
   * removed ones, bind new ones, and rebuild a child the morph swapped for
   * another instance.
   */
  readonly syncNested: (root: ComponentElement) => void;
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
  binding.controller.commit(action, args).catch((error: unknown) => {
    host.report(error, trigger);
  });
}

/** The children `root` holds: wrappers whose child root has a live, unblocked binding. */
function heldSlotsOf(host: Pick<RootBindingHost, 'bindingOf'>, root: ComponentElement) {
  return collectHeldSlots(root, (child) => {
    const binding = host.bindingOf(child);
    return binding !== undefined && !binding.controller.blocked;
  });
}

/** Refresh the kept children a parent action named, each with its own controller. */
function refreshChildren(
  host: RootBindingHost,
  binding: RootBinding,
  slots: readonly string[],
): void {
  for (const slot of slots) {
    const child = nestedChildAt(binding.element, slot);
    const childBinding = child === null ? undefined : host.bindingOf(child);
    if (childBinding === undefined || childBinding.controller.blocked) {
      continue;
    }
    childBinding.controller.refresh().catch((error: unknown) => {
      host.report(error, childBinding.element);
    });
  }
}

/** Navigate to a server-validated URL: through `navigate` when wired, else `location.assign`. */
function navigateTo(host: RootBindingHost, url: string): void {
  if (typeof host.navigate === 'function') {
    host.navigate(url);
    return;
  }
  const loc = (globalThis as { location?: { assign?: (url: string) => void } }).location;
  if (typeof loc?.assign === 'function') {
    loc.assign(url);
  }
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

  // A lazy control's uncommitted text is not in working state, so it is read
  // before the morph and put back after it.
  const pending = pendingLazyEdits(binding, rootFor);
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
    host.syncNested(binding.element);
  }

  if (binding.disposed) {
    return;
  }
  // The server HTML carries the new snapshot and render tag, but pin them
  // explicitly so a cache snapshot taken before the next render is never stale.
  binding.element.setAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE, render.snapshot);
  binding.element.setAttribute(COMPONENT_RENDER_ATTRIBUTE, render.render);
  // The morph may have replaced the root; re-mark it ready.
  binding.element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, 'true');
  reapplyWorkingValues(binding, rootFor, pending);
  syncMarkers(binding, rootFor);
  // The previous observer watches elements the morph removed.
  observeRoot(host, binding);
  // A kept child that went away while the request was in flight leaves its
  // keep marker in the DOM; one full render mounts it again.
  if (hasUnkeptMarker(binding.element)) {
    binding.controller.invalidateRender();
    binding.controller.refresh().catch((error: unknown) => {
      host.report(error, binding.element);
    });
  }
  const effects = render.effects;
  if (effects === undefined) {
    return;
  }
  if (effects.refresh !== undefined) {
    refreshChildren(host, binding, effects.refresh);
  }
  // Redirect and download URLs were validated server-side (a redirect is a
  // same-origin path), so they are trusted producer output; the browser turns a
  // download's Content-Disposition into a file without leaving the page.
  // Without `navigate` or `location` (Node/test) they are ignored.
  const url = effects.redirect ?? effects.download?.url;
  if (url !== undefined) {
    navigateTo(host, url);
  }
}

/**
 * Reload the current page so the server mounts the component again with a
 * fresh snapshot: through `navigate` (Turbo) when wired, else a full reload.
 * Outside a browser (Node/test) there is nothing to reload.
 */
function reloadForFreshSnapshot(host: RootBindingHost): void {
  const loc = (globalThis as { location?: { href?: string; reload?: () => void } }).location;
  if (typeof host.navigate === 'function' && typeof loc?.href === 'string') {
    host.navigate(loc.href);
  } else if (typeof loc?.reload === 'function') {
    loc.reload();
  }
}

/** `sessionStorage` key holding the time of the last protocol-mismatch reload. */
const PROTOCOL_RELOAD_KEY = 'jsails:component-protocol-reload';
/** A second mismatch within this window does not reload again. */
const PROTOCOL_RELOAD_WINDOW_MS = 60_000;

/**
 * Claim the one protocol-mismatch reload allowed per window: true when no
 * reload happened in the last minute (recording this one), false when one did
 * or the storage is unavailable, so a page the server keeps rejecting cannot
 * reload in a loop.
 */
function claimProtocolReload(): boolean {
  try {
    const storage = (
      globalThis as {
        sessionStorage?: {
          getItem(key: string): string | null;
          setItem(key: string, value: string): void;
        };
      }
    ).sessionStorage;
    if (storage === undefined) {
      return false;
    }
    const now = Date.now();
    const last = Number(storage.getItem(PROTOCOL_RELOAD_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < PROTOCOL_RELOAD_WINDOW_MS) {
      return false;
    }
    storage.setItem(PROTOCOL_RELOAD_KEY, String(now));
    return true;
  } catch {
    // Storage that throws (blocked site data) cannot guard a reload; the
    // component is blocked instead.
    return false;
  }
}

/**
 * Bootstrap a controller for `element` from its snapshot marker. Returns
 * `null` (after reporting) when the marker is missing or the
 * controller rejects its options.
 */
export function createRootBinding(
  host: RootBindingHost,
  element: ComponentElement,
): RootBinding | null {
  const snapshot = element.getAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE);
  const renderTag = element.getAttribute(COMPONENT_RENDER_ATTRIBUTE);
  if (snapshot === null || snapshot === '') {
    host.report(
      new ComponentBindingError('component root is missing its snapshot marker'),
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
      origin: host.origin,
      ...(renderTag === null || renderTag === '' ? {} : { render: renderTag }),
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
      heldSlots: () => (binding.disposed ? [] : heldSlotsOf(host, binding.element)),
      onSnapshot: (token) => {
        if (!binding.disposed) {
          binding.element.setAttribute(COMPONENT_SNAPSHOT_ATTRIBUTE, token);
        }
      },
      onInflightChange: () => {
        syncMarkers(binding, rootFor);
      },
      onError: (error) => {
        if (binding.disposed) {
          return;
        }
        // A transient (retryable) failure leaves the component usable. An
        // expired snapshot or a server on another protocol version needs a
        // fresh page render, so the page is reloaded (once per minute for a
        // protocol mismatch).
        // Any other fatal error permanently blocks the component; show a fixed
        // plaintext message rather than any response body.
        if (error instanceof ComponentControllerError && binding.controller.blocked) {
          if (error.code === 'snapshot_expired') {
            reloadForFreshSnapshot(host);
          } else if (error.code === 'protocol_mismatch' && claimProtocolReload()) {
            reloadForFreshSnapshot(host);
          } else {
            binding.element.textContent = COMPONENT_BLOCKED_MESSAGE;
          }
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
    instanceId: element.id,
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
      // The loop owns the backoff and the `Retry-After` wait, so the
      // controller hands it each transient failure instead of retrying.
      refresh: () => binding.controller.refresh({ retry: false }),
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
