/**
 * Select options: the `{ value, label }` choice list shared by `select` and
 * `radio` fields and by a column's drop-down filter.
 */

import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError } from '../errors.js';

/** A single select/radio option: a machine value plus a human label. */
export interface ResourceSelectOption {
  readonly value: string;
  readonly label: string;
}

/** Validate a non-empty option list with unique, non-empty values and labels. */
export function validateSelectOptions(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AdminDefinitionError('invalid_resource', `${label} must be a non-empty array`);
  }
  const seen = new Set<string>();
  for (const option of value) {
    if (!isRecord(option)) {
      throw new AdminDefinitionError('invalid_resource', `${label} entries must be objects`);
    }
    if (typeof option['value'] !== 'string' || option['value'].trim() === '') {
      throw new AdminDefinitionError(
        'invalid_resource',
        `${label} values must be non-empty strings`,
      );
    }
    if (typeof option['label'] !== 'string' || option['label'].trim() === '') {
      throw new AdminDefinitionError(
        'invalid_resource',
        `${label} labels must be non-empty strings`,
      );
    }
    if (seen.has(option['value'])) {
      throw new AdminDefinitionError('invalid_resource', `${label} values must be unique`);
    }
    seen.add(option['value']);
  }
}

/** Deep-freeze a defensive copy of an option list. */
export function freezeSelectOptions(
  options: readonly ResourceSelectOption[],
): readonly ResourceSelectOption[] {
  return Object.freeze(
    options.map((option) => Object.freeze({ value: option.value, label: option.label })),
  );
}
