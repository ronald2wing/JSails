/**
 * The two value-free errors of the model layer: {@link ModelSpecError} for a
 * declaration that cannot be lowered portably, and {@link ColumnValueError}
 * for an application value (or a stored value) a portable type cannot carry
 * losslessly. Messages are fixed per code; `context` holds only schema
 * identifiers (model, table, property, column, dialect), never a value.
 */

import { JsailsError } from 'jsails/errors';

/** Machine-readable reason for a {@link ModelSpecError}. */
export type ModelSpecErrorCode =
  // The declaration's shape.
  | 'invalid_spec'
  | 'invalid_identifier'
  | 'invalid_type'
  | 'unknown_column'
  | 'duplicate_column'
  | 'invalid_default'
  // Keys and relations.
  | 'invalid_primary_key'
  | 'invalid_relation'
  | 'unresolved_relation'
  // Indexes and tenancy.
  | 'invalid_index'
  | 'duplicate_index'
  | 'unindexable_column'
  | 'index_too_wide'
  | 'invalid_tenant'
  | 'unique_without_tenant'
  // Encryption.
  | 'invalid_encryption'
  | 'encrypted_not_indexable'
  // Physical limits.
  | 'row_too_wide'
  | 'already_defined';

const SPEC_MESSAGES: Readonly<Record<ModelSpecErrorCode, string>> = Object.freeze({
  invalid_spec: 'the model spec has an unknown or malformed field',
  invalid_identifier:
    'a table, column or index name is not a lowercase snake_case identifier of at most 63 characters',
  invalid_type: 'a column type is not a portable type, or its parameters are out of range',
  unknown_column: 'the spec names a column it does not declare',
  duplicate_column: 'two properties lower to the same column name',
  invalid_default: 'a column default is not a value its type can carry',
  invalid_primary_key: 'the primary key is missing, nullable, or of a type that cannot be a key',
  invalid_relation: 'a relation is malformed or disagrees with the model it names',
  unresolved_relation:
    'a relation target is not a model or table defined with defineModel or defineTable',
  invalid_index: 'an index is malformed',
  duplicate_index: 'two indexes have the same name, or the same columns and uniqueness',
  unindexable_column: 'an index names a column whose type cannot be indexed on every dialect',
  index_too_wide: 'an index key can exceed the smallest key size of the supported dialects',
  invalid_tenant: 'the tenant column is missing, nullable, encrypted, or not a key-typed column',
  unique_without_tenant:
    'a unique index of a tenant-scoped model does not include the tenant column',
  invalid_encryption: 'an encrypted column has an unsupported type or options',
  encrypted_not_indexable:
    'an encrypted column is indexed, or its deterministic envelope exceeds the index key size',
  row_too_wide: 'the columns of the table can exceed the row size of a supported dialect',
  already_defined: 'the class or table is already defined as a model',
});

const SPEC_SUGGESTIONS: Partial<Record<ModelSpecErrorCode, string>> = {
  invalid_type:
    'use a portable type from `column`: id, string, text, integer, bigint, decimal, float, boolean, timestamp, date, time, json, uuid, binary',
  unique_without_tenant:
    'add the tenant column to the index, or mark it `global: true` when the value is unique across tenants',
  invalid_identifier: 'name it in lowercase snake_case, or set `column` to such a name',
};

/** Schema identifiers that locate a {@link ModelSpecError}; never a value. */
export interface ModelSpecErrorDetail {
  /** The model (class name, or table for `defineTable`). */
  readonly model?: string;
  /** The offending property, relation, index, or spec field. */
  readonly field?: string;
  /** The dialect the failure applies to, when only one does. */
  readonly dialect?: string;
}

/** A model declaration that cannot be lowered portably. */
export class ModelSpecError extends JsailsError {
  readonly code: ModelSpecErrorCode;
  readonly model: string | undefined;
  readonly field: string | undefined;

  constructor(code: ModelSpecErrorCode, detail: ModelSpecErrorDetail = {}) {
    const context: Record<string, string> = {};
    if (detail.model !== undefined) context.model = detail.model;
    if (detail.field !== undefined) context.field = detail.field;
    if (detail.dialect !== undefined) context.dialect = detail.dialect;
    const where = [detail.model, detail.field].filter((part) => part !== undefined).join('.');
    const suggestion = SPEC_SUGGESTIONS[code];
    super(
      `${SPEC_MESSAGES[code]}${where === '' ? '' : ` (${where})`}`,
      suggestion === undefined ? { context } : { context, suggestion },
    );
    this.code = code;
    this.model = detail.model;
    this.field = detail.field;
  }
}

/** Machine-readable reason for a {@link ColumnValueError}. */
export type ColumnValueErrorCode =
  /** The value is not of the column's application type, or not in a form the type accepts. */
  | 'invalid_value'
  /** A string or binary value is longer than the column. */
  | 'too_long'
  /** A number, date or time is outside the type's portable range. */
  | 'out_of_range'
  /** A decimal has more fraction digits than the column's scale (it would be rounded). */
  | 'too_precise'
  /** An `id` value read from the database is above `Number.MAX_SAFE_INTEGER`. */
  | 'unsafe_integer'
  /** A value read from the database is not one the column's type writes. */
  | 'invalid_stored_value';

const VALUE_MESSAGES: Readonly<Record<ColumnValueErrorCode, string>> = Object.freeze({
  invalid_value: 'the value is not of the column type, or not in a form the type accepts',
  too_long: 'the value is longer than the column allows',
  out_of_range: 'the value is outside the range the column type carries on every dialect',
  too_precise: 'the decimal has more fraction digits than the column scale',
  unsafe_integer: 'a stored id is above Number.MAX_SAFE_INTEGER and cannot be read as a number',
  invalid_stored_value: 'the database returned a value the column type does not write',
});

/** A value a portable type cannot carry losslessly, on the way in or out. */
export class ColumnValueError extends JsailsError {
  readonly code: ColumnValueErrorCode;
  /** The portable type kind of the column. */
  readonly type: string;
  /** The property, when the codec was built for one column. */
  readonly field: string | undefined;

  constructor(code: ColumnValueErrorCode, type: string, field?: string) {
    const context: Record<string, string> = { type };
    if (field !== undefined) context.field = field;
    super(`${VALUE_MESSAGES[code]} (${field === undefined ? type : `${field}: ${type}`})`, {
      context,
    });
    this.code = code;
    this.type = type;
    this.field = field;
  }
}
