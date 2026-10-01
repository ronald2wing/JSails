/**
 * Records and data sources: `ApplicationRecord`, `JsailsDataSource` (one
 * database, its models bound to it, its engine private, its change feed),
 * the read-only in-memory `FileDataSource`, the model-set `dataHandle` for
 * gated plugins, the write pipeline's public parts (record hooks and
 * validation, set-write options, attachments), and the `data_source.*` and
 * `record.*` error codes.
 */

export { ApplicationRecord, type RecordClass, type RecordKey } from './application-record.js';
export { attachmentTable } from './attachment-table.js';
export {
  attachmentOf,
  type AttachmentBlob,
  type AttachmentDisk,
  type AttachmentOptions,
  type StoredAttachment,
} from './attachments.js';
export { dataHandle, type DataHandle, type DataHandleOptions } from './data-handle.js';
export { JsailsDataSource, type JsailsDataSourceOptions } from './data-source.js';
export {
  FileDataSource,
  type FileDataSourceModel,
  type FileDataSourceOptions,
} from './file-data-source.js';
export type {
  RecordBehavior,
  RecordHook,
  RecordHookContext,
  RecordHooks,
  RecordOperation,
} from './hooks.js';
export { DataSourceErrors, RecordErrors } from './record-errors.js';
export type { SetWriteOptions } from './set-writes.js';
export type { RecordValidator } from './validation.js';
