/**
 * The field allowlist of a model resource: the one declaration every other
 * part derives from, and the rules it must satisfy.
 *
 * Nothing is exposed by default. A field reaches the API only when it is
 * declared here with an `access`, and it can be sorted, filtered, or searched
 * only when it opts in. That reverses the `jsails/api` filter defaults, where a
 * declared filter field is sortable and filterable unless it says otherwise.
 *
 * The rules close the ways a field list could leak more than it says:
 *
 * - every field is a real column, so a typo cannot silently expose nothing or
 *   something else;
 * - the `id` primary key is never writable;
 * - a write-only field (a password hash, a token) can never be sorted,
 *   filtered, or searched, because a range filter plus the page `count` would
 *   let a client read it back one comparison at a time;
 * - an encrypted column must be exposed by name, and is never queryable,
 *   because its ciphertext is non-deterministic and comparing it means nothing;
 * - a JSON column is never queryable, and only a text column is searchable.
 */

import type {
  FilterFieldOptions,
  FilterOperator,
  FilterOptions,
  Schema,
  SerializerField,
  SerializerFields,
  SortClause,
} from 'jsails/api';

import type { ColumnFacts } from './model-columns.js';
import { ModelResourceError } from './resource-error.js';

/** Who may see or set a field: `read` is response-only, `write` request-only. */
export type FieldAccess = 'read' | 'write' | 'readWrite';

/** How a field may be filtered. Its presence makes the field filterable. */
export interface ModelFieldFilter {
  /** Value coercion for `filter[...]`; defaults to `string`. */
  readonly type?: FilterFieldOptions['type'];
  /** Allowed operators; defaults to `['eq']`. */
  readonly operators?: readonly FilterOperator[];
}

/** One declared field. */
export interface ModelField<T = unknown> {
  readonly schema: Schema<T>;
  readonly access: FieldAccess;
  /** Whether `?sort=` may name the field. Defaults to `false`. */
  readonly sort?: boolean;
  /** How `?filter[...]` may use the field. Absent means not filterable. */
  readonly filter?: ModelFieldFilter;
  /** Whether `?search=` matches the field. Text columns only. Defaults to `false`. */
  readonly search?: boolean;
}

/** The field allowlist, keyed by model property name. */
export type ModelFields = Readonly<Record<string, ModelField>>;

/** The serializer field a declared field becomes. */
export type SerializerFieldOf<F> = F extends { access: 'read'; schema: Schema<infer T> }
  ? { schema: Schema<T>; readOnly: true }
  : F extends { access: 'write'; schema: Schema<infer T> }
    ? { schema: Schema<T>; writeOnly: true }
    : F extends { schema: Schema<infer T> }
      ? Schema<T>
      : never;

/** The serializer fields a whole allowlist becomes. */
export type SerializerFieldsOf<F extends ModelFields> = {
  -readonly [K in keyof F]: SerializerFieldOf<F[K]>;
};

const ACCESS = new Set<string>(['read', 'write', 'readWrite']);

/** What the rules derive from a valid allowlist. */
export interface DerivedFields {
  readonly serializerFields: SerializerFields;
  readonly filters: FilterOptions;
  /** Fields a client may set. */
  readonly writable: ReadonlySet<string>;
  /** Fields `?search=` matches. */
  readonly searchable: readonly string[];
}

/** Validate an allowlist against the model's columns and derive its parts. */
export function deriveFields(
  fields: ModelFields,
  columns: ReadonlyMap<string, ColumnFacts>,
  encrypted: ReadonlySet<string>,
  exposeEncrypted: ReadonlySet<string>,
): DerivedFields {
  if (fields === null || typeof fields !== 'object' || Object.keys(fields).length === 0) {
    throw new ModelResourceError('invalid_fields', 'a model resource requires at least one field');
  }
  const serializerFields: Record<string, SerializerField<unknown>> = {};
  const filterFields: Record<string, FilterFieldOptions> = {};
  const writable = new Set<string>();
  const searchable: string[] = [];

  for (const [name, field] of Object.entries(fields)) {
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof field.schema?.validate !== 'function' ||
      !ACCESS.has(field.access)
    ) {
      throw new ModelResourceError(
        'invalid_field',
        'a field needs a schema and an access of read, write, or readWrite',
        name,
      );
    }
    const column = columns.get(name);
    if (column === undefined) {
      throw new ModelResourceError(
        'unknown_column',
        'a field must name a column of the model',
        name,
      );
    }
    const queryable = field.sort === true || field.filter !== undefined || field.search === true;
    if (column.primary && field.access !== 'read') {
      throw new ModelResourceError(
        'primary_key_writable',
        'the primary key must be read-only',
        name,
      );
    }
    if (field.access === 'write' && queryable) {
      throw new ModelResourceError(
        'writeonly_queryable',
        'a write-only field cannot be sorted, filtered, or searched',
        name,
      );
    }
    if (encrypted.has(name)) {
      if (!exposeEncrypted.has(name)) {
        throw new ModelResourceError(
          'encrypted_field',
          'an encrypted column must be listed in exposeEncrypted',
          name,
        );
      }
      if (queryable) {
        throw new ModelResourceError(
          'encrypted_queryable',
          'an encrypted column cannot be sorted, filtered, or searched',
          name,
        );
      }
    }
    if (column.kind === 'json' && queryable) {
      throw new ModelResourceError(
        'json_queryable',
        'a JSON column cannot be sorted, filtered, or searched',
        name,
      );
    }
    if (field.search === true && column.kind !== 'text') {
      throw new ModelResourceError('search_not_text', 'only a text column is searchable', name);
    }

    serializerFields[name] =
      field.access === 'read'
        ? { schema: field.schema, readOnly: true }
        : field.access === 'write'
          ? { schema: field.schema, writeOnly: true }
          : field.schema;
    if (field.access !== 'read') writable.add(name);
    if (field.search === true) searchable.push(name);
    if (field.sort === true || field.filter !== undefined) {
      filterFields[name] = {
        sortable: field.sort === true,
        filterable: field.filter !== undefined,
        ...(field.filter?.type === undefined ? {} : { type: field.filter.type }),
        ...(field.filter?.operators === undefined ? {} : { operators: field.filter.operators }),
      };
    }
  }

  return {
    serializerFields,
    filters: { fields: filterFields },
    writable,
    searchable,
  };
}

/** A default sort may name only sortable fields. */
export function assertDefaultSort(
  sorts: readonly SortClause[],
  filters: FilterOptions,
): readonly SortClause[] {
  for (const sort of sorts) {
    if (
      !Object.hasOwn(filters.fields, sort.field) ||
      filters.fields[sort.field]?.sortable !== true
    ) {
      throw new ModelResourceError(
        'invalid_sort',
        'a default sort may name only fields declared with sort: true',
        sort.field,
      );
    }
  }
  return Object.freeze(sorts.map((sort) => Object.freeze({ ...sort })));
}
