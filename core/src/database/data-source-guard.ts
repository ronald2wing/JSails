/**
 * The initialized-DataSource guard shared by the database helpers that take a
 * caller-supplied data source (`factory.create`, `runSeeders`). Each caller
 * names itself and supplies its own value-free error class.
 */

import { DataSource } from 'typeorm';

export function assertInitializedDataSource(
  dataSource: unknown,
  caller: string,
  toError: (message: string) => Error,
): DataSource {
  if (!(dataSource instanceof DataSource)) {
    throw toError(`${caller} requires an initialized TypeORM DataSource`);
  }
  if (!dataSource.isInitialized) {
    throw toError(`${caller} requires an initialized data source (call initialize() first)`);
  }
  return dataSource;
}
