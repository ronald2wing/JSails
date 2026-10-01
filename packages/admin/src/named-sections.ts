/**
 * Named field sections: the shared descriptor behind tabs and wizard steps.
 *
 * A tab and a wizard step are the same thing, a named, labeled group of
 * resource field names; only their rendering differs. Both `defineTabs` and
 * `defineWizard` validate through {@link validateNamedSections} and resolve
 * their field coverage through {@link collectSectionFields}.
 */

import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError, type AdminDefinitionErrorCode } from './errors.js';
import type { ResourceField } from './resource/index.js';

/** One named group of resource field names. */
export interface NamedSection {
  /** Section identifier, unique within the set. */
  readonly name: string;
  /** Human label rendered for the section. */
  readonly label: string;
  /**
   * Resource field names this section groups. Each name must reference a
   * resource-level field; a name that does not match any field is reported at
   * render time.
   */
  readonly fields: readonly string[];
}

/** Options for {@link validateNamedSections}. */
export interface ValidateNamedSectionsOptions {
  /** The error code raised for a malformed section list. */
  readonly code: AdminDefinitionErrorCode;
  /** The human name of one section (`tab`, `wizard step`), used in messages. */
  readonly label: string;
}

/**
 * Validate a non-empty section list with unique names and non-empty string
 * field lists, returning a deeply frozen copy.
 */
export function validateNamedSections(
  value: unknown,
  options: ValidateNamedSectionsOptions,
): readonly NamedSection[] {
  const { code, label } = options;
  if (!Array.isArray(value) || value.length === 0) {
    throw new AdminDefinitionError(code, `${label}s must be a non-empty array`);
  }
  const seen = new Set<string>();
  const sections: NamedSection[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new AdminDefinitionError(code, `each ${label} must be an object`);
    }
    const { name, label: sectionLabel, fields } = entry;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new AdminDefinitionError(code, `${label} name must be a non-empty string`);
    }
    if (typeof sectionLabel !== 'string' || sectionLabel.trim() === '') {
      throw new AdminDefinitionError(code, `${label} label must be a non-empty string`);
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new AdminDefinitionError(code, `${label} fields must be a non-empty array`);
    }
    if (!fields.every((field) => typeof field === 'string')) {
      throw new AdminDefinitionError(code, `${label} field names must be strings`);
    }
    if (seen.has(name)) {
      throw new AdminDefinitionError('duplicate_name', `${label} names must be unique`);
    }
    seen.add(name);
    sections.push(
      Object.freeze({
        name,
        label: sectionLabel,
        fields: Object.freeze([...fields]),
      }),
    );
  }
  return Object.freeze(sections);
}

/** The field names a section set covers plus the names no resource field matches. */
export interface SectionFieldCoverage {
  /** Every field name referenced by any section. */
  readonly fields: ReadonlySet<string>;
  /** Referenced names with no matching resource field, in section order. */
  readonly missing: readonly string[];
}

/**
 * Collect the union of every section's field names and report the names that
 * match no resource-level field. Fields outside every section are the render
 * helpers' concern (tabs render them below the set; a wizard omits them).
 */
export function collectSectionFields(
  sections: readonly NamedSection[],
  resourceFields: readonly ResourceField[],
): SectionFieldCoverage {
  const known = new Set(resourceFields.map((field) => field.name));
  const fields = new Set<string>();
  const missing: string[] = [];
  for (const section of sections) {
    for (const name of section.fields) {
      if (!known.has(name)) {
        missing.push(name);
      }
      fields.add(name);
    }
  }
  return { fields, missing: Object.freeze(missing) };
}
