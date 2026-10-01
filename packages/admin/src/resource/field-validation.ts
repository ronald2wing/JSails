/**
 * Admin resource field validation: the eager checks every form field, repeater
 * item field, and formset row field passes before `defineResource` derives a
 * schema from it.
 *
 * Repeater items and formset rows are validated through one item-field walk
 * with the kind-specific allowed types, so the two bounded list shapes cannot
 * drift apart. Every failure is a value-free `AdminDefinitionError`
 * (`invalid_resource`) that never echoes the rejected input.
 */

import { isRecord } from 'jsails/plugin-sdk';
import { CONTROL_CHARS } from 'jsails/support';

import { AdminDefinitionError } from '../errors.js';
import {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceField,
  type ResourceFieldType,
  type ResourceRepeaterItemField,
} from './field-types.js';
import { validateSelectOptions } from './select-options.js';

/** Every field input kind. */
const FIELD_TYPES: ReadonlySet<string> = new Set<ResourceFieldType>([
  'text',
  'textarea',
  'select',
  'toggle',
  'number',
  'date',
  'datetime',
  'checkbox',
  'radio',
  'repeater',
  'file',
  'keyvalue',
  'tags',
  'color',
  'slider',
  'code',
  'markdown',
  'autocomplete',
  'richText',
]);

/** Scalar field kinds a repeater item may use (everything except repeater/file/keyvalue). */
const REPEATER_ITEM_TYPES: ReadonlySet<string> = new Set<ResourceFieldType>([
  'text',
  'textarea',
  'select',
  'toggle',
  'number',
  'date',
  'datetime',
  'checkbox',
  'radio',
  'tags',
  'color',
  'slider',
  'code',
]);

/** Upper bound on the items of one repeater or formset field. */
const MAX_ITEMS_BOUND = 100;

/** Raise the resource's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_resource', message);
}

/** Validate the form fields: names, types, options, and uniqueness. */
export function validateResourceFields(value: unknown): void {
  if (!Array.isArray(value)) {
    throw invalid('resource fields must be an array');
  }
  const seen = new Set<string>();
  for (const field of value) {
    if (!isRecord(field)) {
      throw invalid('resource field must be an object');
    }
    const candidate = field as unknown as ResourceField;
    validateFieldIdentity(candidate, seen, 'resource field', FIELD_TYPES);
    validateEditor(candidate);
    validateMediaPickerUrl(candidate);
    if (candidate.type === 'repeater') {
      if (candidate.formset !== undefined) {
        validateFormset(candidate);
      } else {
        validateRepeater(candidate);
      }
    } else {
      if (candidate.repeater !== undefined) {
        throw invalid('resource field repeater is only valid for repeater fields');
      }
      if (candidate.formset !== undefined) {
        throw invalid('resource field formset is only valid for repeater fields');
      }
    }
    if (candidate.type === 'file') {
      if (candidate.accept !== undefined && typeof candidate.accept !== 'string') {
        throw invalid('file field accept must be a string');
      }
    } else if (candidate.accept !== undefined) {
      throw invalid('resource field accept is only valid for file fields');
    }
    validateSliderBounds(candidate, 'slider field');
    if (candidate.type === 'code') {
      if (candidate.language !== undefined && typeof candidate.language !== 'string') {
        throw invalid('code field language must be a string');
      }
    } else if (candidate.language !== undefined) {
      throw invalid('language is only valid for code fields');
    }
    if (candidate.type === 'markdown') {
      if (typeof candidate.sanitize !== 'function') {
        throw invalid('markdown field must define a sanitize function');
      }
    } else if (candidate.sanitize !== undefined) {
      throw invalid('sanitize is only valid for markdown fields');
    }
    validateAutocomplete(candidate);
    validateOptions(candidate);
  }
}

/** The fields every field-like descriptor carries. */
interface FieldIdentity {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly required?: boolean;
}

/** Validate a unique, non-shadowing name, a label, a supported type, and `required`. */
function validateFieldIdentity(
  field: FieldIdentity,
  seen: Set<string>,
  label: string,
  types: ReadonlySet<string>,
): void {
  if (typeof field.name !== 'string' || field.name.trim() === '') {
    throw invalid(`${label} name must be a non-empty string`);
  }
  if (field.name in Object.prototype) {
    throw invalid(`${label} name must not shadow an inherited property`);
  }
  if (seen.has(field.name)) {
    throw invalid(`${label} names must be unique`);
  }
  seen.add(field.name);
  if (typeof field.label !== 'string' || field.label.trim() === '') {
    throw invalid(`${label} label must be a non-empty string`);
  }
  if (typeof field.type !== 'string' || !types.has(field.type)) {
    throw invalid(`${label} type is not supported`);
  }
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    throw invalid(`${label} required must be a boolean`);
  }
}

/** A `richText` editor adapter must be structurally complete. */
function validateEditor(field: ResourceField): void {
  if (field.editor === undefined) return;
  if (field.type !== 'richText') {
    throw invalid('editor is only valid on a richText field');
  }
  const editor: unknown = field.editor;
  if (
    !isRecord(editor) ||
    typeof editor['id'] !== 'string' ||
    typeof editor['island'] !== 'string' ||
    typeof editor['toContent'] !== 'function' ||
    typeof editor['fromContent'] !== 'function' ||
    !isRecord(editor['payloadSchema']) ||
    typeof editor['payloadSchema']['safeParse'] !== 'function'
  ) {
    throw invalid('richText editor must be a valid editor adapter');
  }
}

/** A `mediaPickerUrl` is a non-empty, control-character-free string on a `richText` field. */
function validateMediaPickerUrl(field: ResourceField): void {
  if (field.mediaPickerUrl === undefined) return;
  if (field.type !== 'richText') {
    throw invalid('mediaPickerUrl is only valid on a richText field');
  }
  if (typeof field.mediaPickerUrl !== 'string') {
    throw invalid('mediaPickerUrl must be a string');
  }
  if (field.mediaPickerUrl.trim() === '') {
    throw invalid('mediaPickerUrl must be a non-empty string');
  }
  if (CONTROL_CHARS.test(field.mediaPickerUrl)) {
    throw invalid('mediaPickerUrl must not contain control characters');
  }
}

/** A slider carries numeric `min < max` and an optional positive `step`; nothing else may. */
function validateSliderBounds(
  field: Pick<ResourceField, 'type' | 'min' | 'max' | 'step'>,
  label: string,
): void {
  if (field.type === 'slider') {
    if (typeof field.min !== 'number' || typeof field.max !== 'number' || field.min >= field.max) {
      throw invalid(`${label} must define numeric min and max with min < max`);
    }
    if (field.step !== undefined && (typeof field.step !== 'number' || field.step <= 0)) {
      throw invalid(`${label} step must be a positive number`);
    }
    return;
  }
  if (field.min !== undefined) {
    throw invalid('min is only valid for slider fields');
  }
  if (field.max !== undefined) {
    throw invalid('max is only valid for slider fields');
  }
  if (field.step !== undefined) {
    throw invalid('step is only valid for slider fields');
  }
}

/** An autocomplete field needs a `search` function and an optional positive `minChars`. */
function validateAutocomplete(field: ResourceField): void {
  if (field.type !== 'autocomplete') {
    if (field.autocomplete !== undefined) {
      throw invalid('autocomplete config is only valid for autocomplete fields');
    }
    return;
  }
  const config: unknown = field.autocomplete;
  if (!isRecord(config)) {
    throw invalid('autocomplete field must define an autocomplete config object');
  }
  if (typeof config['search'] !== 'function') {
    throw invalid('autocomplete search must be a function');
  }
  const minChars = config['minChars'];
  if (minChars !== undefined && !isPositiveInteger(minChars)) {
    throw invalid('autocomplete minChars must be a positive integer');
  }
}

/** Whether `value` is a safe integer of at least 1. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Validate the bounded item list a repeater or formset config carries. */
function validateItemBounds(config: Record<string, unknown>, label: string): void {
  if (!Array.isArray(config['fields']) || config['fields'].length === 0) {
    throw invalid(`${label} fields must be a non-empty array`);
  }
  const maxItems = config['maxItems'];
  if (maxItems !== undefined && (!isPositiveInteger(maxItems) || maxItems > MAX_ITEMS_BOUND)) {
    throw invalid(`${label} maxItems must be an integer between 1 and ${MAX_ITEMS_BOUND}`);
  }
}

/** Validate a `repeater` field's scalar item fields and `maxItems` bound. */
function validateRepeater(field: ResourceField): void {
  const config: unknown = field.repeater;
  if (!isRecord(config)) {
    throw invalid('repeater config must be an object');
  }
  validateItemBounds(config, 'repeater');
  const seen = new Set<string>();
  for (const itemField of config['fields'] as readonly unknown[]) {
    if (!isRecord(itemField)) {
      throw invalid('repeater item field must be an object');
    }
    const candidate = itemField as unknown as ResourceRepeaterItemField;
    validateFieldIdentity(candidate, seen, 'repeater item field', REPEATER_ITEM_TYPES);
    if (candidate.type === 'slider') {
      validateSliderBounds(candidate, 'repeater slider item field');
    }
    validateOptions(candidate);
  }
}

/** Validate a `formset` field's row fields and `minItems`/`maxItems` bounds. */
function validateFormset(field: ResourceField): void {
  const config: unknown = field.formset;
  if (!isRecord(config)) {
    throw invalid('formset config must be an object');
  }
  validateItemBounds(config, 'formset');
  const minItems = config['minItems'] ?? 0;
  const maxItems = config['maxItems'] ?? DEFAULT_MAX_REPEATER_ITEMS;
  if (typeof minItems !== 'number' || !Number.isSafeInteger(minItems) || minItems < 0) {
    throw invalid('formset minItems must be a non-negative integer');
  }
  if (minItems > (maxItems as number)) {
    throw invalid('formset minItems must not exceed maxItems');
  }
  if (field.repeater !== undefined) {
    throw invalid('repeater field must not declare both repeater and formset configs');
  }
  const seen = new Set<string>();
  for (const rowField of config['fields'] as readonly unknown[]) {
    if (!isRecord(rowField)) {
      throw invalid('formset item field must be an object');
    }
    const candidate = rowField as unknown as ResourceField;
    validateFieldIdentity(candidate, seen, 'formset item field', FIELD_TYPES);
    if (candidate.type === 'repeater') {
      throw invalid('formset item field must not be a repeater');
    }
  }
}

/** Validate select/radio options; only those two types may declare them. */
function validateOptions(field: Pick<ResourceField, 'type' | 'options'>): void {
  if (field.type !== 'radio' && field.options === undefined) return;
  if (field.type !== 'select' && field.type !== 'radio') {
    throw invalid('resource field options are only valid for select or radio fields');
  }
  validateSelectOptions(field.options, `${field.type} options`);
}
