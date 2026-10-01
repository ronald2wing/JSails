/**
 * Document-level delegated event handlers for bound component roots.
 *
 * `input`/`change` write native control values into the owning controller's
 * working state via `setField`; `focusout` flushes a debounced control;
 * `click[data-jsails-call]`, `click[data-jsails-sort]`, and
 * `submit[data-jsails-submit]` collect the latest bound field values and the
 * element's explicit JSON args, then dispatch exactly one action. Field values
 * are never folded into action args.
 *
 * Modifier markers are served by extra listeners: a `.capture` trigger is
 * handled in the capture phase, a `.passive` control by a passive listener,
 * and the bubble-phase handlers skip both so an event is handled exactly once.
 * `.once` consumption is tracked in a WeakSet rather than a DOM mutation, so
 * the server-owned markup is never altered and consumed elements are
 * garbage-collected with their subtree.
 */

import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CAPTURE_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  PASSIVE_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../../server-components/protocol.js';
import { parseActionArgs } from '../action-attrs.js';
import type { JsailsEvent } from '../islands.js';
import { isFileInput, readControlValue } from './control-values.js';
import { debounceMsFor, flushDebounce, scheduleDebounce } from './debounce.js';
import { syncMarkers } from './directives.js';
import {
  ComponentBindingError,
  type ComponentDocument,
  type ComponentElement,
} from './dom-contract.js';
import type { ActionArgs, RootBinding } from './root-binding.js';
import { rootFor } from './root-binding.js';
import { applyFieldValidation, validateAll } from './rules.js';
import { handleFileChange } from './uploads.js';

/** What the delegated handlers need from the binding manager. */
export interface DelegatedEventsOptions {
  readonly document: ComponentDocument;
  /** The live binding owning an element, or `undefined` when out of scope. */
  readonly bindingFor: (element: ComponentElement | null) => RootBinding | undefined;
  /** Dispatch one action against a binding. */
  readonly dispatch: (
    binding: RootBinding,
    trigger: ComponentElement,
    action: string,
    args: ActionArgs,
  ) => void;
  /** Report a non-fatal binding failure. */
  readonly report: (error: unknown, element: ComponentElement) => void;
  /**
   * Confirmation prompt called before dispatching an action. Defaults to
   * `globalThis.window.confirm`, falling back to `true` (allow) when
   * unavailable (Node/test). Advisory UI only, never a security boundary.
   */
  readonly confirm: ((message: string) => boolean) | undefined;
}

/** The delegated listener set; `attach` and `detach` are idempotent. */
export interface DelegatedEvents {
  attach(): void;
  detach(): void;
}

/** Create the delegated listeners over `document`. */
export function createDelegatedEvents(options: DelegatedEventsOptions): DelegatedEvents {
  const { document: doc, bindingFor, dispatch, report, confirm } = options;
  let attached = false;
  const consumedOnce = new WeakSet<ComponentElement>();

  function confirmDialog(message: string): boolean {
    if (confirm !== undefined) {
      return confirm(message);
    }
    const g = globalThis as { window?: { confirm(message: string): boolean } };
    return g.window?.confirm?.(message) ?? true;
  }

  function onInputOrChange(event: JsailsEvent, fromPassive = false): void {
    const target = event.target as ComponentElement | null;
    // A `.passive` control is handled by the passive-phase listener; the
    // bubble listener skips it so the edit is captured exactly once.
    if (!fromPassive && target !== null && target.hasAttribute(PASSIVE_ATTRIBUTE)) {
      return;
    }
    const binding = bindingFor(target);
    if (binding === undefined || target === null) {
      return;
    }
    const name = target.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }

    // A file control's value is never serializable state: a `change` with a
    // selected file starts an upload, and an `input` event on one carries
    // nothing to capture.
    if (isFileInput(target)) {
      if (event.type === 'change') {
        handleFileChange(binding, target, name, doc, report);
      }
      return;
    }

    try {
      const value = readControlValue(target);
      binding.controller.setField(name, value);
      const debounceMs = debounceMsFor(target);
      if (debounceMs !== null) {
        scheduleDebounce(binding, name, debounceMs);
      }
      syncMarkers(binding, rootFor);
      applyFieldValidation(binding, target, name, value);
    } catch (error) {
      report(error, target);
    }
  }

  function onFocusOut(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    const binding = bindingFor(target);
    if (binding === undefined || target === null) {
      return;
    }
    const name = target.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      return;
    }
    // Only a debounced control flushes its pending edit on blur.
    if (debounceMsFor(target) === null) {
      return;
    }
    flushDebounce(binding, name);
  }

  function onCallClick(event: JsailsEvent, fromCapture = false): void {
    const target = event.target as ComponentElement | null;
    if (target === null) {
      return;
    }

    // An explicit call marker on the element (or an ancestor) wins over a
    // sort marker on the same element.
    const callTrigger = target.closest(`[${CALL_ATTRIBUTE}]`);
    if (callTrigger !== null) {
      // A `.capture` trigger is handled by the capture-phase listener; the
      // bubble listener skips it so the action dispatches exactly once.
      if (!fromCapture && callTrigger.hasAttribute(CAPTURE_ATTRIBUTE)) {
        return;
      }
      const binding = bindingFor(callTrigger);
      if (binding === undefined) {
        return;
      }
      const action = callTrigger.getAttribute(CALL_ATTRIBUTE);
      if (action === null || action === '') {
        return;
      }
      // `.once`: a trigger that already dispatched is inert. Checked before the
      // confirm guard so a consumed trigger never re-prompts.
      if (callTrigger.hasAttribute(ONCE_ATTRIBUTE) && consumedOnce.has(callTrigger)) {
        return;
      }
      const args = parseActionArgs(callTrigger.getAttribute(ARGS_ATTRIBUTE));
      if (args === null) {
        report(new ComponentBindingError('invalid action arguments'), callTrigger);
        return;
      }
      const confirmMessage = callTrigger.getAttribute(CONFIRM_ATTRIBUTE);
      if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
        return;
      }
      // Only a bound action suppresses the native/Turbo default.
      event.preventDefault();
      if (callTrigger.hasAttribute(ONCE_ATTRIBUTE)) {
        consumedOnce.add(callTrigger);
      }
      dispatch(binding, callTrigger, action, args);
      return;
    }

    // A sort trigger dispatches a `sort` action with the named field.
    const sortTrigger = target.closest(`[${SORT_ATTRIBUTE}]`);
    if (sortTrigger === null) {
      return;
    }
    const binding = bindingFor(sortTrigger);
    if (binding === undefined) {
      return;
    }
    const field = sortTrigger.getAttribute(SORT_ATTRIBUTE);
    if (field === null || field === '') {
      return;
    }
    event.preventDefault();
    dispatch(binding, sortTrigger, 'sort', { field });
  }

  function onSubmit(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    if (target === null) {
      return;
    }
    const form = target.closest(`[${SUBMIT_ATTRIBUTE}]`);
    if (form === null) {
      return;
    }
    const binding = bindingFor(form);
    if (binding === undefined) {
      return;
    }
    const action = form.getAttribute(SUBMIT_ATTRIBUTE);
    if (action === null || action === '') {
      return;
    }
    // `.once`: a form that already dispatched is inert.
    if (form.hasAttribute(ONCE_ATTRIBUTE) && consumedOnce.has(form)) {
      return;
    }
    const args = parseActionArgs(form.getAttribute(ARGS_ATTRIBUTE));
    if (args === null) {
      report(new ComponentBindingError('invalid action arguments'), form);
      return;
    }
    // The confirmation is read from the form element before client-side
    // validation runs.
    const confirmMessage = form.getAttribute(CONFIRM_ATTRIBUTE);
    if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
      return;
    }
    // Client-side validation gate: when any bound field fails its rules, block
    // the submit and move focus to the first invalid control. The action is
    // never dispatched; the server's own validation is not consulted.
    const firstInvalid = validateAll(binding, rootFor);
    if (firstInvalid !== null) {
      event.preventDefault();
      firstInvalid.focus?.();
      return;
    }
    // Only a bound submit suppresses the native/Turbo default.
    event.preventDefault();
    if (form.hasAttribute(ONCE_ATTRIBUTE)) {
      consumedOnce.add(form);
    }
    dispatch(binding, form, action, args);
  }

  /**
   * Capture-phase `click` handler for `.capture` triggers, registered with
   * `{ capture: true }` so the action runs before any bubble-phase handler.
   */
  function onCaptureClick(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    if (target === null || target.closest(`[${CAPTURE_ATTRIBUTE}]`) === null) {
      return;
    }
    onCallClick(event, true);
  }

  /**
   * Passive-phase `input`/`change` handler for `.passive` controls. A passive
   * listener cannot call `preventDefault`, which is the point of the modifier:
   * the author opts out of suppressing the default.
   */
  function onPassiveInput(event: JsailsEvent): void {
    const target = event.target as ComponentElement | null;
    if (target === null || !target.hasAttribute(PASSIVE_ATTRIBUTE)) {
      return;
    }
    onInputOrChange(event, true);
  }

  return {
    attach() {
      if (attached) {
        return;
      }
      attached = true;
      doc.addEventListener('input', onInputOrChange);
      doc.addEventListener('change', onInputOrChange);
      doc.addEventListener('click', onCallClick);
      doc.addEventListener('submit', onSubmit);
      doc.addEventListener('focusout', onFocusOut);
      // Modifier listeners: each handler is gated on its marker, so an element
      // without the modifier is unaffected.
      doc.addEventListener('click', onCaptureClick, { capture: true });
      doc.addEventListener('input', onPassiveInput, { passive: true });
      doc.addEventListener('change', onPassiveInput, { passive: true });
    },
    detach() {
      if (!attached) {
        return;
      }
      attached = false;
      doc.removeEventListener('input', onInputOrChange);
      doc.removeEventListener('change', onInputOrChange);
      doc.removeEventListener('click', onCallClick);
      doc.removeEventListener('submit', onSubmit);
      doc.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('click', onCaptureClick, { capture: true });
      doc.removeEventListener('input', onPassiveInput, { passive: true });
      doc.removeEventListener('change', onPassiveInput, { passive: true });
    },
  };
}
