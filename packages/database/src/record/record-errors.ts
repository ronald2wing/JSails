/**
 * The error codes of data sources and records: `data_source.*` for binding a
 * model, a closed data source, a data source of another copy of the package
 * and the grants of a model-set handle, and
 * `record.*` for a record that is invalid, missing, stale, or used outside
 * its contract. Every message is fixed text; the context holds only model
 * names and fixed words, never a key, a value or SQL.
 */

import { defineErrors, type ErrorIssue, type ErrorRegistry, type Payload } from 'jsails/errors';

const DATA_SOURCE_ERRORS = {
  already_bound: {
    kind: 'internal',
    message: 'model {model} is already bound to an open data source',
    context: { model: 'identifier' },
    suggestion: 'close the other data source first; a model belongs to one data source at a time',
  },
  not_bound: {
    kind: 'internal',
    message: 'model {model} is not bound to a data source',
    context: { model: 'identifier' },
    suggestion: 'list the model in the models of the database() plugin or of a JsailsDataSource',
  },
  not_a_model: {
    kind: 'internal',
    message: 'a data source model was not defined with defineModel or defineTable',
  },
  closed: {
    kind: 'internal',
    message: 'the data source is closed',
  },
  invalid_options: {
    kind: 'internal',
    message: 'data source option {field} is invalid',
    context: { field: 'identifier' },
  },
  duplicate_package: {
    kind: 'internal',
    message: 'the data source was made by another copy of @jsails/database',
    suggestion:
      'install one copy of @jsails/database (npm ls @jsails/database) so the application and its plugins share it',
  },
  not_granted: {
    kind: 'forbidden',
    message: 'the data handle has no {access} grant on model {model}',
    context: { model: 'identifier', access: ['read', 'write'] },
  },
} as const;

/**
 * Data source codes: a model bound twice or not at all, an argument that is
 * not a model, a closed data source, malformed options, a data source of
 * another copy of the package, and a model a model-set handle was not
 * granted.
 */
export const DataSourceErrors: ErrorRegistry<'data_source', typeof DATA_SOURCE_ERRORS> =
  defineErrors('data_source', DATA_SOURCE_ERRORS);

const RECORD_ERRORS = {
  invalid: {
    kind: 'invalid',
    audience: 'client',
    message: 'The record is invalid.',
    context: { model: 'identifier' },
    payload: { expose: ['issues'] } as Payload<{ readonly issues: readonly ErrorIssue[] }>,
  },
  not_found: {
    kind: 'not_found',
    message: 'no {model} record has the given key',
    context: { model: 'identifier' },
  },
  stale_record: {
    kind: 'conflict',
    message: 'the {model} record was changed or deleted since it was loaded',
    context: { model: 'identifier' },
    suggestion: 'reload the record and apply the change again',
  },
  not_persisted: {
    kind: 'internal',
    message: 'the {model} record is not saved, so it cannot be {operation}',
    context: { model: 'identifier', operation: ['destroyed', 'reloaded'] },
  },
  invalid_key: {
    kind: 'internal',
    message: 'the key given for {model} does not name its primary key',
    context: { model: 'identifier' },
  },
  not_a_record: {
    kind: 'internal',
    message: 'the record class was not defined with defineModel',
  },
  invalid_attachment: {
    kind: 'internal',
    message: 'attachment {attachment} of {model} is set to something other than a blob or null',
    context: { model: 'identifier', attachment: 'identifier' },
    suggestion:
      'write the bytes to the attachment disk first and set { key, contentType, byteSize }, or null to detach',
  },
  unknown_attachment: {
    kind: 'internal',
    message: 'model {model} declares no attachment of the given name',
    context: { model: 'identifier' },
  },
  invalid_relation: {
    kind: 'internal',
    message: 'relation {relation} of {model} holds something other than records of its target',
    context: { model: 'identifier', relation: 'identifier' },
  },
} as const;

/**
 * Record codes: a record its validation refused (with the issues, exposed to
 * the client), a key with no row, a write that matched no row (deleted, or
 * changed under optimistic locking), an operation that needs a saved record,
 * a malformed key, a record class without a model definition, an attachment
 * value that is not a blob or names no declared attachment, and an autosave
 * relation holding something other than records of its target.
 */
export const RecordErrors: ErrorRegistry<'record', typeof RECORD_ERRORS> = defineErrors(
  'record',
  RECORD_ERRORS,
);
