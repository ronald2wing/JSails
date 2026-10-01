/**
 * Browser DOM bindings for stateful server components.
 *
 * The `ComponentController` owns the client model, the serialized update
 * queue, and the same-origin POST; this module connects controllers to the
 * document. It bootstraps one controller per `[data-jsails-component]` root
 * ({@link createRootBinding}), keeps the element-keyed binding map, and attaches
 * the delegated document listeners ({@link createDelegatedEvents}). Click and
 * submit triggers come through the eager trigger queue (`../trigger-queue.ts`):
 * the runtime injects the one it installed before startup, or the manager
 * installs its own; mounting opens it and disposing holds it again.
 *
 * Scope rules:
 * - An event is handled only when its target resolves to a component root via
 *   `closest`, so a control outside any root is ignored.
 * - Controls owned by a client island (`[data-jsails-island]`) or inside a
 *   `[data-jsails-ignore]` subtree are excluded: their owner keeps its own
 *   state and the component must not capture it.
 *
 * Per-concern siblings carry the rest: `root-binding.ts`, `dom-events.ts`,
 * `control-values.ts`, `rules.ts`, `uploads.ts`, `debounce.ts`,
 * `intersections.ts`, and `directives.ts`; the poll loop is `../polling.ts`.
 */

import type { ComponentControllerOptions } from '../component-controller.js';
import type { ComponentUploadProgress } from '../component-upload.js';
import type { IslandManager } from '../islands.js';
import { COMPONENT_ATTRIBUTE } from '../../server-components/protocol.js';
import type { ComponentDocument, ComponentElement } from './dom-contract.js';
import { ComponentBindingError } from './dom-contract.js';
import { createDelegatedEvents } from './dom-events.js';
import type { IntersectionObserverFactory } from './intersections.js';
import { browserPollSignals, type PollSignals } from '../polling.js';
import { createTriggerQueue, type TriggerQueue } from '../trigger-queue.js';
import {
  COMPONENT_BLOCKED_MESSAGE,
  createRootBinding,
  dispatchAction,
  disposeRootBinding,
  findRef,
  ROOT_SELECTOR,
  rootFor,
  type ComponentMorph,
  type RootBinding,
  type RootBindingHost,
} from './root-binding.js';
import { formatError } from '../../errors/inspect.js';

export { COMPONENT_BLOCKED_MESSAGE };

/** Options for {@link createComponentBindings}. */
export interface ComponentBindingsOptions {
  readonly document: ComponentDocument;
  /** Morphs server HTML into the root by element id. */
  readonly morph: ComponentMorph;
  /** Shared island manager, used to tear down/remount nested islands. */
  readonly islands?: IslandManager;
  /** Trusted http(s) origin bound into each controller. */
  readonly origin: string;
  /** Fetch implementation forwarded to each controller. */
  readonly fetch?: ComponentControllerOptions['fetch'];
  /** XHR factory forwarded to each controller for file uploads. */
  readonly uploadRequest?: ComponentControllerOptions['uploadRequest'];
  /** Receives upload progress for a bound file input. */
  readonly onUploadProgress?: (
    field: string,
    input: ComponentElement,
    progress: ComponentUploadProgress,
  ) => void;
  /** Visibility/connectivity signals driving poll pause/resume. */
  readonly pollSignals?: PollSignals;
  /**
   * The eager trigger queue installed before the bindings existed. The
   * manager opens it on mount and holds it on dispose, but never disposes it:
   * its owner does. Omitted, the manager installs and owns its own.
   */
  readonly triggers?: TriggerQueue;
  /** Called instead of `console.warn` for non-fatal binding failures. */
  readonly onError?: (error: unknown, element: ComponentElement) => void;
  /**
   * Navigation callback invoked when a server-component action signals a
   * client-side redirect. When absent the binding layer falls back to
   * `globalThis.location.assign`. Prefer wiring this to Turbo's `visit()` so
   * redirects preserve the soft-navigation session rather than performing a
   * full page load.
   */
  readonly navigate?: (url: string) => void;
  /**
   * Confirmation prompt called before dispatching an action. Returns `true`
   * to proceed or `false` to cancel. Defaults to `globalThis.window.confirm`,
   * falling back to `true` (allow) when unavailable (Node/test). Advisory
   * UI only, never a security boundary.
   */
  readonly confirm?: (message: string) => boolean;
  /**
   * Injectable `IntersectionObserver` factory. Defaults to the browser global;
   * when neither exists (Node/test without injection) the intersect directive
   * is a no-op.
   */
  readonly createIntersectionObserver?: IntersectionObserverFactory<ComponentElement>;
}

/** The binding manager handle. */
export interface ComponentBindings {
  /** Bootstrap a controller for every unbound root in the document. */
  mountAll(): void;
  /** Bootstrap a controller for `root` (if it is a root) and every root inside. */
  mountWithin(root: ComponentElement): void;
  /** Dispose every controller and remove delegated listeners. Idempotent. */
  disposeAll(): void;
  /** Dispose controllers whose root element is no longer connected. */
  collectRemoved(): void;
  /** Number of live bindings. */
  readonly size: number;
  /**
   * Return the element whose `data-jsails-ref` equals `name` within `root`,
   * or `null` when no match exists. Pure, non-throwing lookup aid, never a
   * global id lookup.
   */
  findRef(root: ComponentElement, name: string): ComponentElement | null;
}

/** Create the DOM binding manager over a document and morph function. */
export function createComponentBindings(options: ComponentBindingsOptions): ComponentBindings {
  const { document: doc, morph, origin, pollSignals, onError } = options;
  if (typeof morph !== 'function') {
    throw new ComponentBindingError('morph must be a function');
  }
  if (typeof origin !== 'string' || origin === '') {
    throw new ComponentBindingError('origin must be a non-empty string');
  }
  if (pollSignals !== undefined && typeof pollSignals.onChange !== 'function') {
    throw new ComponentBindingError('pollSignals.onChange must be a function');
  }

  const bindings = new Map<ComponentElement, RootBinding>();

  function report(error: unknown, element: ComponentElement): void {
    if (onError !== undefined) {
      onError(error, element);
      return;
    }
    const message = formatError(error);
    console.warn(`jsails: component binding failed: ${message}`);
  }

  const host: RootBindingHost = {
    document: doc,
    morph,
    islands: options.islands,
    origin,
    fetch: options.fetch,
    uploadRequest: options.uploadRequest,
    onUploadProgress: options.onUploadProgress,
    navigate: options.navigate,
    createIntersectionObserver: options.createIntersectionObserver,
    pollSignals: pollSignals ?? browserPollSignals(),
    report,
    // Re-key the element-keyed map so delegated events that resolve the
    // replacement root find this same binding.
    retarget: (binding, previous) => {
      bindings.delete(previous);
      bindings.set(binding.element, binding);
    },
    bindingOf: (element) => {
      const binding = bindings.get(element);
      return binding === undefined || binding.disposed ? undefined : binding;
    },
    syncNested: (root) => {
      syncNested(root);
    },
  };

  /** The live binding owning `element`, or `undefined` when out of scope or disposed. */
  function bindingFor(element: ComponentElement | null): RootBinding | undefined {
    const root = rootFor(element);
    if (root === null) {
      return undefined;
    }
    const binding = bindings.get(root);
    return binding === undefined || binding.disposed ? undefined : binding;
  }

  const events = createDelegatedEvents({
    document: doc,
    bindingFor,
    dispatch: (binding, trigger, action, args) =>
      dispatchAction(host, binding, trigger, action, args),
    report,
    confirm: options.confirm,
  });

  function bindElement(element: ComponentElement): void {
    if (bindings.has(element)) {
      return;
    }
    if (element.getAttribute(COMPONENT_ATTRIBUTE) === null) {
      return;
    }
    const binding = createRootBinding(host, element);
    if (binding !== null) {
      bindings.set(element, binding);
    }
  }

  function disposeBinding(binding: RootBinding): void {
    if (binding.disposed) {
      return;
    }
    disposeRootBinding(binding);
    bindings.delete(binding.element);
  }

  function collectRemoved(): void {
    for (const binding of Array.from(bindings.values())) {
      if (!binding.element.isConnected) {
        disposeBinding(binding);
      }
    }
  }

  /**
   * Reconcile the nested roots of a root a morph just rewrote. A kept child is
   * the very element the morph left alone, so its binding (and its client
   * state) carries on untouched. A child the morph swapped for another
   * instance in place (another id) is rebound from its new markers, and a new
   * child is bound.
   */
  function syncNested(root: ComponentElement): void {
    collectRemoved();
    for (const element of Array.from(root.querySelectorAll(ROOT_SELECTOR))) {
      const existing = bindings.get(element);
      if (existing === undefined || existing.disposed) {
        bindElement(element);
        continue;
      }
      if (element.id !== existing.instanceId) {
        disposeBinding(existing);
        bindElement(element);
      }
    }
  }

  // An injected queue belongs to the runtime; one the manager installs is its own.
  let ownTriggers: TriggerQueue | null = null;
  /** Attach the listeners and bind `roots`, then open the queue so held triggers find them. */
  function mount(roots: readonly ComponentElement[]): void {
    events.attach();
    for (const element of roots) {
      bindElement(element);
    }
    const triggers = options.triggers ?? (ownTriggers ??= createTriggerQueue(doc));
    triggers.open(events.run);
  }

  return {
    mountAll() {
      mount(Array.from(doc.querySelectorAll(ROOT_SELECTOR)) as ComponentElement[]);
    },
    mountWithin(root) {
      mount([root, ...Array.from(root.querySelectorAll(ROOT_SELECTOR))]);
    },
    disposeAll() {
      events.detach();
      options.triggers?.hold();
      ownTriggers?.dispose();
      ownTriggers = null;
      for (const binding of Array.from(bindings.values())) {
        disposeBinding(binding);
      }
    },
    collectRemoved,
    get size() {
      return bindings.size;
    },
    findRef,
  };
}
