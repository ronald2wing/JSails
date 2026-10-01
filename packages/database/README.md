# @jsails/database

The JSails data layer, written fresh beside the old stack in `jsails/database` and replacing it at the data cutover. It is private and unpublished until apps reach it through the `database()` plugin. Today it holds the supported-driver list (`DATABASE_DRIVERS`: SQLite, MariaDB, PostgreSQL), the data engine, and the three-driver test matrix.

## The engine

The engine is the SQL-level layer everything above it builds on: plain SQL and plain values in, plain rows out. It is the only code in this package that imports TypeORM (a test enforces that), and none of its exports name a TypeORM type.

```ts
import { createEngine, resolveDatabaseConfig } from '@jsails/database';

const engine = await createEngine(resolveDatabaseConfig({ file: 'storage/app.sqlite' }));
const { sql, params } = engine.compile({
  kind: 'insert',
  table: 'posts',
  columns: ['title'],
  rows: [['Hello']],
  returning: ['id'],
});
const conn = await engine.lease();
try {
  const { rows } = await conn.query(sql, params);
} finally {
  await conn.release();
}
await engine.close();
```

- `Engine`: `dialect`, `serverVersion`, `bindLimit`, `lease()` (an autocommit connection), `begin({ readOnly?, isolation? })` (a connection inside a transaction, with `savepoint()`, `commit()` and `rollback()`), `compile(statement)` and `close()`.
- `Conn.query(sql, params, { origin })` returns `{ rows, affected, insertId? }`. `affected` counts written rows only, and an `UPDATE` counts the rows it matched on every dialect. A write with `RETURNING` counts the rows it returned. An upsert on MariaDB counts as MariaDB does (an updated row is 2, a row left as it was 1), and `RETURNING` with `ON CONFLICT DO NOTHING` is refused there, because MariaDB would also return the existing rows.
- When a failed statement ends the whole transaction on the server (a deadlock victim, or `RAISE(ROLLBACK)` on SQLite), every later statement and savepoint of that transaction fails with `transaction_aborted` and its `commit()` does too. MariaDB and SQLite would otherwise run what follows in autocommit mode, so the engine asks the session whether the transaction is still open after each failure there. PostgreSQL enforces the same itself.
- Statements (`Statement`) are plain data: select (columns, aggregates, a predicate tree with comparisons, `IN`, `IN (SELECT)`, `EXISTS`, row-value keyset comparison, null tests and `LIKE`, ordering with explicit null placement, limit and offset, row locks, and a per-partition window limit), multi-row insert with `RETURNING` and an `ON CONFLICT` action, update with values or increments, and delete. `UPDATE` and `DELETE` require a `where`; `{ op: 'true' }` is the explicit "every row". Every value is bound as a parameter, so a statement's SQL depends only on its shape.
- Values are normalised the same way on every dialect. Integers come back as `number`, or as `bigint` outside the safe range. Decimals, dates, times, timestamps and JSON come back as the server's text. Binary comes back as a `Uint8Array`, and booleans as `boolean` on PostgreSQL and `0`/`1` elsewhere. Turning these into application values is the codec layer's job.
- `DatabaseError` is the engine's one error class. Its `code` is classified from the driver's own code (`unique_violation`, `foreign_key_violation`, `not_null_violation`, `check_violation`, `deadlock`, `serialization_failure`, `lock_timeout`, `busy`, `statement_timeout`, `read_only`, `transaction_aborted`, `connection_failed`, `acquire_timeout`, `missing_dependency`, ...). `transient` marks failures where re-running the transaction may succeed. The message never carries SQL, values or credentials; `driverCode` and `constraint` carry only codes and schema names.
- The query ledger records every statement a connection runs in each ledger active in the async context: `createQueryLedger({ detail })`, `withQueryLedger(ledger, fn)`, and `currentQueryLedger()`. Without `detail` (the production setting) a ledger keeps only the count and the total time. With it, it also keeps each statement's SQL, origin and duration, and a shape whose literals and value lists are collapsed. A ledger never holds parameter values.

### Configuration: the `database()` options

`resolveDatabaseConfig(options, { env, root })` turns the `database()` plugin's options into the frozen `DatabaseConfig` an engine opens. Secrets come from the environment only. The options name the variables (`urlEnv`, default `DATABASE_URL`; `passwordEnv`, default `DATABASE_PASSWORD`; `migrationUrlEnv`, default `DATABASE_MIGRATION_URL`), and a URL written into the options may not carry a password. A URL in the environment wins over the options, so code can default to a SQLite file and a deployment can select a server.

- URLs: `postgres://` or `postgresql://`; `mariadb://` or `mysql://` (the same wire protocol; a server that is not MariaDB is refused when the engine opens); `sqlite:<path>` or `sqlite::memory:`. The one query parameter accepted is `sslmode` (`disable`, `require`, `verify-full`).
- Fields: `dialect`, `host`, `port`, `user`, `database`, `file`, `ssl` (`false`, `'require'`, `'verify'`, or `{ mode, ca }`), `pool.max` (10), `acquireTimeoutMs` (10000; 0 waits forever), `statementTimeoutMs` (30000; 0 disables), `connectTimeoutMs` (10000), and `busyTimeoutMs` (5000, SQLite).
- Unknown options are refused by name, so a misspelled key cannot be silently ignored. There is no `cache` option.

`createEngine(config, { purpose: 'migration' })` opens the one connection schema changes run on: `DATABASE_MIGRATION_URL` when set (a direct connection past a transaction pooler), else the main connection, with no statement timeout.

### Drivers and floors

SQLite runs on node:sqlite and needs no package. PostgreSQL needs `pg` and MariaDB needs `mysql2`. They are optional peers, loaded only when an engine for their dialect opens, and a missing one fails as `missing_dependency` naming the package. When an engine opens, it checks the server against the supported floor: MariaDB 10.6, PostgreSQL 14, SQLite 3.35. MySQL is not supported.

MariaDB is spoken over the text protocol, so its parameters are written into the statement before it is sent. The engine writes them itself, not mysql2: strings as `_utf8mb4 X'...'` hexadecimal literals, binary as `X'...'`, numbers as digits, so no `sql_mode` (`NO_BACKSLASH_ESCAPES` included) can turn a value into SQL. A `?` inside a literal or comment of a statement with parameters is refused.

Both server engines run every session in UTC. The statement timeout is PostgreSQL's `statement_timeout` and MariaDB's `max_statement_time`, and it cancels writes too. Through PgBouncer, allow the `options` and `statement_timeout` startup parameters (`ignore_startup_parameters`) or point `DATABASE_URL` at a session-mode pool.

### SQLite concurrency

node:sqlite is synchronous: every statement blocks the event loop while it runs. The engine therefore keeps a model that never makes a write transaction stall reads:

- One writer handle sits behind a FIFO lock. A write transaction holds the lock from `BEGIN IMMEDIATE` to its end, and an autocommit write holds it for one statement.
- One shared read-only handle serves autocommit reads. In WAL mode it reads the last commit and never waits for an open write transaction.
- Each read-only transaction gets a read-only handle of its own, opened on first need and reused, at most four at once. These never wait for the writer.
- `:memory:` is one handle with everything behind the lock.
- Another process holding the file's write lock is waited out asynchronously, with backoff, until `busyTimeoutMs`; then the write fails as `busy`. SQLite's own busy wait is off, because it would block the event loop.
- Files open with WAL, `synchronous = NORMAL`, foreign keys and defensive mode on. Integral numbers bind as SQLite INTEGERs: node:sqlite would bind them as REALs, which rounds 64-bit arithmetic and turns `7 / 2` into `3.5`. SQLite has no statement timeout, because a synchronous statement cannot be interrupted.

### Spike result: TypeORM in table-name mode

The engine began with a spike on TypeORM 1.1.1 against PostgreSQL 17, MariaDB 11.4 and SQLite 3.54. Its exit criteria were written beforehand: QueryBuilder renders every needed statement shape in table-name mode with every value as a parameter; a generated key comes back on insert; savepoints work; MariaDB reports matched rows; driver error codes are reachable; and a statement timeout can be set per connection.

- Rendering failed. On SQLite, QueryBuilder splices numeric parameters into the SQL as literals, and it splices `LIMIT`/`OFFSET` on every driver. Predicates are strings in QueryBuilder, so the predicate tree would be rendered by hand anyway, and `setLock` throws on SQLite.
- The generated key failed. Without entity metadata, `.returning()` is dropped silently on PostgreSQL and MariaDB, and it throws on SQLite, although SQLite has had `RETURNING` since 3.35. Hand-written `INSERT ... RETURNING` works on all three.
- Savepoints, matched rows (mysql2's default `FOUND_ROWS` flag), error codes and statement timeouts passed. TypeORM's `QueryRunner.query` was still unsuitable: it drops PostgreSQL's command tag, and its `QueryFailedError` carries the parameter values.

As the plan's fallback provides, the engine renders every shape itself behind the same `compile()` contract. It quotes identifiers and numbers placeholders exactly as TypeORM's drivers do, and a test pins the two together. TypeORM supplies driver injection, pool construction and connection checkout. On SQLite it opens the node:sqlite handle through the `better-sqlite3` driver's `driver` option. Statements run on the checked-out driver connection.

## Test matrix (`@jsails/database/testing`)

The run picks the driver, not the test:

- The default suite (`npm test`) runs on an on-disk SQLite file.
- The database suite (`npm run test:database`, which runs only `*.database.test.ts(x)` files) runs on the server named by `DATABASE_TYPE` (`mariadb` or `postgres`) at `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER` and `DATABASE_PASSWORD`, with `DATABASE_NAME` as the administrative database. CI runs it once per server.

`openMatrixDataSource(t, { entities })` returns an initialized `JsailsDataSource` on a database of its own, with the tables created by the framework's reconciler. That is a temporary file on SQLite, and on a server a new `jsails_m_<random>_test` database that is dropped when the test ends. On MariaDB the user needs privileges on `jsails\_m\_%` databases; PostgreSQL needs `CREATEDB`. `forEachDriver(name, fn, { drivers })` declares a suite for the run's driver and skips it, with the reason, on drivers it does not list. A database-suite run with a variable missing fails rather than skipping.

The engine's conformance suite (`test/conformance/engine/`) runs on the same matrix, so it is green on SQLite in the default suite and on each server leg. The data layer's regression tests (`test/regressions/`, and the old stack's in `core/test/database/regressions/`) state correct behaviour; today's failures are listed in `scripts/expected-failures/data.json`, scoped per driver with `databases`.
