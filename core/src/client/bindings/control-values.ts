/**
 * Bound-control value semantics for the component binding layer.
 *
 * Owns the native-control value read/write/compare helpers and the two passes
 * that move values between the DOM and a component controller's working state:
 * `captureBoundValues` (DOM → controller, skipping a file control whose
 * selection is uploaded separately) and `reapplyWorkingValues` (controller →
 * DOM, leaving an unchanged control untouched so the browser keeps its caret).
 * Both skip a widget host (a bound element that is not a native control),
 * whose value arrives through the form's submission (`../form-data.ts`).
 *
 * A `.lazy` control commits on `change` only, so while the user types in one
 * its text lives in the DOM and not in working state. `pendingLazyEdits`
 * reads that text before a render is morphed in, and `reapplyWorkingValues`
 * puts it back instead of the working value, so a render the user did not
 * trigger (a poll, a debounce flush, a refresh) never overwrites it.
 *
 * `readControlValue` and `isFileInput` accept any element with the native
 * control members, so client islands share them with real `HTMLElement`s;
 * `readBoundValue` adds a bound control's value modifiers (`trim`, `number`).
 */

import type { JsonValue } from '../../contracts/http.js';
import {
  LAZY_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  NUMBER_ATTRIBUTE,
  TRIM_ATTRIBUTE,
} from '../../server-components/protocol.js';
import type { ComponentController } from '../component-controller.js';
import { isNativeControl } from '../form-data.js';
import type { ComponentElement } from './dom-contract.js';

/** Selector for a model-bound control. */
export const MODEL_SELECTOR: string = `[${MODEL_ATTRIBUTE}]`;

/** The slice of a live binding the capture/reapply passes touch. */
interface ControlBindingView {
  readonly element: ComponentElement;
  readonly controller: ComponentController;
}

/** Resolve the component root that owns `element`, or `null` when out of scope. */
export type ResolveOwner = (element: ComponentElement) => ComponentElement | null;

/** The native-control members value reads consult. */
interface NativeControl {
  readonly tagName: string;
  readonly type?: string;
  readonly checked?: boolean;
  readonly multiple?: boolean;
  readonly selectedOptions?: ArrayLike<{ readonly value: string }>;
  readonly value?: string;
}

/**
 * Read a native control's value as a JSON value: a checkbox/radio yields its
 * `checked` boolean, a multi-select yields an array of selected values, a
 * numeric input yields a number when finite, and everything else yields its
 * string value.
 */
export function readControlValue(element: NativeControl): JsonValue {
  const type = (element.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    return element.checked === true;
  }
  if (element.tagName.toLowerCase() === 'select' && element.multiple === true) {
    const selected = element.selectedOptions;
    if (selected === undefined) {
      return [];
    }
    return Array.from(selected, (option) => option.value);
  }
  const raw = element.value ?? '';
  if (type === 'number' || type === 'range') {
    if (raw.trim() === '') {
      return '';
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  return raw;
}

/** The members a bound control's value modifiers are read from. */
interface BoundControl extends NativeControl {
  hasAttribute(name: string): boolean;
}

/**
 * Read a model-bound control's value through its value modifiers
 * (`bind(name, { trim, number })`): a text value is trimmed, then read as a
 * number when it is a finite one. Anything that is not text (a checkbox's
 * boolean, a multi-select's list, an `input[type=number]` already read as a
 * number) passes through.
 */
export function readBoundValue(element: BoundControl): JsonValue {
  let value = readControlValue(element);
  if (typeof value !== 'string') {
    return value;
  }
  if (element.hasAttribute(TRIM_ATTRIBUTE)) {
    value = value.trim();
  }
  if (element.hasAttribute(NUMBER_ATTRIBUTE) && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return value;
}

/** True when an element is a native `input[type=file]` control. */
export function isFileInput(element: Pick<NativeControl, 'tagName' | 'type'>): boolean {
  return element.tagName.toLowerCase() === 'input' && (element.type ?? '').toLowerCase() === 'file';
}

/** Write a JSON value back onto a native control. */
function writeControlValue(element: ComponentElement, value: JsonValue): void {
  const type = (element.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    element.checked = value === true;
    return;
  }
  if (element.tagName.toLowerCase() === 'select' && element.multiple === true) {
    const wanted = new Set(Array.isArray(value) ? value.map((entry) => String(entry)) : []);
    const options = element.querySelectorAll('option');
    for (const option of Array.from(options)) {
      const optionValue = option.getAttribute('value') ?? option.value ?? '';
      option.setAttribute('selected', wanted.has(optionValue) ? '' : 'false');
    }
    return;
  }
  element.value = value === null || value === undefined ? '' : String(value);
}

/** True when a control's current DOM value, read through its modifiers, already equals `value`. */
function controlMatches(element: ComponentElement, value: JsonValue): boolean {
  return sameValue(readBoundValue(element), value);
}

/** True when two control values are equal (a multi-select's lists entry by entry). */
function sameValue(current: JsonValue, value: JsonValue): boolean {
  if (Array.isArray(current) && Array.isArray(value)) {
    if (current.length !== value.length) {
      return false;
    }
    return current.every((entry, index) => entry === value[index]);
  }
  return current === value;
}

/**
 * Collect the latest bound field values from the DOM into the controller. A
 * control owned by a nested island or component root is skipped (its owner
 * captures it), as is a file control, whose selection is uploaded separately
 * and whose reference already lives in working state.
 */
export function captureBoundValues(
  binding: ControlBindingView,
  resolveOwner: ResolveOwner,
  report: (error: unknown, element: ComponentElement) => void,
): void {
  const controls = binding.element.querySelectorAll(MODEL_SELECTOR);
  for (const control of Array.from(controls)) {
    // A control owned by a nested island or a nested component root belongs
    // to that owner, never to this binding; resolve ownership the same way
    // delegated events do so capture and dispatch agree.
    if (resolveOwner(control) !== binding.element) {
      continue;
    }
    // A file control's value is never serializable state: its selection is
    // uploaded separately and its reference already lives in working state,
    // so a capture here would clobber that reference with a raw path string.
    // A widget host owns its value and contributes it at submit time.
    if (isFileInput(control) || !isNativeControl(control)) {
      continue;
    }
    const name = control.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      continue;
    }
    try {
      binding.controller.setField(name, readBoundValue(control));
    } catch (error) {
      report(error, control);
    }
  }
}

/**
 * The working-state field a reapply pass may write onto `control`, or `null`.
 * A control owned by a nested island or component root is never this
 * binding's; a file control cannot represent a working value (its selection
 * is uploaded separately, so writing a reference object into `value` would
 * corrupt it); a widget host renders its own value.
 */
function writableField(
  binding: ControlBindingView,
  resolveOwner: ResolveOwner,
  control: ComponentElement,
): string | null {
  if (
    resolveOwner(control) !== binding.element ||
    isFileInput(control) ||
    !isNativeControl(control)
  ) {
    return null;
  }
  const name = control.getAttribute(MODEL_ATTRIBUTE);
  return name !== null && Object.hasOwn(binding.controller.state, name) ? name : null;
}

/** The uncommitted text of `.lazy` controls: each control with its raw DOM value. */
export type PendingLazyEdits = ReadonlyMap<ComponentElement, JsonValue>;

/**
 * Read the uncommitted edits of the `.lazy` controls this binding owns: each
 * one whose value differs from working state, with its raw DOM value (before
 * any `trim` or `number` modifier, so the user's text comes back as typed).
 * Read it before a render is morphed in, and hand it to
 * {@link reapplyWorkingValues} after.
 */
export function pendingLazyEdits(
  binding: ControlBindingView,
  resolveOwner: ResolveOwner,
): PendingLazyEdits {
  const pending = new Map<ComponentElement, JsonValue>();
  for (const control of Array.from(binding.element.querySelectorAll(`[${LAZY_ATTRIBUTE}]`))) {
    const name = writableField(binding, resolveOwner, control);
    if (name !== null && !controlMatches(control, binding.controller.state[name] as JsonValue)) {
      pending.set(control, readControlValue(control));
    }
  }
  return pending;
}

/**
 * Reapply working values to controls, leaving unchanged controls untouched so
 * the browser keeps their caret/selection. A lazy control in `pending` (still
 * the same element after the morph) gets its uncommitted text back instead of
 * its working value; a lazy control the morph replaced takes the working
 * value like any other.
 */
export function reapplyWorkingValues(
  binding: ControlBindingView,
  resolveOwner: ResolveOwner,
  pending: PendingLazyEdits,
): void {
  for (const control of Array.from(binding.element.querySelectorAll(MODEL_SELECTOR))) {
    const name = writableField(binding, resolveOwner, control);
    if (name === null) {
      continue;
    }
    const typed = pending.get(control);
    // Skip an unchanged control so the browser keeps its caret/selection.
    if (
      typed === undefined
        ? controlMatches(control, binding.controller.state[name] as JsonValue)
        : sameValue(readControlValue(control), typed)
    ) {
      continue;
    }
    writeControlValue(control, typed ?? (binding.controller.state[name] as JsonValue));
  }
}
