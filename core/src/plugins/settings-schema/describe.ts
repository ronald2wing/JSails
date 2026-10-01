/**
 * `describeSettings`: project a parsed {@link SettingsSchema} into the field
 * descriptors a settings form renders, one per property in schema order.
 *
 * The projection reads the schema only, never a saved value, so a form built
 * from it cannot echo a secret: a `secret` field has no default by the schema
 * rules, and its control tells the renderer to leave the input blank.
 */

import type { SettingsField, SettingsSchema } from './schema.js';

/**
 * The form control a field renders as.
 *
 * @public
 */
export type SettingsFieldControl =
  | 'text'
  | 'email'
  | 'uri'
  | 'textarea'
  | 'secret'
  | 'select'
  | 'number'
  | 'integer'
  | 'checkbox'
  | 'list'
  | 'multiselect';

/**
 * One form field, as {@link describeSettings} projects it.
 *
 * @public
 */
export interface SettingsFieldDescriptor {
  /** The settings key. */
  readonly key: string;
  /** The control to render. */
  readonly control: SettingsFieldControl;
  /** The field `title`, or the key when the schema gives none. */
  readonly label: string;
  /** The field `description`, when the schema gives one. */
  readonly description?: string;
  /** Whether the schema lists the key in `required`. */
  readonly required: boolean;
  /** The schema default, when there is one (never for a secret). */
  readonly default?: string | number | boolean | readonly string[];
  /** The allowed values of a `select` or `multiselect`. */
  readonly options?: readonly string[];
  /** Number bounds. */
  readonly minimum?: number;
  readonly maximum?: number;
  /** The longest accepted string (of the field, or of each list item). */
  readonly maxLength?: number;
  /** List length bounds. */
  readonly minItems?: number;
  readonly maxItems?: number;
}

function controlOf(field: SettingsField): SettingsFieldControl {
  switch (field.type) {
    case 'string':
      if (field.enum !== undefined) return 'select';
      return field.format ?? 'text';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'checkbox';
    case 'array':
      return field.items.enum === undefined ? 'list' : 'multiselect';
  }
}

function constraintsOf(field: SettingsField): Partial<SettingsFieldDescriptor> {
  switch (field.type) {
    case 'string':
      return {
        ...(field.enum === undefined ? {} : { options: field.enum }),
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
      };
    case 'number':
    case 'integer':
      return {
        ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
        ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      };
    case 'boolean':
      return {};
    case 'array':
      return {
        ...(field.items.enum === undefined ? {} : { options: field.items.enum }),
        ...(field.items.maxLength === undefined ? {} : { maxLength: field.items.maxLength }),
        ...(field.minItems === undefined ? {} : { minItems: field.minItems }),
        ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }),
      };
  }
}

/**
 * Project `schema` into frozen form descriptors, in property order.
 *
 * @public
 */
export function describeSettings(schema: SettingsSchema): readonly SettingsFieldDescriptor[] {
  const required = new Set(schema.required);
  return Object.freeze(
    Object.entries(schema.properties).map(([key, field]) =>
      Object.freeze({
        key,
        control: controlOf(field),
        label: field.title ?? key,
        ...(field.description === undefined ? {} : { description: field.description }),
        required: required.has(key),
        ...(field.default === undefined ? {} : { default: field.default }),
        ...constraintsOf(field),
      }),
    ),
  );
}
