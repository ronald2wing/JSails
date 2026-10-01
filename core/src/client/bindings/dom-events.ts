/**
 * Document-level delegated event handlers for bound component roots.
 *
 * `input`/`change` write native control values into the owning controller's
 * working state via `setField`; `focusout` flushes a debounced control. Click
 * and submit triggers arrive through the eager capturing listener
 * (`../trigger-queue.ts`), which prevents their default and hands each one to
 * {@link DelegatedEvents.run}: a call, sort, or submit collects the latest
 * bound field values and the element's explicit JSON args, then dispatches
 * exactly one action. Field values are never folded into action args. A
 * submit first builds the form's submission (`../form-data.ts`), so a widget
 * host's `formdata` contribution joins the edit like a native control's value.
 *
 * A `.passive` control is served by a passive listener and skipped by the
 * bubble-phase handler so an edit is captured exactly once. `.once`
 * consumption is tracked in a WeakSet rather than a DOM mutation, so the
 * server-owned markup is never altered and consumed elements are
 * garbage-collected with their subtree.
 */

import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  LAZY_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  ONCE_ATTRIBUTE,
  PASSIVE_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../../server-components/protocol.js';
import { parseActionArgs } from '../action-attrs.js';
import { collectFormData, isNativeControl, widgetEntries } from '../form-data.js';
import type { JsailsEvent } from '../islands.js';
import type { ComponentTrigger } from '../trigger-queue.js';
import { isFileInput, readBoundValue } from './control-values.js';
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
  /** Run one resolved click/submit trigger (see `../trigger-queue.ts`). */
  run(trigger: ComponentTrigger): void;
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
    // A widget host owns its value and contributes it at submit time.
    if (name === null || name === '' || !isNativeControl(target)) {
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

    // A `.lazy` control commits its value on `change` only.
    if (event.type === 'input' && target.hasAttribute(LAZY_ATTRIBUTE)) {
      return;
    }
    try {
      const value = readBoundValue(target);
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

  /**
   * Run one trigger the eager listener resolved (its default is already
   * prevented): parse its args, honour `.once` and the confirm guard, gate a
   * submit on client-side validation, then dispatch exactly one action. A
   * trigger whose root has no live binding does nothing.
   */
  function run(trigger: ComponentTrigger): void {
    const element = trigger.element as ComponentElement;
    const binding = bindingFor(element);
    if (binding === undefined) {
      return;
    }
    if (trigger.kind === 'sort') {
      const field = element.getAttribute(SORT_ATTRIBUTE);
      if (field !== null && field !== '') {
        dispatch(binding, element, 'sort', { field });
      }
      return;
    }
    const action = element.getAttribute(
      trigger.kind === 'submit' ? SUBMIT_ATTRIBUTE : CALL_ATTRIBUTE,
    );
    if (action === null || action === '') {
      return;
    }
    // `.once`: a trigger that already dispatched is inert. Checked before the
    // confirm guard so a consumed trigger never re-prompts.
    if (element.hasAttribute(ONCE_ATTRIBUTE) && consumedOnce.has(element)) {
      return;
    }
    const args = parseActionArgs(element.getAttribute(ARGS_ATTRIBUTE));
    if (args === null) {
      report(new ComponentBindingError('invalid action arguments'), element);
      return;
    }
    const confirmMessage = element.getAttribute(CONFIRM_ATTRIBUTE);
    if (confirmMessage !== null && confirmMessage !== '' && !confirmDialog(confirmMessage)) {
      return;
    }
    if (trigger.kind === 'submit') {
      // Client-side validation gate: when any bound field fails its rules, the
      // action is not dispatched and focus moves to the first invalid control.
      const firstInvalid = validateAll(binding, rootFor);
      if (firstInvalid !== null) {
        firstInvalid.focus?.();
        return;
      }
      captureWidgetValues(binding, element);
    }
    if (element.hasAttribute(ONCE_ATTRIBUTE)) {
      consumedOnce.add(element);
    }
    dispatch(binding, element, action, args);
  }

  /**
   * Build the form's submission (firing `formdata`) and write each widget
   * host's contributed value into the controller, so a widget that owns its
   * value takes part in the submit like a native control.
   */
  function captureWidgetValues(binding: RootBinding, form: ComponentElement): void {
    const entries = collectFormData(form);
    if (entries === null) {
      return;
    }
    const owned = (parent: ComponentElement | null): boolean => rootFor(parent) === binding.element;
    for (const [name, value] of widgetEntries(form, entries, owned)) {
      try {
        binding.controller.setField(name, value);
      } catch (error) {
        report(error, form);
      }
    }
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
      doc.addEventListener('focusout', onFocusOut);
      // The passive listener is gated on its marker, so a control without the
      // modifier is unaffected.
      doc.addEventListener('input', onPassiveInput, { passive: true });
      doc.addEventListener('change', onPassiveInput, { passive: true });
    },
    run,
    detach() {
      if (!attached) {
        return;
      }
      attached = false;
      doc.removeEventListener('input', onInputOrChange);
      doc.removeEventListener('change', onInputOrChange);
      doc.removeEventListener('focusout', onFocusOut);
      doc.removeEventListener('input', onPassiveInput, { passive: true });
      doc.removeEventListener('change', onPassiveInput, { passive: true });
    },
  };
}
