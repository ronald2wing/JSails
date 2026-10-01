/**
 * Admin form inputs: the per-field input elements shared by the top-level form
 * (`render-form.ts`) and the repeater/formset rows (`render-repeater.ts`), plus
 * the render state they read submitted and stored values from.
 *
 * Every value is emitted as a text child or attribute so Preact owns escaping.
 * The module is ORM-free and performs no I/O.
 */

import { h, type ComponentChild } from 'preact';

import {
  DEFAULT_RICH_TEXT_ISLAND,
  createEmptyRichTextDocument,
  type RichTextDocument,
} from 'jsails/rich-text';

import type { ResourceField, ResourceSelectOption } from './field-types.js';

/** State for one form render (create, edit, or a 422 re-render). */
export interface FormRenderState {
  readonly id: string | null;
  readonly record?: Record<string, unknown>;
  readonly values: Record<string, string>;
  readonly errors: Record<string, string>;
  readonly csrf: string;
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

/** Render a file field: the file input plus the current stored key, when present. */
export function renderFileInput(
  field: ResourceField,
  state: FormRenderState,
  id: string,
): ComponentChild {
  const current = fieldValue(field, state);
  return h(
    'div',
    null,
    h('input', {
      type: 'file',
      name: field.name,
      id,
      ...(field.accept === undefined ? {} : { accept: field.accept }),
    }),
    ...(current === '' ? [] : [h('p', null, 'Current: ', h('code', null, current))]),
  );
}

/**
 * Render a `richText` field: a mount marker that the app client hydrates into a
 * rich-text editor, carrying the field name and the parsed document in its
 * props, plus a nested textarea (no-JS fallback editor, also the value the
 * server schema receives). Preact replaces the textarea when the island
 * hydrates, so the textarea must live inside the marker.
 */
export function renderRichTextInput(
  field: ResourceField,
  state: FormRenderState,
  id: string,
): ComponentChild {
  const json = richTextJsonValue(field, state);
  const editor = field.editor;
  return h(
    'div',
    {
      'data-jsails-rich-text': '',
      'data-jsails-island': editor?.island ?? DEFAULT_RICH_TEXT_ISLAND,
      'data-jsails-props': JSON.stringify({
        name: field.name,
        document: parseRichTextDocument(json),
        ...(editor === undefined ? {} : { editor: editor.id }),
        ...(field.mediaPickerUrl === undefined ? {} : { mediaPickerUrl: field.mediaPickerUrl }),
      }),
    },
    h('textarea', { name: field.name, id }, json),
  );
}

/** Parse the rendered JSON back to a document, falling back to an empty one. */
function parseRichTextDocument(json: string): RichTextDocument {
  try {
    return JSON.parse(json) as RichTextDocument;
  } catch {
    // A malformed submitted value must still re-render an editable form.
    return createEmptyRichTextDocument();
  }
}

/**
 * The JSON string a `richText` field renders: the submitted value verbatim, the
 * record value re-serialized, or an empty document when neither is present.
 */
function richTextJsonValue(field: ResourceField, state: FormRenderState): string {
  const submitted = state.values[field.name];
  if (submitted !== undefined) {
    return submitted;
  }
  const raw = state.record?.[field.name];
  if (raw !== undefined && raw !== null) {
    return JSON.stringify(raw);
  }
  return JSON.stringify(createEmptyRichTextDocument());
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
