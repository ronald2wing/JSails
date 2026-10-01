/**
 * Structural checks for the frozen descriptors the admin panel composes: what
 * a page, resource, admin plugin, widget, chart, notice, action, relation
 * manager, or navigation item must look like, and the one list validator every
 * panel option and plugin contribution goes through.
 *
 * Descriptors are plain frozen objects produced by `define*` factories, so a
 * shape check (the required fields and their types) is the whole contract: a
 * hand-built object with the same fields is accepted on purpose.
 */

import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError, type AdminDefinitionErrorCode } from './errors.js';

/** The required fields of a descriptor, each with its expected `typeof`. */
export type DescriptorShape = Readonly<Record<string, 'string' | 'function'>>;

/** An admin page descriptor. */
export const PAGE_SHAPE: DescriptorShape = Object.freeze({
  slug: 'string',
  label: 'string',
  render: 'function',
});

/** A resource descriptor. */
export const RESOURCE_SHAPE: DescriptorShape = Object.freeze({
  slug: 'string',
  label: 'string',
  list: 'function',
});

/** An admin plugin descriptor. */
export const ADMIN_PLUGIN_SHAPE: DescriptorShape = Object.freeze({
  id: 'string',
  register: 'function',
});

/** A dashboard widget or chart descriptor. */
export const CARD_SHAPE: DescriptorShape = Object.freeze({
  name: 'string',
  label: 'string',
  render: 'function',
});

/** A notice descriptor. */
export const NOTICE_SHAPE: DescriptorShape = Object.freeze({
  code: 'string',
  level: 'string',
  message: 'string',
});

/** An admin action descriptor. */
export const ACTION_SHAPE: DescriptorShape = Object.freeze({
  name: 'string',
  label: 'string',
  run: 'function',
});

/** A relation manager descriptor. */
export const RELATION_MANAGER_SHAPE: DescriptorShape = Object.freeze({
  name: 'string',
  label: 'string',
  foreignKey: 'string',
  list: 'function',
});

/** A free-form navigation item. */
export const NAVIGATION_ITEM_SHAPE: DescriptorShape = Object.freeze({
  label: 'string',
  href: 'string',
});

/** Whether `value` is an object carrying every field of `shape` with the expected type. */
export function hasShape(value: unknown, shape: DescriptorShape): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(shape).every(([field, type]) => typeof value[field] === type);
}

/** Options for {@link resolveUniqueList}. */
export interface UniqueListOptions {
  /** The error code raised for a malformed list or entry. */
  readonly code: AdminDefinitionErrorCode;
  /** The human name of the list, used in the value-free messages. */
  readonly label: string;
  /** The field whose value must be unique across the list. */
  readonly key: string;
  /** The required fields of each entry. */
  readonly shape: DescriptorShape;
}

/**
 * Validate an optional descriptor list: every entry must match `shape` and the
 * `key` field must be unique across entries. Returns a frozen copy, or
 * `undefined` when the list was omitted. A duplicate raises `duplicate_name`;
 * every other failure raises `options.code`.
 */
export function resolveUniqueList<T>(
  value: unknown,
  options: UniqueListOptions,
): readonly T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AdminDefinitionError(
      options.code,
      `${options.label} must be an array of descriptors`,
    );
  }
  const seen = new Set<unknown>();
  for (const entry of value) {
    if (!hasShape(entry, options.shape)) {
      throw new AdminDefinitionError(options.code, `${options.label} must be descriptors`);
    }
    const key = (entry as Record<string, unknown>)[options.key];
    if (seen.has(key)) {
      throw new AdminDefinitionError(
        'duplicate_name',
        `${options.label} must have a unique ${options.key}`,
      );
    }
    seen.add(key);
  }
  return Object.freeze([...(value as T[])]);
}
