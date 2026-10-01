/**
 * The data engine: a SQL-level contract (`Engine`, `Conn`, `TransactionConn`)
 * over SQLite (node:sqlite), PostgreSQL (`pg`) and MariaDB (`mysql2`). This
 * directory is the only place in `@jsails/database` that imports TypeORM, and
 * nothing it exports names a TypeORM type.
 *
 * ## Spike result (DAT-02, TypeORM 1.1.1)
 *
 * Exit criteria, written before the spike, each on PostgreSQL 17, MariaDB
 * 11.4 and SQLite 3.54 (Node 26): (1) TypeORM's QueryBuilder renders the
 * statement shapes the data layer needs in table-name mode (no entity
 * metadata) with every value as a parameter; (2) a generated key comes back
 * on insert; (3) savepoints work; (4) MariaDB reports matched, not changed,
 * rows; (5) driver error codes are reachable; (6) a statement timeout can be
 * set per connection.
 *
 * Results:
 *
 * 1. Failed. Select, insert, upsert, update and delete render, but on SQLite
 *    numeric parameters are spliced into the SQL as literals (`WHERE t.id >
 *    1`, `VALUES (?, 1)`), and `LIMIT`/`OFFSET` are spliced on every driver,
 *    so the text changes with the values (no statement reuse, no stable
 *    ledger shapes). Predicates are strings in QueryBuilder, so the predicate
 *    tree (`IN`, `EXISTS`, row values, null tests) would be rendered by the
 *    engine anyway. `setLock` throws on SQLite.
 * 2. Failed. In table-name mode `.returning()` is dropped without an error on
 *    PostgreSQL and MariaDB (`INSERT ... VALUES ($1)` with no `RETURNING`)
 *    and throws on SQLite, whose driver reports `RETURNING` unsupported
 *    although SQLite has it since 3.35. Hand-written `INSERT ... RETURNING`
 *    works on all three, MariaDB included.
 * 3. Passed: `SAVEPOINT`, `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT`
 *    behave the same on all three.
 * 4. Passed: mysql2's default flags include `FOUND_ROWS`; an `UPDATE` that
 *    changes no value reports the rows it matched.
 * 5. Passed through `QueryFailedError.driverError`, but that error also
 *    carries the parameter values, and `QueryRunner.query` drops
 *    PostgreSQL's command tag, so a read cannot be told from a write.
 * 6. Passed: PostgreSQL's `statement_timeout` connection parameter (SQLSTATE
 *    57014) and MariaDB's `max_statement_time` session variable (errno 1969,
 *    which also cancels writes).
 *
 * Decision, as the plan's fallback provides: the engine renders every shape
 * itself (`render.ts`) behind the same `compile()` contract, quoting and
 * numbering placeholders exactly as TypeORM's drivers do (a test pins the two
 * together). TypeORM supplies driver injection, pool construction and
 * connection checkout through query runners, and on SQLite opens and closes
 * the node:sqlite handle through the `better-sqlite3` driver's `driver`
 * option. Statements run on the checked-out driver connection.
 */

export {
  MEMORY_DATABASE,
  resolveDatabaseConfig,
  type DatabaseConfig,
  type DatabaseOptions,
  type ResolveDatabaseConfigContext,
  type ServerConnection,
  type SslMode,
  type SslOptions,
} from './config.js';
export type {
  Conn,
  Dialect,
  Engine,
  IsolationLevel,
  QueryOptions,
  QueryResult,
  Row,
  Savepoint,
  SqlValue,
  TransactionConn,
  TransactionOptions,
} from './contract.js';
export { createEngine, type CreateEngineOptions } from './create-engine.js';
export {
  DatabaseError,
  isDatabaseError,
  type DatabaseErrorCode,
  type DatabaseErrorDetail,
} from './database-error.js';
export {
  createQueryLedger,
  currentQueryLedger,
  statementShape,
  withQueryLedger,
  type QueryLedger,
  type QueryLedgerOptions,
  type QueryRecord,
  type RepeatedShape,
} from './query-ledger.js';
export { BIND_LIMITS, compileStatement, quoteIdentifier } from './render.js';
export type { ConnectionErrorListener } from './server/server-engine.js';
export { MAX_READ_TRANSACTIONS } from './sqlite/sqlite-engine.js';
export type {
  Assignment,
  ColumnRef,
  Comparison,
  CompiledStatement,
  DeleteStatement,
  InsertStatement,
  OnConflict,
  OrderTerm,
  Predicate,
  RowComparison,
  SelectColumn,
  SelectStatement,
  Statement,
  TableRef,
  UpdateStatement,
  WindowLimit,
} from './statement.js';
export { VERSION_FLOORS } from './version-floor.js';
