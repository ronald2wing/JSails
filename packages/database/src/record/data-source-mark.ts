/**
 * The mark every `JsailsDataSource` carries under a `Symbol.for` key, which
 * every copy of this package in the process reads. Model bindings are shared
 * between copies, so a model belongs to one open data source in the process
 * whichever copy bound it; a data source's internals and engine stay with the
 * copy that made it. A copy that meets a data source it did not make tells it
 * apart by this mark and refuses it as `data_source.duplicate_package`,
 * rather than taking it for a malformed argument or for an engine.
 */

import { DataSourceErrors } from './record-errors.js';

const MARK = Symbol.for('jsails.database.dataSource.v1');

/** Mark `dataSource` as a data source of some copy of this package. */
export function markDataSource(dataSource: object): void {
  Object.defineProperty(dataSource, MARK, { value: true });
}

/** Whether `value` is a data source made by any copy of this package. */
export function isMarkedDataSource(value: unknown): boolean {
  return value !== null && typeof value === 'object' && MARK in value;
}

/** The failure for a data source another copy of this package made. */
export function duplicatePackage(): Error {
  return new DataSourceErrors.Error('duplicate_package');
}
