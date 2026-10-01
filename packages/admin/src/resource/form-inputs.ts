/**
 * Admin form inputs: the per-field input elements shared by the top-level form
 * (`render-form.ts`) and the repeater/formset rows (`render-repeater.ts`), plus
 * the render state they read submitted and stored values from.
 *
 * Every value is emitted as a text child or attribute so Preact owns escaping.
 * The module is ORM-free and performs no I/O.
 */

import { h, type ComponentChild } from 'preact';

import { createEmptyRichTextDocument, parseRichText, type RichTextIssue } from 'jsails/rich-text';

import { parseJsonValue, readSubmittedRichText } from './field-schemas.js';
import type { ResourceField, ResourceSelectOption } from './field-types.js';

/** State for one form render (create, edit, or a 422 re-render). */
export interface FormRenderState {
  readonly id: string | null;
  readonly record?: Record<string, unknown>;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  /** A rejection that belongs to no single field, shown above the fields. */
  readonly formError?: string;
  readonly action: string;
  /** Canonical table-state query string (no leading `?`) preserved through save. */
  readonly back: string;
  /**
   * Pre-rendered relation manager HTML strings, one per manager in order.
   * When present each is embedded as trusted producer output below the form
   * fields (and above the Back link). Only meaningful on an edit page.
   */
  readonly relationManagerHtml?: readonly string[];
}

/** The input-shaping subset shared by top-level fields and repeater item fields. */
export interface ScalarInputField {
  readonly type: string;
  readonly options?: readonly ResourceSelectOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

/** Whether a submitted checkbox value means "checked" (`on` for toggles, `1` for checkboxes). */
export function isCheckedValue(value: string | undefined): boolean {
  return value === 'on' || value === '1';
}

/** Stringify a stored value for an input's `value`; `null`/`undefined` render empty. */
export function inputValue(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return '';
  }
  return typeof raw === 'string' ? raw : String(raw);
}

/** Render a scalar input element (every kind except repeater/file/richText). */
export function renderScalarInput(
  field: ScalarInputField,
  name: string,
  id: string,
  value: string,
  checked: boolean,
): ComponentChild {
  const options = field.options ?? [];
  switch (field.type) {
    case 'select':
      return h(
        'select',
        { name, id },
        ...options.map((option) =>
          h(
            'option',
            { value: option.value, ...(option.value === value ? { selected: true } : {}) },
            option.label,
          ),
        ),
      );
    case 'radio':
      return h(
        'div',
        null,
        ...options.map((option) =>
          h(
            'label',
            null,
            h('input', {
              type: 'radio',
              name,
              value: option.value,
              ...(option.value === value ? { checked: true } : {}),
            }),
            option.label,
          ),
        ),
      );
    case 'toggle':
    case 'checkbox':
      return h('input', {
        type: 'checkbox',
        name,
        id,
        value: field.type === 'toggle' ? 'on' : '1',
        ...(checked ? { checked: true } : {}),
      });
    case 'number':
    case 'date':
    case 'color':
      return h('input', { type: field.type, name, id, value });
    case 'datetime':
      return h('input', { type: 'datetime-local', name, id, value });
    case 'slider':
      return h('input', {
        type: 'range',
        name,
        id,
        value,
        ...(field.min === undefined ? {} : { min: String(field.min) }),
        ...(field.max === undefined ? {} : { max: String(field.max) }),
        ...(field.step === undefined ? {} : { step: String(field.step) }),
      });
    case 'autocomplete':
      // The marker is the whole server contract: the autocomplete client
      // binding (debounced fetch + dropdown) is app-owned, so no client bundle
      // ships with the admin.
      return h('input', { type: 'text', name, id, value, 'data-jsails-autocomplete': '' });
    case 'textarea':
    case 'tags':
    case 'code':
    case 'keyvalue':
    case 'markdown':
      return h('textarea', { name, id }, value);
    default:
      return h('input', { type: 'text', name, id, value });
  }
}

/**
 * Render a file field: the file input plus, when the record already stores a
 * key, that key shown as text and carried in a hidden input of the same name.
 * An edit that does not pick a new file submits only the hidden key, which the
 * save keeps after checking it against the stored record. `current` overrides
 * the value lookup (a formset row reads its key from the stored row).
 */
export function renderFileInput(
  field: ResourceField,
  state: FormRenderState,
  id: string,
  current: string = fieldValue(field, state),
): ComponentChild {
  return h(
    'div',
    null,
    h('input', {
      type: 'file',
      name: field.name,
      id,
      ...(field.accept === undefined ? {} : { accept: field.accept }),
    }),
    ...(current === ''
      ? []
      : [
          h('input', { type: 'hidden', name: field.name, value: current }),
          h('p', null, 'Current: ', h('code', null, current)),
        ]),
  );
}

// The rich-text field markup contract of `@jsails/editor` (its
// `field/contract.ts`), written out here so the admin renders and round-trips
// rich-text fields without depending on the editor package: the island name,
// the source input marker, the wrapper the island keeps, and the fallback
// texts its island replaces.
const RICH_TEXT_ISLAND = 'rich-text';
const RICH_TEXT_SOURCE_ATTRIBUTE = 'data-rich-text-source';
const RICH_TEXT_WRAPPER_CLASS = 'rich-text-editor';
const RICH_TEXT_FALLBACK_TEXT =
  'Editing this field needs JavaScript. Saving the form keeps its content unchanged.';
const RICH_TEXT_UNREADABLE_TITLE = 'This content cannot be edited here.';
const RICH_TEXT_KEPT_TEXT = 'Saving the form keeps the stored content unchanged.';
const RICH_TEXT_MAX_LISTED_ISSUES = 20;

/** A `richText` field's value as the form carries it: readable JSON, or the raw text and its issues. */
type RichTextFieldValue =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly raw: string; readonly issues: readonly RichTextIssue[] };

/**
 * Render a `richText` field as the `rich-text` island's markup: the island
 * marker with its props (`name`, `label`, `id`, `mediaPickerUrl`; never the
 * document, which can exceed the props bound), the source input holding the
 * document's JSON, and the fallback a reader without JavaScript sees.
 *
 * A readable value goes in the source input under the field name, so a
 * submit before the editor starts (or after it failed to) sends it back
 * unchanged. An unreadable value goes in without a name, beside a panel
 * listing its issues: such a submit omits the field, which the field schema
 * reads as "keep the stored value", and the island offers an explicit
 * "discard and start empty" instead of an editor.
 */
export function renderRichTextInput(
  field: ResourceField,
  state: FormRenderState,
  id: string,
): ComponentChild {
  const value = richTextFieldValue(field, state);
  const props = {
    name: field.name,
    label: field.label,
    id,
    ...(field.mediaPickerUrl === undefined ? {} : { mediaPickerUrl: field.mediaPickerUrl }),
  };
  const marker = {
    'data-jsails-island': RICH_TEXT_ISLAND,
    'data-jsails-props': JSON.stringify(props),
  };
  if (value.ok) {
    return h(
      'div',
      marker,
      h('input', {
        type: 'hidden',
        [RICH_TEXT_SOURCE_ATTRIBUTE]: '',
        name: field.name,
        value: value.json,
      }),
      h(
        'div',
        { class: RICH_TEXT_WRAPPER_CLASS, 'data-state': 'loading' },
        h('p', { class: 'rich-text-editor-fallback' }, RICH_TEXT_FALLBACK_TEXT),
      ),
    );
  }
  const listed = value.issues.slice(0, RICH_TEXT_MAX_LISTED_ISSUES);
  const more = value.issues.length - listed.length;
  return h(
    'div',
    marker,
    h('input', { type: 'hidden', [RICH_TEXT_SOURCE_ATTRIBUTE]: '', value: value.raw }),
    h(
      'div',
      { class: RICH_TEXT_WRAPPER_CLASS, 'data-state': 'unreadable' },
      h(
        'div',
        {
          class: 'rich-text-editor-unreadable',
          role: 'group',
          'aria-label': RICH_TEXT_UNREADABLE_TITLE,
        },
        h('p', { class: 'rich-text-editor-unreadable-title' }, RICH_TEXT_UNREADABLE_TITLE),
        h(
          'ul',
          null,
          ...listed.map((issue) =>
            h(
              'li',
              null,
              `${issue.path.length === 0 ? 'document' : issue.path.join('.')}: ${issue.message}`,
            ),
          ),
        ),
        ...(more > 0 ? [h('p', null, `And ${String(more)} more.`)] : []),
        h('p', null, RICH_TEXT_KEPT_TEXT),
      ),
    ),
  );
}

/**
 * The value a `richText` field renders. A submitted value (a 422 re-render)
 * is read the way the field schema reads it, so the form shows its canonical
 * form; a blank or absent submission falls back to the stored value, read
 * with `parseRichText` alone (a stored body is never repaired on the way to
 * the form); with neither, a create starts from the empty document.
 */
function richTextFieldValue(field: ResourceField, state: FormRenderState): RichTextFieldValue {
  const submitted = state.values[field.name];
  if (submitted !== undefined && submitted.trim() !== '') {
    const read = readSubmittedRichText(parseJsonValue(submitted));
    return read.ok
      ? { ok: true, json: JSON.stringify(read.value) }
      : { ok: false, raw: submitted, issues: read.issues };
  }
  const stored = state.record?.[field.name];
  if (stored === undefined || stored === null) {
    return { ok: true, json: JSON.stringify(createEmptyRichTextDocument()) };
  }
  const read = parseRichText(stored);
  return read.ok
    ? { ok: true, json: JSON.stringify(read.value) }
    : { ok: false, raw: storedJsonText(stored), issues: read.issues };
}

/** The JSON text of a stored value, or empty when it has none (a cycle, a bigint). */
function storedJsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Not serialisable: there are no original bytes to carry.
    return '';
  }
}

/** Resolve a field's string value from submitted values or the record. */
export function fieldValue(field: ResourceField, state: FormRenderState): string {
  const submitted = state.values[field.name];
  if (submitted !== undefined) {
    return submitted;
  }
  return inputValue(state.record?.[field.name]);
}

/** Resolve a checkbox's checked state from submitted values or the record. */
export function fieldChecked(field: ResourceField, state: FormRenderState): boolean {
  if (Object.hasOwn(state.values, field.name)) {
    return isCheckedValue(state.values[field.name]);
  }
  return state.record?.[field.name] === true;
}
