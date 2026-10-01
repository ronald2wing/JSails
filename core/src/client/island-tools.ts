/**
 * Island tool runtime: the client-side mirror of the server-component
 * directive controller, for pure Preact client islands.
 *
 * A server component renders `data-jsails-*` markers and the binding layer
 * dispatches them against a signed snapshot. A client island has no snapshot,
 * so it supplies its own handler map and this hook wires the same markers to
 * it. The semantics deliberately mirror `bindings/controller.ts`:
 *
 * - `[data-jsails-call]` / `[data-jsails-submit]` dispatch the named handler
 *   with parsed `data-jsails-args`, honouring `.once` and `.confirm`.
 * - `[data-jsails-sort]` falls back to the reserved `sort` action with
 *   `{ field }` when no call marker is present.
 * - `[data-jsails-intersect]` fires the named handler once when the element
 *   enters the viewport, then unobserves it. The effect re-runs after every
 *   render, which re-arms the observer for newly rendered markup.
 * - `[data-jsails-model]` controls write through `onInput`, with an optional
 *   per-field debounce and a focusout flush.
 * - `[data-jsails-show]` / `[data-jsails-text]` are re-applied from the
 *   supplied state snapshot on every effect run.
 * - `[data-jsails-loading-target]` and the root loading marker track in-flight
 *   handler invocations.
 * - `[data-jsails-poll]` drives a recursive `$refresh` loop that pauses while
 *   the tab is hidden or the network is offline.
 *
 * Unknown handler names are reported through `console.warn` with the server
 * runtime's `Unknown action` message rather than silently ignored; unrelated
 * markup (no marker) is a no-op. The module is browser-safe and Node-import
 * safe: it imports Preact hooks only and resolves DOM globals lazily, so
 * importing it in Node never throws.
 */

import { useEffect, useRef } from 'preact/hooks';
import type { Ref } from 'preact';

import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MAX_DEBOUNCE_MS,
  MAX_POLL_MARKER_LENGTH,
  MIN_POLL_INTERVAL_MS,
  MODEL_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  REFRESH_ACTION,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
  type ComponentPollOptions,
} from '../server-components/protocol.js';
import { ISLAND_ATTRIBUTE } from './islands.js';
import { parseActionArgs } from './action-attrs.js';

/** The native-control members the bind directive reads. */
type ControlElement = HTMLElement & {
  value?: string;
  checked?: boolean;
  type?: string;
  multiple?: boolean;
  selectedOptions?: ArrayLike<{ readonly value: string }>;
};

/** Query a root's descendants as elements (the DOM returns `Element`). */
function queryAll(root: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector), (element) => element as HTMLElement);
}

/** True when an element is a native `input[type=file]` control. */
function isFileInput(element: HTMLElement): boolean {
  return (
    element.tagName.toLowerCase() === 'input' &&
    ((element as ControlElement).type ?? '').toLowerCase() === 'file'
  );
}

/**
 * Read a native control's value: a checkbox/radio yields its `checked`
 * boolean, a multi-select yields an array of selected values, a numeric input
 * yields a number when finite, and everything else yields its string value.
 * Mirrors `bindings/control-values.ts` without importing its structural DOM
 * contract.
 */
function readControlValue(element: HTMLElement): unknown {
  const control = element as ControlElement;
  const type = (control.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return control.checked === true;
  }
  if (element.tagName.toLowerCase() === 'select' && control.multiple === true) {
    const selected = control.selectedOptions;
    return selected === undefined ? [] : Array.from(selected, (option) => option.value);
  }
  const raw = control.value ?? '';
  if (type === 'number' || type === 'range') {
    if (raw.trim() === '') {
      return '';
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/** Handler map an island passes to {@link useIslandTools}. */
export interface IslandActionHandlers {
  [action: string]: (args: Record<string, unknown>) => void | Promise<void>;
}

/** Options for {@link useIslandTools}. */
export interface IslandToolOptions {
  /** Action handlers keyed by the marker's action name. */
  handlers: IslandActionHandlers;
  /** State snapshot used by the `show`/`text` directives and display values. */
  state?: Record<string, unknown>;
  /** Receives bound-control writes (`data-jsails-model`). */
  onInput?: (name: string, value: unknown) => void;
  /** Confirmation prompt; defaults to `window.confirm`. */
  confirm?: (message: string) => boolean;
}

/** Handle returned by {@link useIslandTools}. */
export interface IslandTools {
  /** Ref to attach to the island's root element. */
  ref: Ref<HTMLElement>;
  /** Return the element whose `data-jsails-ref` equals `name`, or `null`. */
  findRef: (name: string) => HTMLElement | null;
}

/** A pending debounced field write. */
interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  value: unknown;
}

/**
 * Wire the server-component directive markers inside an island to a handler
 * map.
 *
 * Returns the ref to attach to the island's root element plus a scoped
 * `findRef` lookup. The effect has no dependency array on purpose: it re-runs
 * after every render so a newly appended intersect sentinel is observed, a
 * replaced root is re-bound, and state directives are re-applied.
 */
export function useIslandTools<E extends HTMLElement = HTMLElement>(
  options: IslandToolOptions,
): IslandTools & { ref: Ref<E> } {
  const ref = useRef<E | null>(null);
  // `.once` consumption must survive the effect's per-render teardown, so the
  // WeakSet lives on the hook rather than inside the attachment.
  const consumedOnce = useRef(new WeakSet<HTMLElement>());

  useEffect(() => {
    const root = ref.current;
    if (root === null) {
      return;
    }
    return attachIslandTools(root, options, consumedOnce.current);
  });

  const findRef = (name: string): HTMLElement | null => {
    const root = ref.current;
    return root === null ? null : findRefIn(root, name);
  };

  return { ref, findRef };
}

/**
 * Return the element whose `data-jsails-ref` equals `name` within `root`, or
 * `null` when no match exists. Iterates descendants directly rather than using
 * a CSS attribute-value selector so minimal test doubles work too.
 */
export function findRefIn(root: HTMLElement, name: string): HTMLElement | null {
  if (name === '') {
    return null;
  }
  for (const element of queryAll(root, `[${REF_ATTRIBUTE}]`)) {
    if (element.getAttribute(REF_ATTRIBUTE) === name) {
      return element;
    }
  }
  return null;
}

/**
 * Attach the delegated listeners, observers, and poll loops for `root`.
 *
 * Exported for the DOM-behaviour tests; not part of the `jsails/client` public
 * surface. Returns an idempotent teardown that removes every listener and
 * stops every observer/timer.
 */
export function attachIslandTools(
  root: HTMLElement,
  options: IslandToolOptions,
  consumedOnce: WeakSet<HTMLElement> = new WeakSet(),
): () => void {
  const { handlers, state, onInput } = options;
  let disposed = false;
  let inflight = 0;
  const debounce = new Map<string, PendingWrite>();

  const report = (message: string): void => {
    console.warn(`jsails: component binding failed: ${message}`);
  };

  /**
   * Resolve the island root that owns `target`, or `null` when the target is
   * outside the subtree or inside a nested island (which owns its own tools).
   */
  const rootFor = (target: HTMLElement | null): HTMLElement | null => {
    if (target === null || !root.contains(target)) {
      return null;
    }
    const island = target.closest<HTMLElement>(`[${ISLAND_ATTRIBUTE}]`);
    if (island !== null && island !== root && root.contains(island)) {
      return null;
    }
    return root;
  };

  const confirmDialog = (message: string): boolean => {
    if (options.confirm !== undefined) {
      return options.confirm(message);
    }
    const g = globalThis as { window?: { confirm?(message: string): boolean } };
    return g.window?.confirm?.(message) ?? true;
  };

  const applyDirectives = (): void => {
    for (const element of queryAll(root, `[${SHOW_ATTRIBUTE}]`)) {
      const field = element.getAttribute(SHOW_ATTRIBUTE);
      if (field === null || field === '') {
        continue;
      }
      element.hidden = !state?.[field];
    }
    for (const element of queryAll(root, `[${TEXT_ATTRIBUTE}]`)) {
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
  };

  const syncMarkers = (): void => {
    if (disposed) {
      return;
    }
    if (inflight > 0) {
      root.setAttribute(LOADING_ATTRIBUTE, 'true');
    } else {
      root.removeAttribute(LOADING_ATTRIBUTE);
    }
    const doc = (globalThis as { document?: { querySelector(selector: string): Element | null } })
      .document;
    for (const element of queryAll(root, `[${LOADING_TARGET_ATTRIBUTE}]`)) {
      const selector = element.getAttribute(LOADING_TARGET_ATTRIBUTE);
      if (selector === null || selector === '' || doc === undefined) {
        continue;
      }
      try {
        const target = doc.querySelector(selector) as HTMLElement | null;
        if (target === null) {
          continue;
        }
        if (inflight > 0) {
          target.setAttribute(LOADING_ATTRIBUTE, 'true');
        } else {
          target.removeAttribute(LOADING_ATTRIBUTE);
        }
      } catch {
        // A malformed CSS selector must not break the island.
      }
    }
    applyDirectives();
  };

  const invoke = (name: string, args: Record<string, unknown>): Promise<void> => {
    const handler = handlers[name];
    if (handler === undefined) {
      report('Unknown action');
      return Promise.resolve();
    }
    inflight += 1;
    syncMarkers();
    const done = (): void => {
      inflight -= 1;
      syncMarkers();
    };
    try {
      const result = handler(args);
      if (result === undefined) {
        done();
        return Promise.resolve();
      }
      return Promise.resolve(result).then(done, (error: unknown) => {
        report(error instanceof Error ? error.message : String(error));
        done();
      });
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
      done();
      return Promise.resolve();
    }
  };

  const debounceMsFor = (control: HTMLElement): number | null => {
    const raw = control.getAttribute(DEBOUNCE_ATTRIBUTE);
    if (raw === null || raw === '') {
      return null;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DEBOUNCE_MS) {
      return null;
    }
    return parsed;
  };

  const scheduleDebounce = (name: string, value: unknown, ms: number): void => {
    const existing = debounce.get(name);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      const entry = debounce.get(name);
      if (entry === undefined || entry.timer !== timer) {
        return;
      }
      debounce.delete(name);
      if (disposed) {
        return;
      }
      onInput?.(name, entry.value);
    }, ms);
    debounce.set(name, { timer, value });
  };

  const flushDebounce = (name: string): void => {
    const entry = debounce.get(name);
    if (entry === undefined) {
      return;
    }
    clearTimeout(entry.timer);
    debounce.delete(name);
    if (disposed) {
      return;
    }
    onInput?.(name, entry.value);
  };

  const cancelAllDebounce = (): void => {
    for (const entry of debounce.values()) {
      clearTimeout(entry.timer);
    }
    debounce.clear();
  };

  const captureBoundValues = (): void => {
    for (const control of queryAll(root, `[${MODEL_ATTRIBUTE}]`)) {
      if (rootFor(control) !== root) {
        continue;
      }
      if (isFileInput(control)) {
        continue;
      }
      const name = control.getAttribute(MODEL_ATTRIBUTE);
      if (name === null || name === '') {
        continue;
      }
      onInput?.(name, readControlValue(control));
    }
  };

  const onInputOrChange = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target === null || rootFor(target) !== root) {
      return;
    }
    const name = target.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }
    if (isFileInput(target)) {
      return;
    }
    const value = readControlValue(target);
    const ms = debounceMsFor(target);
    if (ms !== null) {
      scheduleDebounce(name, value, ms);
    } else {
      onInput?.(name, value);
    }
  };

  const onFocusOut = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target === null || rootFor(target) !== root) {
      return;
    }
    const name = target.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }
    if (debounceMsFor(target) === null) {
      return;
    }
    flushDebounce(name);
  };

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target === null || typeof target.closest !== 'function') {
      return;
    }

    const callTrigger = target.closest<HTMLElement>(`[${CALL_ATTRIBUTE}]`);
    if (callTrigger !== null) {
      if (rootFor(callTrigger) !== root) {
        return;
      }
      const action = callTrigger.getAttribute(CALL_ATTRIBUTE);
      if (action === null || action === '') {
        return;
      }
      if (callTrigger.hasAttribute(ONCE_ATTRIBUTE) && consumedOnce.has(callTrigger)) {
        return;
      }
      const args = parseActionArgs(callTrigger.getAttribute(ARGS_ATTRIBUTE));
      if (args === null) {
        report('invalid action arguments');
        return;
      }
      const confirmMessage = callTrigger.getAttribute(CONFIRM_ATTRIBUTE);
      if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
        return;
      }
      event.preventDefault();
      if (callTrigger.hasAttribute(ONCE_ATTRIBUTE)) {
        consumedOnce.add(callTrigger);
      }
      captureBoundValues();
      cancelAllDebounce();
      void invoke(action, args);
      return;
    }

    const sortTrigger = target.closest<HTMLElement>(`[${SORT_ATTRIBUTE}]`);
    if (sortTrigger === null || rootFor(sortTrigger) !== root) {
      return;
    }
    const field = sortTrigger.getAttribute(SORT_ATTRIBUTE);
    if (field === null || field === '') {
      return;
    }
    event.preventDefault();
    captureBoundValues();
    cancelAllDebounce();
    void invoke('sort', { field });
  };

  const onSubmit = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (target === null || typeof target.closest !== 'function') {
      return;
    }
    const form = target.closest<HTMLElement>(`[${SUBMIT_ATTRIBUTE}]`);
    if (form === null || rootFor(form) !== root) {
      return;
    }
    const action = form.getAttribute(SUBMIT_ATTRIBUTE);
    if (action === null || action === '') {
      return;
    }
    if (form.hasAttribute(ONCE_ATTRIBUTE) && consumedOnce.has(form)) {
      return;
    }
    const args = parseActionArgs(form.getAttribute(ARGS_ATTRIBUTE));
    if (args === null) {
      report('invalid action arguments');
      return;
    }
    const confirmMessage = form.getAttribute(CONFIRM_ATTRIBUTE);
    if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
      return;
    }
    event.preventDefault();
    if (form.hasAttribute(ONCE_ATTRIBUTE)) {
      consumedOnce.add(form);
    }
    captureBoundValues();
    cancelAllDebounce();
    void invoke(action, args);
  };

  const observeIntersections = (): IntersectionObserver | null => {
    const elements = queryAll(root, `[${INTERSECT_ATTRIBUTE}]`);
    if (elements.length === 0) {
      return null;
    }
    const g = globalThis as {
      IntersectionObserver?: new (
        callback: (entries: IntersectionObserverEntry[]) => void,
      ) => IntersectionObserver;
    };
    const Observer = g.IntersectionObserver;
    if (Observer === undefined) {
      return null;
    }
    const observer = new Observer((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const element = entry.target as HTMLElement;
        const action = element.getAttribute(INTERSECT_ATTRIBUTE);
        if (action === null || action === '') {
          continue;
        }
        try {
          void invoke(action, {});
        } finally {
          // Fire-once: unobserve after dispatch so a scroll-off/scroll-back
          // within this render never re-dispatches. The effect re-runs after
          // every render, which re-arms the observer for new markup.
          observer.unobserve(element);
        }
      }
    });
    for (const element of elements) {
      observer.observe(element);
    }
    return observer;
  };

  const parsePollOptions = (element: HTMLElement): ComponentPollOptions | null => {
    const raw = element.getAttribute(POLL_ATTRIBUTE);
    if (raw === null || raw === '' || raw.length > MAX_POLL_MARKER_LENGTH) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const intervalMs = record.intervalMs;
    if (
      typeof intervalMs !== 'number' ||
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < MIN_POLL_INTERVAL_MS
    ) {
      return null;
    }
    return {
      intervalMs,
      pauseWhenHidden: record.pauseWhenHidden === true,
      pauseWhenOffline: record.pauseWhenOffline === true,
    };
  };

  const documentHidden = (): boolean => {
    const doc = (globalThis as { document?: { hidden?: boolean } }).document;
    return doc?.hidden === true;
  };

  const navigatorOnline = (): boolean => {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return nav?.onLine !== false;
  };

  const subscribePollSignals = (listener: () => void): (() => void) => {
    const g = globalThis as {
      document?: {
        addEventListener(type: string, listener: () => void): void;
        removeEventListener(type: string, listener: () => void): void;
      };
      addEventListener?(type: string, listener: () => void): void;
      removeEventListener?(type: string, listener: () => void): void;
    };
    g.document?.addEventListener('visibilitychange', listener);
    g.addEventListener?.('online', listener);
    g.addEventListener?.('offline', listener);
    return () => {
      g.document?.removeEventListener('visibilitychange', listener);
      g.removeEventListener?.('online', listener);
      g.removeEventListener?.('offline', listener);
    };
  };

  const startPolling = (pollOptions: ComponentPollOptions): (() => void) => {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isPaused = (): boolean =>
      (pollOptions.pauseWhenHidden === true && documentHidden()) ||
      (pollOptions.pauseWhenOffline === true && !navigatorOnline());

    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const ensureScheduled = (): void => {
      if (stopped || isPaused() || running || timer !== null) {
        return;
      }
      timer = setTimeout(() => {
        void tick();
      }, pollOptions.intervalMs);
    };

    const tick = async (): Promise<void> => {
      timer = null;
      running = true;
      try {
        if (stopped || isPaused()) {
          return;
        }
        if (handlers[REFRESH_ACTION] !== undefined) {
          await invoke(REFRESH_ACTION, {});
        }
      } finally {
        running = false;
      }
      ensureScheduled();
    };

    const unsubscribe = subscribePollSignals(() => {
      if (stopped) {
        return;
      }
      if (isPaused()) {
        clearTimer();
        return;
      }
      ensureScheduled();
    });

    ensureScheduled();

    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimer();
      unsubscribe();
    };
  };

  const startPolls = (): Array<() => void> => {
    const stops: Array<() => void> = [];
    for (const element of queryAll(root, `[${POLL_ATTRIBUTE}]`)) {
      const pollOptions = parsePollOptions(element);
      if (pollOptions !== null) {
        stops.push(startPolling(pollOptions));
      }
    }
    return stops;
  };

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInputOrChange);
  root.addEventListener('change', onInputOrChange);
  root.addEventListener('focusout', onFocusOut);

  const observer = observeIntersections();
  const pollStops = startPolls();
  syncMarkers();

  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    root.removeEventListener('click', onClick);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('input', onInputOrChange);
    root.removeEventListener('change', onInputOrChange);
    root.removeEventListener('focusout', onFocusOut);
    observer?.disconnect();
    for (const stop of pollStops) {
      stop();
    }
    cancelAllDebounce();
  };
}
