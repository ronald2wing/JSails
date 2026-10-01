/**
 * Server-component directives for pure Preact client islands.
 *
 * A server component renders `data-jsails-*` markers and the DOM binding layer
 * dispatches them against a signed snapshot. A client island has no snapshot,
 * so it supplies its own handler map and {@link useIslandDirectives} wires the
 * same markers to it, with the semantics of `bindings/dom-bindings.ts`:
 *
 * - `[data-jsails-call]` / `[data-jsails-submit]` dispatch the named handler
 *   with parsed `data-jsails-args`, honoring `.once` and `.confirm`.
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
 * markup (no marker) is a no-op. DOM globals are resolved lazily, so importing
 * this module in Node never throws.
 */

import { useEffect, useRef } from 'preact/hooks';
import type { Ref } from 'preact';

import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  REFRESH_ACTION,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../server-components/protocol.js';
import { parseActionArgs } from './action-attrs.js';
import { isFileInput, readControlValue } from './bindings/control-values.js';
import { debounceMsFor } from './bindings/debounce.js';
import { applyStateDirectives } from './bindings/directives.js';
import { observeIntersections } from './bindings/intersections.js';
import {
  browserPollSignals,
  parsePollMarker,
  startPolling,
  type PollHandle,
} from './bindings/polling.js';
import { ISLAND_ATTRIBUTE } from './islands.js';
import { formatError } from '../errors/inspect.js';
import type { Awaitable } from '../contracts/awaitable.js';

/** Query a root's descendants as elements (the DOM returns `Element`). */
function queryAll(root: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector), (element) => element as HTMLElement);
}

/** Handler map an island passes to {@link useIslandDirectives}. */
export interface IslandActionHandlers {
  readonly [action: string]: (args: Record<string, unknown>) => Awaitable<void>;
}

/** Options for {@link useIslandDirectives}. */
export interface IslandDirectiveOptions {
  /** Action handlers keyed by the marker's action name. */
  readonly handlers: IslandActionHandlers;
  /** State snapshot used by the `show`/`text` directives and display values. */
  readonly state?: Record<string, unknown>;
  /** Receives bound-control writes (`data-jsails-model`). */
  readonly onInput?: (name: string, value: unknown) => void;
  /** Confirmation prompt; defaults to `window.confirm`. */
  readonly confirm?: (message: string) => boolean;
}

/** Handle returned by {@link useIslandDirectives}. */
export interface IslandDirectives {
  /** Ref to attach to the island's root element. */
  readonly ref: Ref<HTMLElement>;
  /** Return the element whose `data-jsails-ref` equals `name`, or `null`. */
  readonly findRef: (name: string) => HTMLElement | null;
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
export function useIslandDirectives<E extends HTMLElement = HTMLElement>(
  options: IslandDirectiveOptions,
): IslandDirectives & { ref: Ref<E> } {
  const ref = useRef<E | null>(null);
  // `.once` consumption must survive the effect's per-render teardown, so the
  // WeakSet lives on the hook rather than inside the attachment.
  const consumedOnce = useRef(new WeakSet<HTMLElement>());

  useEffect(() => {
    const root = ref.current;
    if (root === null) {
      return;
    }
    return attachIslandDirectives(root, options, consumedOnce.current);
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
 * Exported for the DOM-behavior tests; not part of the `jsails/client` public
 * surface. Returns an idempotent teardown that removes every listener and
 * stops every observer/timer.
 */
export function attachIslandDirectives(
  root: HTMLElement,
  options: IslandDirectiveOptions,
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
   * outside the subtree or inside a nested island (which owns its own markers).
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
    applyStateDirectives(root, state);
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
        report(formatError(error));
        done();
      });
    } catch (error) {
      report(formatError(error));
      done();
      return Promise.resolve();
    }
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

  /** Capture bound values and drop pending debounces, then run the handler. */
  const dispatch = (action: string, args: Record<string, unknown>): void => {
    captureBoundValues();
    cancelAllDebounce();
    void invoke(action, args);
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
      dispatch(action, args);
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
    dispatch('sort', { field });
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
    dispatch(action, args);
  };

  const startPolls = (): PollHandle[] => {
    const signals = browserPollSignals();
    const polls: PollHandle[] = [];
    for (const element of queryAll(root, `[${POLL_ATTRIBUTE}]`)) {
      const pollOptions = parsePollMarker(element.getAttribute(POLL_ATTRIBUTE));
      if (pollOptions === null) {
        continue;
      }
      polls.push(
        startPolling({
          options: pollOptions,
          signals,
          isActive: () => true,
          refresh: () =>
            handlers[REFRESH_ACTION] === undefined ? Promise.resolve() : invoke(REFRESH_ACTION, {}),
        }),
      );
    }
    return polls;
  };

  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInputOrChange);
  root.addEventListener('change', onInputOrChange);
  root.addEventListener('focusout', onFocusOut);

  const observer = observeIntersections(queryAll(root, `[${INTERSECT_ATTRIBUTE}]`), (_, action) => {
    void invoke(action, {});
  });
  const polls = startPolls();
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
    for (const poll of polls) {
      poll.stop();
    }
    cancelAllDebounce();
  };
}
