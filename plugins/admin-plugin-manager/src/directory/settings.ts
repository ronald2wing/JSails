/**
 * Settings-schema projection: a pure, dependency-free translation of a plugin
 * manifest's `settingsSchema` into a bounded form descriptor list.
 *
 * The admin settings page already interprets a `settingsSchema` for rendering;
 * this module is the reusable, renderer-free half of that rule set, so an
 * install-planning or UI-preview caller can know which fields are editable
 * without pulling in the admin/Preact surface. Only the `string`, `number`, and
 * `boolean` shorthand forms (a bare type string, or a `{ type, label?, default? }`
 * object) are editable; every other shape is projected as read-only (`unknown`).
 *
 * The projection is **value-free by design**: unknown-shaped field values are
 * never read or echoed (they may carry secrets), and editable fields surface
 * only their declared type, label, and scalar default from the schema — never a
 * stored setting value. Failed schema input raises a value-free
 * {@link SettingsProjectionError}.
 */

import { isForbiddenKey, isRecord } from 'jsails/plugin-sdk';

/** Upper bound on projected fields (defends against a pathological schema). */
const MAX_SETTINGS_FIELDS = 100;

/** A projected field type; `unknown` is the read-only marker. */
export type SettingsFieldType = 'string' | 'number' | 'boolean' | 'unknown';

/** One projected settings field. */
export interface SettingsFieldDescriptor {
  /** The schema key; a forbidden prototype key is never exposed as editable. */
  readonly key: string;
  /** The editable shorthand type, or `unknown` for a read-only field. */
  readonly type: SettingsFieldType;
  /** Display label (the schema `label`, else the key). */
  readonly label: string;
  /** Declared scalar default, only when the schema authors a matching one. */
  readonly defaultValue?: string | number | boolean;
}

/** Raised when `projectSettingsSchema` receives a malformed schema. */
export class SettingsProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsProjectionError';
  }
}

/**
 * Project a manifest `settingsSchema` into a frozen, bounded descriptor list.
 * Field order follows the schema's own insertion order (deterministic for a
 * JSON-parsed schema). Returns `[]` for an absent schema.
 */
export function projectSettingsSchema(
  schema: Readonly<Record<string, unknown>> | undefined,
): readonly SettingsFieldDescriptor[] {
  if (schema === undefined) {
    return Object.freeze([]);
  }
  if (!isRecord(schema)) {
    throw new SettingsProjectionError('settings schema must be an object');
  }
  const fields = Object.entries(schema)
    .slice(0, MAX_SETTINGS_FIELDS)
    .map(([key, raw]) => Object.freeze(projectField(key, raw)));
  return Object.freeze(fields);
}

/**
 * Project one schema entry. A forbidden prototype key, a bare
 * `string`/`number`/`boolean` shorthand, an unrecognized shape, or an
 * unrecognized `type` all project as `unknown` (read-only); never read `raw`.
 */
function projectField(key: string, raw: unknown): SettingsFieldDescriptor {
  if (isForbiddenKey(key)) {
    return { key, type: 'unknown', label: key };
  }
  if (raw === 'string' || raw === 'number' || raw === 'boolean') {
    return { key, type: raw, label: key };
  }
  if (isRecord(raw)) {
    const type = raw['type'];
    if (type === 'string' || type === 'number' || type === 'boolean') {
      const label = typeof raw['label'] === 'string' ? raw['label'] : key;
      const defaultValue = raw['default'];
      if (type === 'string' && typeof defaultValue === 'string') {
        return { key, type, label, defaultValue };
      }
      if (type === 'number' && typeof defaultValue === 'number') {
        return { key, type, label, defaultValue };
      }
      if (type === 'boolean' && typeof defaultValue === 'boolean') {
        return { key, type, label, defaultValue };
      }
      return { key, type, label };
    }
  }
  return { key, type: 'unknown', label: key };
}
