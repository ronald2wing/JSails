/**
 * Plugin settings schema — the closed JSON Schema subset a manifest's
 * `settings` uses: reading a schema (`schema.ts`), validating a value against
 * it (`validate.ts`), and projecting it into form fields (`describe.ts`).
 */

export {
  parseSettingsSchema,
  type SettingsSchema,
  type SettingsField,
  type StringSettingsField,
  type NumberSettingsField,
  type BooleanSettingsField,
  type StringListSettingsField,
  type StringListItems,
  type SettingsStringFormat,
  type SettingsSchemaParseResult,
} from './schema.js';

export { type SettingsIssue } from './value-check.js';

export { validateSettings, type SettingsValidationResult } from './validate.js';

export {
  describeSettings,
  type SettingsFieldControl,
  type SettingsFieldDescriptor,
} from './describe.js';
