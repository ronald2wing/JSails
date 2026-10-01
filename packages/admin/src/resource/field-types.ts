/**
 * Admin resource field descriptors: the form-field type definitions and their
 * deep-freezing.
 *
 * The field model is deliberately small and drives both the form markup and the
 * validation schema:
 *
 * - `text`/`textarea` validate as strings (textarea only changes the input);
 * - `select` validates as a string, or as one of its `options` values when
 *   options are declared;
 * - `radio` requires `options` and validates as one of them (single choice);
 * - `toggle`/`checkbox` coerce an unchecked box (an absent key) to `false` and
 *   never honor `required` (a boolean is either checked or not);
 * - `number` coerces numeric strings to numbers; an empty or non-numeric value
 *   is a validation error (never a silent `0`);
 * - `date`/`datetime` validate as ISO date/datetime strings (rendered as the
 *   matching HTML input kinds).
 * - `richText` validates a JSON string (or a direct object) as a
 *   `RichTextDocument`; it carries no type-specific config beyond `required`.
 *
 * `required` defaults to `true`: a missing field is rejected. `required: false`
 * makes the field optional (an absent value parses to `undefined`). Every
 * author-supplied collection is deep-frozen by {@link freezeFields}.
 *
 * The module is ORM-free and performs no I/O. The validation lives in
 * `field-validation.ts` and the Zod coercion in `field-schemas.ts`.
 */

import type { RichTextEditorAdapter } from 'jsails/rich-text';

import { freezeSelectOptions, type ResourceSelectOption } from './select-options.js';

export type { ResourceSelectOption };

/** Field input kinds the resource form renders and validates. */
export type ResourceFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'toggle'
  | 'number'
  | 'date'
  | 'datetime'
  | 'checkbox'
  | 'radio'
  | 'repeater'
  | 'file'
  | 'keyvalue'
  | 'tags'
  | 'color'
  | 'slider'
  | 'code'
  | 'markdown'
  | 'autocomplete'
  | 'richText';

/** Input kinds a repeater item field may use (the scalar kinds only). */
export type ResourceRepeaterItemType = Exclude<ResourceFieldType, 'repeater' | 'file' | 'keyvalue'>;

/** One field inside a repeater item. */
export interface ResourceRepeaterItemField {
  /** Item field name (the key within each item object). */
  readonly name: string;
  /** Human label rendered next to the input. */
  readonly label: string;
  /** Input kind; a scalar kind, never `repeater`/`file`. */
  readonly type: ResourceRepeaterItemType;
  /** When `false`, the item field is optional. Defaults to `true`. */
  readonly required?: boolean;
  /** Choices; required for `radio`, optional for `select`. */
  readonly options?: readonly ResourceSelectOption[];
  /** Minimum value for a `slider` item field. */
  readonly min?: number;
  /** Maximum value for a `slider` item field. */
  readonly max?: number;
  /** Step increment for a `slider` item field. */
  readonly step?: number;
}

/** Configuration for a `repeater` field. */
export interface ResourceRepeaterConfig {
  /** The fields each item renders and validates. */
  readonly fields: readonly ResourceRepeaterItemField[];
  /** Maximum item count (1..100); defaults to {@link DEFAULT_MAX_REPEATER_ITEMS}. */
  readonly maxItems?: number;
}

/** Configuration for a `formset` field (inline child-records within a repeater-like field). */
export interface ResourceFormsetConfig {
  /** The fields each formset row renders and validates. */
  readonly fields: readonly ResourceField[];
  /** Maximum row count (1..100); defaults to {@link DEFAULT_MAX_REPEATER_ITEMS}. */
  readonly maxItems?: number;
  /** Minimum row count (0..maxItems); defaults to 0. */
  readonly minItems?: number;
}

/** Configuration for an `autocomplete` field. */
export interface ResourceAutocompleteConfig {
  /** Async search function; returns matching options for the query string. */
  readonly search: (query: string) => Promise<readonly ResourceSelectOption[]>;
  /** Minimum characters before a search is triggered; defaults to 2. */
  readonly minChars?: number;
}

/** A single form field. */
export interface ResourceField {
  /** Form field name (and the object key persisted by `save`). */
  readonly name: string;
  /** Human label rendered next to the input. */
  readonly label: string;
  /** Input kind; drives the form markup and the Zod coercion. */
  readonly type: ResourceFieldType;
  /** When `false`, the field is optional. Defaults to `true`. */
  readonly required?: boolean;
  /** Choices; required for `radio`, optional for `select`. */
  readonly options?: readonly ResourceSelectOption[];
  /** Item fields and bounds; required and only valid for a `repeater` field. */
  readonly repeater?: ResourceRepeaterConfig;
  /** Inline formset fields and bounds; only valid on a `repeater`-type field. */
  readonly formset?: ResourceFormsetConfig;
  /** Accepted MIME/extension hint for a `file` field's `<input accept>`; only valid there. */
  readonly accept?: string;
  /** Search config; required and only valid when `type` is `'autocomplete'`. */
  readonly autocomplete?: ResourceAutocompleteConfig;
  /** Minimum value for a `slider` field. Only valid when `type` is `'slider'`. */
  readonly min?: number;
  /** Maximum value for a `slider` field. Only valid when `type` is `'slider'`. */
  readonly max?: number;
  /** Step increment for a `slider` field. Only valid when `type` is `'slider'`. */
  readonly step?: number;
  /** Advisory language hint for a `code` field. Only valid when `type` is `'code'`. */
  readonly language?: string;
  /**
   * Sanitize untrusted HTML for a `markdown` field. Required when `type` is
   * `'markdown'`; the sanitizer receives raw HTML and must return safe HTML.
   */
  readonly sanitize?: (html: string) => string;
  /**
   * Editor adapter for a `richText` field. When present the field persists an
   * `EditorDocument` envelope (canonical content + optional native payload)
   * instead of a bare `RichTextDocument`, and hydrates the adapter's island.
   */
  readonly editor?: RichTextEditorAdapter;
  /**
   * Optional same-origin media picker endpoint for a `richText` field's
   * image/gallery tools. Only valid when `type` is `'richText'`; it must be a
   * non-empty, control-character-free string (a root-relative path or an
   * absolute http(s) URL). The editor's picker enforces the fetchable-shape
   * policy at runtime.
   */
  readonly mediaPickerUrl?: string;
}

/** Default upper bound on repeater items when `maxItems` is omitted. */
export const DEFAULT_MAX_REPEATER_ITEMS = 10;

/** Deep-freeze a defensive copy of the fields (and their options/repeater config). */
export function freezeFields(fields: readonly ResourceField[]): readonly ResourceField[] {
  return Object.freeze(
    fields.map((field) =>
      Object.freeze({
        name: field.name,
        label: field.label,
        type: field.type,
        ...(field.required === undefined ? {} : { required: field.required }),
        ...(field.accept === undefined ? {} : { accept: field.accept }),
        ...(field.autocomplete === undefined
          ? {}
          : {
              autocomplete: {
                search: field.autocomplete.search,
                ...(field.autocomplete.minChars === undefined
                  ? {}
                  : { minChars: field.autocomplete.minChars }),
              },
            }),
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.step === undefined ? {} : { step: field.step }),
        ...(field.language === undefined ? {} : { language: field.language }),
        ...(field.sanitize === undefined ? {} : { sanitize: field.sanitize }),
        ...(field.editor === undefined ? {} : { editor: field.editor }),
        ...(field.mediaPickerUrl === undefined ? {} : { mediaPickerUrl: field.mediaPickerUrl }),
        ...(field.options === undefined ? {} : { options: freezeSelectOptions(field.options) }),
        ...(field.repeater === undefined
          ? {}
          : {
              repeater: Object.freeze({
                fields: Object.freeze(
                  field.repeater.fields.map((itemField) =>
                    Object.freeze({
                      name: itemField.name,
                      label: itemField.label,
                      type: itemField.type,
                      ...(itemField.required === undefined ? {} : { required: itemField.required }),
                      ...(itemField.min === undefined ? {} : { min: itemField.min }),
                      ...(itemField.max === undefined ? {} : { max: itemField.max }),
                      ...(itemField.step === undefined ? {} : { step: itemField.step }),
                      ...(itemField.options === undefined
                        ? {}
                        : { options: freezeSelectOptions(itemField.options) }),
                    }),
                  ),
                ),
                ...(field.repeater.maxItems === undefined
                  ? {}
                  : { maxItems: field.repeater.maxItems }),
              }),
            }),
        ...(field.formset === undefined
          ? {}
          : {
              formset: Object.freeze({
                fields: Object.freeze(
                  field.formset.fields.map((subField) =>
                    Object.freeze({
                      name: subField.name,
                      label: subField.label,
                      type: subField.type,
                      ...(subField.required === undefined ? {} : { required: subField.required }),
                      ...(subField.accept === undefined ? {} : { accept: subField.accept }),
                      ...(subField.options === undefined
                        ? {}
                        : { options: freezeSelectOptions(subField.options) }),
                      ...(subField.min === undefined ? {} : { min: subField.min }),
                      ...(subField.max === undefined ? {} : { max: subField.max }),
                      ...(subField.step === undefined ? {} : { step: subField.step }),
                      ...(subField.language === undefined ? {} : { language: subField.language }),
                      ...(subField.sanitize === undefined ? {} : { sanitize: subField.sanitize }),
                    }),
                  ),
                ),
                ...(field.formset.maxItems === undefined
                  ? {}
                  : { maxItems: field.formset.maxItems }),
                ...(field.formset.minItems === undefined
                  ? {}
                  : { minItems: field.formset.minItems }),
              }),
            }),
      }),
    ),
  );
}
