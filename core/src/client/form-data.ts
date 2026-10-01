/**
 * The one way the client runtime reads a form: `new FormData(form)`.
 *
 * Building the entry list from the form element is what fires the form's
 * `formdata` event, the hook through which a widget (the rich-text editor, a
 * custom picker) writes the value it owns into a submission. Every first-party
 * submit path goes through {@link collectFormData}, so a widget behaves the
 * same in a native form, a server component form, and an island form; a
 * structure test forbids serialising a form any other way under `src/client`.
 *
 * A widget joins a bound form through its host element: a
 * `[data-jsails-model]` element that is not a native control. Native controls
 * keep their typed reads (`bindings/control-values.ts`); a widget host's value
 * is the single string entry of its model name in the submission
 * ({@link widgetEntries}). The host may itself be an island (an editor), so
 * its ownership is decided from its parent element.
 */

import { MODEL_ATTRIBUTE } from '../server-components/protocol.js';

/** The slice of a `FormData` the runtime reads. */
export interface FormEntries {
  getAll(name: string): readonly unknown[];
}

/** The slice of an element widget discovery touches. */
export interface WidgetHostElement<P = unknown> {
  readonly tagName: string;
  readonly parentElement: P | null;
  getAttribute(name: string): string | null;
}

/** The slice of a form element widget discovery touches. */
export interface FormSource<E> {
  querySelectorAll(selector: string): ArrayLike<E>;
}

/** Tags whose value the runtime reads natively rather than from the submission. */
const NATIVE_CONTROL_TAGS: ReadonlySet<string> = new Set(['input', 'select', 'textarea']);

/** True when `element` is a native form control (`input`, `select`, `textarea`). */
export function isNativeControl(element: { readonly tagName: string }): boolean {
  return NATIVE_CONTROL_TAGS.has(element.tagName.toLowerCase());
}

/**
 * Build the submission of `form` with `new FormData(form)`, which fires its
 * `formdata` event. Returns `null` outside a browser form (no
 * `HTMLFormElement`, or `form` is not one), where there is no submission to
 * build.
 */
export function collectFormData(form: object): FormEntries | null {
  const g = globalThis as {
    FormData?: new (form: object) => FormEntries;
    HTMLFormElement?: abstract new () => object;
  };
  const FormDataCtor = g.FormData;
  const FormElement = g.HTMLFormElement;
  if (typeof FormDataCtor !== 'function' || typeof FormElement !== 'function') {
    return null;
  }
  if (!(form instanceof FormElement)) {
    return null;
  }
  return new FormDataCtor(form);
}

/**
 * The value each widget host in `form` contributed to `entries`, as
 * `[modelName, value]` pairs in document order. A host counts only when
 * `ownsScope` accepts its parent element (the caller's ownership rule, asked
 * of the parent because a widget host may itself be an island: its own marker
 * is the widget's, its attributes the enclosing scope's) and its name carries
 * exactly one string entry; a missing, repeated, or file entry contributes
 * nothing.
 */
export function widgetEntries<E extends WidgetHostElement<E>>(
  form: FormSource<E>,
  entries: FormEntries,
  ownsScope: (parent: E | null) => boolean,
): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const host of Array.from(form.querySelectorAll(`[${MODEL_ATTRIBUTE}]`))) {
    if (isNativeControl(host) || !ownsScope(host.parentElement)) {
      continue;
    }
    const name = host.getAttribute(MODEL_ATTRIBUTE);
    if (name === null || name === '') {
      continue;
    }
    const values = entries.getAll(name);
    const value = values[0];
    if (values.length === 1 && typeof value === 'string') {
      out.push([name, value]);
    }
  }
  return out;
}
