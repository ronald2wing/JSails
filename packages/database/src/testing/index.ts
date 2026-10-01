/**
 * `@jsails/database/testing`: the three-driver test matrix (SQLite, MariaDB,
 * PostgreSQL) that the data layer's conformance and regression suites run on.
 */

export {
  createMatrixDatabase,
  driverSkipReason,
  DriverMatrixError,
  forEachDriver,
  lastInFirstOut,
  matrixDriver,
  matrixServer,
  matrixServerUrl,
  openMatrixDataSource,
  type DriverMatrixContext,
  type DriverMatrixErrorCode,
  type ForEachDriverOptions,
  type MatrixDriver,
  type MatrixLifecycle,
  type MatrixLogger,
  type MatrixServer,
  type OpenMatrixDataSourceOptions,
} from './driver-matrix.js';
