/**
 * Form building blocks shared by every admin surface that posts back to the
 * panel: the hidden inputs that carry the CSRF token and routing markers, the
 * one-button action form, and the marker filter that keeps those internal
 * fields out of a resource's values.
 *
 * Every admin `POST` is same-origin and CSRF-checked by the panel before a
 * handler runs, so a form must carry `_csrf`; the other markers (`_back`,
 * `_parent`, the repeater and wizard intents) are routing state the handlers
 * read themselves and must never reach a schema or a callback as a value.
 */

import { h, type ComponentChild } from 'preact';

/** The internal hidden-field names a handler reads and a schema never sees. */
export const FORM_MARKER_FIELDS: ReadonlySet<string> = new Set([
  '_csrf',
  '_back',
  '_parent',
  '_repeater_add',
  '_repeater_remove',
  '_wizard_step',
  '_wizard_prev',
  '_wizard_next',
]);

/** A hidden input carrying one field. Preact owns the attribute escaping. */
export function hiddenInput(name: string, value: string): ComponentChild {
  return h('input', { type: 'hidden', name, value });
}

/** The hidden `_csrf` input every admin mutation form must carry. */
export function csrfInput(token: string): ComponentChild {
  return hiddenInput('_csrf', token);
}

/** Options for {@link actionForm}. */
export interface ActionFormOptions {
  /** The form's POST target. */
  readonly path: string;
  /** The session's CSRF token. */
  readonly csrf: string;
  /** The submit button label. */
  readonly label: string;
  /** A hidden `action` field naming the operation for a dispatching handler. */
  readonly action?: string;
  /** A hidden `id` field naming the target record. */
  readonly id?: string;
  /** Extra controls rendered between the hidden fields and the button. */
  readonly controls?: readonly ComponentChild[];
  /** An optional `class` for the form element. */
  readonly class?: string;
}

/** A one-button POST form carrying the CSRF token plus optional `action`/`id` fields. */
export function actionForm(options: ActionFormOptions): ComponentChild {
  return h(
    'form',
    {
      method: 'post',
      action: options.path,
      ...(options.class === undefined ? {} : { class: options.class }),
    },
    csrfInput(options.csrf),
    ...(options.action === undefined ? [] : [hiddenInput('action', options.action)]),
    ...(options.id === undefined ? [] : [hiddenInput('id', options.id)]),
    ...(options.controls ?? []),
    h('button', { type: 'submit' }, options.label),
  );
}

/** Drop the internal marker fields so only field values remain. */
export function stripFormMarkers(body: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!FORM_MARKER_FIELDS.has(key)) {
      values[key] = value;
    }
  }
  return values;
}
