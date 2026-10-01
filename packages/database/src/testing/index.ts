/**
 * `@jsails/database/testing`: the data layer's testing surface.
 *
 * - Test databases: `createTestDataSource` (a temp-file SQLite by default,
 *   `:memory:`, or a server database checked by the test-database guard),
 *   per-worker names (`testDatabaseName`), and the run's matrix database
 *   (`matrixTestDatabase`).
 * - Isolation: `withTestTransaction`, and `transactionalTests`, which wraps
 *   every node:test test in it unless the test declares `commits: true`.
 * - Statement budgets: `countStatements`.
 * - Test data: fixtures (`defineFixture`, `loadFixtures`), factories
 *   (`defineFactory`) and seeders (`defineSeeder`, `runSeeders`), built on
 *   `build`, `create` and `insertAll`, so they join the ambient transaction.
 * - `storeContract`, the harness every package store states its upsert,
 *   uniqueness, expiry and concurrency semantics in.
 * - The three-driver test matrix (SQLite, MariaDB, PostgreSQL) the data
 *   layer's conformance and regression suites run on.
 */

export { countStatements } from './count-statements.js';
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
export { defineFactory, type Factory, type FactoryGenerator } from './factories.js';
export { defineFixture, loadFixtures, type Fixture } from './fixtures.js';
export {
  defineSeeder,
  runSeeders,
  type RunSeedersOptions,
  type Seeder,
  type SeederContext,
} from './seeders.js';
export {
  storeContract,
  type StoreContractCases,
  type StoreContractContext,
  type StoreContractOptions,
  type TestClock,
} from './store-contract.js';
export {
  createTestDataSource,
  matrixTestDatabase,
  testDatabaseName,
  type CreateTestDataSourceOptions,
  type TestDatabase,
  type TestDataSource,
  type TestServerDatabase,
} from './test-data-source.js';
export { TestingErrors } from './testing-errors.js';
export {
  transactionalTests,
  type TransactionalTest,
  type TransactionalTestFn,
  type TransactionalTestOptions,
  type TransactionalTests,
  type TransactionalTestSource,
} from './transactional-tests.js';
export { withTestTransaction } from '../transaction/run-transaction.js';
