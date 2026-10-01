# @jsails/database

The JSails data layer, written fresh beside the old stack in `jsails/database` and replacing it at the data cutover. It is private and unpublished until apps reach it through the `database()` plugin. Today it holds records and queries over a data source, the `database()` plugin, the supported-driver list (`DATABASE_DRIVERS`: SQLite, MariaDB, PostgreSQL), the data engine, transactions bound at the engine's lease, the model layer, the schema core, raw SQL (`@jsails/database/unguarded`), and the three-driver test matrix.

## Records and queries

```ts
import { ApplicationRecord, database, defineScope, query } from '@jsails/database';
import { column, defineModel } from '@jsails/database/model';

class Post extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare status: 'draft' | 'live';
  declare lockVersion: number;
}
defineModel(Post, {
  table: 'posts',
  columns: { title: column.string(200), status: column.string(10, { default: 'draft' }) },
  lockVersion: true,
  relations: { comments: { kind: 'hasMany', target: () => Comment, inverse: 'post' } },
});

// In the app config: database({ file: 'storage/app.sqlite', models: () => [Post, Comment] })

const live = defineScope<Post>((q) => q.where({ status: 'live' }));
const post = await Post.find(1);
post.title = 'Renamed';
await post.save();
const popular = await Post.all().scope(live).has('comments', '>=', 3).orderBy('id').getMany();
await Post.where({ status: 'draft' }).findEach((draft) => publish(draft), { batchSize: 500 });
const { affected } = await Post.where({ id: 1, lockVersion: 3 }).updateAll({ title: 'x', lockVersion: 4 });
```

- **Data source and binding.** `new JsailsDataSource({ config, models })` binds every model it lists to itself; `Post.where`, `query(PostTag)` and `post.save()` find their data source through that binding. A model bound to an open data source cannot be bound again (`data_source.already_bound`, and nothing of the second data source is bound); `close()` unbinds. The data source holds its engine privately, opens it on the first statement, and is not a TypeORM `DataSource`. A duplicate copy of the package in the process shares the bindings and refuses the other copy's data source (`data_source.duplicate_package`). The `database()` plugin declares the data source as a substrate resource under `databaseToken`: its configuration is resolved from the options, the `DATABASE_*` variables it declares and the application root before any setup runs; the kernel registers the handle before the first setup, `await services.get(databaseToken).get()` constructs the data source (binding the models, connecting nothing), and the kernel closes it, unbinding them, after the last cleanup.
- **`ApplicationRecord`** extends nothing. Statics: `find(key)` (`record.not_found`), `findBy(where)`, `where(where)`, `all()`, `build(values)`, `create(values)`, `insertAll(rows)`. Instance: `save()` (insert with every generated value read back, or an update of only the changed columns by the loaded key; with `lockVersion` it requires the loaded version and increments it, and an update or delete that matches no row throws `record.stale_record`), `destroy()`, `reload()`, `isPersisted()`, `changed()` and `was(column)`. Column values are plain own properties.
- **`ModelQuery<T, R>`** is immutable: every method returns a new query, and conditions are compiled and encoded where they are written, so an unknown column fails at once. Narrowing: `where`, `orderBy`, `limit`, `offset`, `lock`, `scope(fn, ...args)`, `whereHas(relation, filter?)` and `has(relation, op, n, filter?)` (correlated `EXISTS`, over belongs-to, has-many and has-one through an inverse, polymorphic inverses, self relations and link tables), `withoutTenantScope()`. Reading: `getMany`, `getOne`, `count`, `exists`, `pluck`, and `select(...columns)`, which returns frozen plain rows (never records, so they have no `save`). A locked `count()` reads and locks the rows `getMany()` would and counts them, since no dialect locks an aggregate's rows. Set writes: `updateAll(set)` and `deleteAll()`, one statement each, returning `{ affected }`, the rows matched on every driver; a query with `limit`, `offset`, `lock` or `select` is refused. Queries start from a model or a data handle: the constructor takes only a context, codecs and state the package made (`query.invalid_context`), since the context's catalog carries the tenant policy and a handle's grants. `query(model)` starts a query of any model or `defineTable` table, and `insertAll(model, rows)` inserts in bind-limit chunks inside one transaction. There is no `apply`, query builder, repository or manager.
- **Batch walks.** `inBatches(size, fn)` and `findEach(fn, { batchSize })` read in the query's order with the primary key as tiebreak, one fresh statement per batch continuing strictly after the last row read (a keyset, never an offset). The condition is built from the cursor's values: `id > ?` for one column on every dialect, a row-value comparison for several uniform non-null columns on PostgreSQL and SQLite, the expanded lexicographic form with a leading range term on MariaDB, and explicit `IS NULL` branches for nullable columns (NULL lowest unless the order places it). Each batch reads through the order's index, so the time per batch does not grow along the walk. `limit` caps the walk; `offset` is refused (`query.invalid_batch`).
- **`FileDataSource.open({ models: [{ model, rows | file }] })`** is a read-only in-memory SQLite data source: it creates the tables, loads the seed through `insertAll`, and switches to `query_only`, so a write fails with `read_only`, a read-only transaction included.
- **`dataHandle(ds, { models, read })`** is the data access a gated plugin is given: its own models as records with writes, its read grants as frozen plain rows (`data_source.not_granted` for a write or a row lock), and a catalog that knows no other table, so a relation filter reaching one fails before any SQL.
- **`unguarded(ds)`** (`@jsails/database/unguarded`) returns `{ sql, lease }` only: a tagged template whose interpolations are bound parameters, recorded in the query ledger as `unguarded`, and a connection that joins the ambient transaction. Nothing on that path is guarded.
- Errors are registry codes: `data_source.*`, `record.*` and `query.*`, value-free.

## The engine

The engine is the SQL-level layer everything above it builds on: plain SQL and plain values in, plain rows out. It is the only code in this package that imports TypeORM (a test enforces that), and none of its exports name a TypeORM type.

```ts
import { createEngine, resolveDatabaseConfig } from '@jsails/database';

const engine = await createEngine(
  resolveDatabaseConfig({ file: 'storage/app.sqlite' }, { env: process.env, root: appRoot }),
);
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

- `Engine`: `dialect`, `serverVersion`, `bindLimit`, `lease()` (an autocommit connection, or inside a `transaction()` a view joined to it), `begin({ readOnly?, isolation? })` (the low-level primitive under `transaction()`: a connection inside a new transaction, with `savepoint()`, `commit()` and `rollback()`), `compile(statement)` and `close()`.
- `Conn.query(sql, params, { origin })` returns `{ rows, affected, insertId? }`. `affected` counts written rows only, and an `UPDATE` counts the rows it matched on every dialect. A write with `RETURNING` counts the rows it returned. An upsert on MariaDB counts as MariaDB does (an updated row is 2, a row left as it was 1), and `RETURNING` with `ON CONFLICT DO NOTHING` is refused there, because MariaDB would also return the existing rows.
- When a failed statement ends the whole transaction on the server (a deadlock victim, or `RAISE(ROLLBACK)` on SQLite), every later statement and savepoint of that transaction fails with `transaction_aborted` and its `commit()` does too. MariaDB and SQLite would otherwise run what follows in autocommit mode, so the engine asks the session whether the transaction is still open after each failure there. PostgreSQL enforces the same itself.
- Statements (`Statement`) are plain data: select (columns, aggregates, a predicate tree with comparisons, `IN`, `IN (SELECT)`, `EXISTS`, row-value keyset comparison, null tests and `LIKE`, ordering with explicit null placement, limit and offset, row locks, and a per-partition window limit), multi-row insert with `RETURNING` and an `ON CONFLICT` action, update with values or increments, and delete. `UPDATE` and `DELETE` require a `where`; `{ op: 'true' }` is the explicit "every row". Every value is bound as a parameter, so a statement's SQL depends only on its shape.
- Values are normalised the same way on every dialect. Integers come back as `number`, or as `bigint` outside the safe range. Decimals, dates, times, timestamps and JSON come back as the server's text. Binary comes back as a `Uint8Array`, and booleans as `boolean` on PostgreSQL and `0`/`1` elsewhere. Turning these into application values is the codec layer's job.
- `DatabaseError` is the engine's one error class. Its `code` is classified from the driver's own code (`unique_violation`, `foreign_key_violation`, `not_null_violation`, `check_violation`, `deadlock`, `serialization_failure`, `lock_timeout`, `busy`, `statement_timeout`, `read_only`, `transaction_aborted`, `connection_failed`, `acquire_timeout`, `missing_dependency`, ...). `transient` marks failures where re-running the transaction may succeed. The message never carries SQL, values or credentials; `driverCode` and `constraint` carry only codes and schema names.
- The query ledger records every statement a connection runs in each ledger active in the async context: `createQueryLedger({ detail })`, `withQueryLedger(ledger, fn)`, and `currentQueryLedger()`. Without `detail` (the production setting) a ledger keeps only the count and the total time. With it, it also keeps each statement's SQL, origin and duration, and a shape whose literals and value lists are collapsed. A ledger never holds parameter values.

### Configuration: the `database()` options

`resolveDatabaseConfig(options, { env, root })` turns the `database()` plugin's options into the frozen `DatabaseConfig` an engine opens. Secrets come from the environment only, and only from the `env` the caller hands it (the plugin hands it its validated variables; nothing reads `process.env`). The variables are fixed (`DATABASE_ENV`): `DATABASE_URL`, `DATABASE_PASSWORD` and `DATABASE_MIGRATION_URL`, so the plugin can declare them. A URL written into the options may not carry a password. A URL in the environment wins over the options, so code can default to a SQLite file and a deployment can select a server.

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

## Transactions

`transaction(engine, body, options?)` is the one way to run work in a transaction; it takes a data source in place of the engine as well (`transaction(ds, body)`, or `ds.transaction(body)`). The outermost call begins one and binds `body` to it; every lease the engine hands out inside `body`, and inside every promise it starts, joins it. A nested call is always a savepoint frame.

```ts
import { transaction } from '@jsails/database';

const id = await transaction(
  engine,
  async (tx) => {
    const conn = await engine.lease(); // joins the transaction; release() does nothing
    const { rows } = await conn.query(insertSql, insertParams);
    tx.afterCommit(() => notifyAuthor(rows[0]?.id));
    return rows[0]?.id;
  },
  { isolation: 'serializable', retry: { attempts: 3 }, timeoutMs: 5_000 },
);
```

- The transaction commits when `body` fulfils and rolls back when it rejects, rejecting with the same failure. A nested `transaction()` keeps its writes, buffered records and afterCommit callbacks when it fulfils and discards them when it rejects, while the enclosing transaction carries on. Nested frames of one transaction run one at a time (two started with `Promise.all` never interleave savepoints), and a statement from an enclosing frame waits until the nested frame open inside it ends. That wait, like a nested frame's wait for its siblings, lasts at most the engine's `acquireTimeoutMs` and then fails with `transaction.frame_busy`: a read started in a frame and awaited inside a nested `transaction()` opened after it would otherwise never finish, so await it before opening the nested frame.
- A lease taken inside a transaction is a view of its connection, and each statement on it runs in the frame of that transaction bound to the async context it is issued from, so a connection leased in one frame and used in a nested one joins the nested frame. A lease taken outside every transaction stays a connection of its own wherever it is used, so session state on it (an advisory lock, a `SET`, a temporary table) stays with it: its writes inside a transaction commit independently on a server and wait for the transaction's writer lock on SQLite, as detached work does. Take a lease inside the transaction that should own its statements.
- The poisoned-frame rule is the same on every driver: after any failed statement the frame it ran in refuses every further statement with `transaction.aborted`, and rolls back even if `body` caught the failure. To recover from an expected failure (a unique violation, say), run the attempt in a nested `transaction()` and catch its rejection. This is stricter than MariaDB and SQLite are natively.
- `isolation`, `readOnly`, `retry` and `timeoutMs` apply to the outermost call only; on a nested call they fail with `transaction.outermost_only`. `retry: { attempts, on?, backoffMs? }` re-runs the whole body, by default on a transient `DatabaseError` (deadlock, serialization failure, lock timeout, busy), with exponential backoff and jitter; a transaction that committed never runs again. `timeoutMs` rolls back at once and rejects with `transaction.timeout` without waiting for the body, freeing the connection (on SQLite the writer lock); later statements of the body fail the same way.
- `tx.afterCommit(callback)` runs after the outermost commit and `tx.afterRollback(callback)` once the frame's work is rolled back, one at a time, where that work now lives: in the nearest enclosing frame still open (so the afterRollback writes of a rolled-back nested frame join the enclosing transaction), or with the transaction's scope removed when none is. Removing the scope drops only this engine's binding, so a callback's statements on another engine still join that engine's open transaction. Their failures reject `transaction()` with `transaction.after_commit_failed` (the data committed) or `transaction.after_rollback_failed` (whose cause lists the original failure first). `tx.depth` is 1 for the outermost transaction.
- Once a transaction ended, work still running from its async context fails with `transaction.closed`: a statement, a lease, a nested `transaction()`, `engine.begin()` and a callback registration alike. `detached(fn)` runs `fn` outside every transaction, for work meant to outlive one or to commit independently. `engine.begin()` inside a transaction of the same engine fails with `transaction.nested_begin`.
- `withTestTransaction(engine, body)` runs `body` in a transaction that always rolls back, so everything it wrote on any lease is gone afterwards. App code inside behaves as in production: a statement outside any `transaction()` runs as if in autocommit (in a savepoint of its own, so a caught failure leaves later statements working), and a `transaction()` inside is the outermost one app code sees, whose afterCommit callbacks run as soon as it fulfils and whose afterRollback callbacks run as soon as it rolls back or times out, still inside the test transaction, so their writes roll back with the test. A savepoint cannot apply `isolation` or `readOnly: true`, so that `transaction()` refuses them with `transaction.unsupported_in_test` rather than run differently from production; a test of code that needs them runs against real commits.
- Transaction errors are `TransactionErrors` registry codes (`transaction.*`), value-free like `DatabaseError`.

## The schema core

The schema core reconciles a database with the models that declare it, without an ORM: it introspects PostgreSQL (`pg_catalog`), MariaDB (`information_schema`) and SQLite (`sqlite_schema` and the table-valued pragmas) itself, compares the result with `physicalTable` of each model, and writes its own DDL. A pushed schema introspects back to an empty plan on all three dialects, MariaDB's automatic foreign-key index included.

```ts
import { defineSchemaConfig } from '@jsails/database/schema';
import { Post } from './models/post.js';

// jsails.database.js: what `jsails db:push` and `jsails db:diff` reconcile.
export default defineSchemaConfig({ database: { file: 'storage/app.sqlite' }, models: [Post] });
```

- `diffSchema(source)` returns the plan a push would apply now and changes nothing. `pushSchema(source, { approve, environment, waitLockSeconds, owner })` applies it. A source is `{ config, models }`: a resolved `DatabaseConfig` and the models. Both run on the dedicated migration connection (`DATABASE_MIGRATION_URL` when set), and an in-memory SQLite database is refused.
- Every operation is classified. `safe` operations need nothing: creating or adopting a table, adding a nullable column or one with a default, building a non-unique index on a server without locking writes (`CONCURRENTLY`, `LOCK=NONE`), adding a foreign key to a new table, dropping an index, loosening `NOT NULL`, changing a default. `blocking` operations rewrite or lock a table or can fail on existing rows: widening a column, `SET NOT NULL`, a unique index, any SQLite index, a foreign key on an existing table, a primary-key change, a SQLite rebuild that keeps every column. `destructive` operations lose data: dropping a table or a column, narrowing a column, changing its type. A push applies every safe operation and only the blocking and destructive ones that were approved. The rest are deferred, and so is anything that depends on them. A deferred operation never blocks unrelated safe work.
- Some operations form a unit that applies whole or not at all, listed in each operation's `appliesWith`: an index or foreign key replaced under its name, or a unique index renamed, with its replacement; and a foreign key dropped so a column it joins can change type, with that change and the key's re-addition. A push decides what waits for the whole plan before it applies anything (`reason: 'approval'` for an unapproved blocking or destructive operation, `'dependency'` for one that waits on, or applies with, a deferred one), so a drop never commits while its replacement waits.
- Approval is per operation. Each blocking or destructive operation carries a digest of the operation and of the live table it changes. `db:push --approve <digest>` applies that operation and no other. When the push recomputes its plan under the lock, a digest that matches no operation refuses the whole push before any change (`schema.stale_approval`): the table changed since the digest was printed. `--approve-all` is accepted in `development` and `test` only.
- Ownership is recorded in `jsails_schema_objects`, one row per table: the app (`app`) or a plugin (`plugin:<name>`). A push manages only its owner's tables. A table another owner holds is never planned, and declaring it fails with `schema.owned_by_another`. A table nobody owns that matches a declared one is adopted. An undeclared table nobody owns (a hand-made one) is reported once as unmanaged and never dropped. `jsails_data_migrations` records applied data migrations, and `jsails_schema_meta` holds key/value facts: each owner's applied digest, unmanaged tables already reported, and the test marker.
- The lock. On PostgreSQL and MariaDB a push takes a session advisory lock named from the database the server reports. A url and a field-by-field configuration of one database therefore share the lock, and two databases on one server do not. The lock is verified before every statement, so a push through a transaction-mode pooler, whose statements reach different sessions, stops with `schema.pooled_connection` before any change. On SQLite the push is one `BEGIN IMMEDIATE` transaction with foreign keys off, checked with `foreign_key_check` before it commits. A push that waits past `waitLockSeconds` (60) fails with `schema.lock_timeout`.
- The test guard. In the `test` environment a push first requires the server-reported database name to be a test name (`app_test`, `app-tests`, `storage/app_test.sqlite`), whatever the configuration says, and the database to carry the marker that `markTestDatabase(conn)` writes. Otherwise it fails with `schema.non_test_database` or `schema.unmarked_test_database`.
- The boot check. A complete push records the digest of the declared schema. `verifySchema(engine, models, { environment })` reads that one row and compares it with the digest of the models the app runs with. Outside `development` and `test` a mismatch throws `schema.schema_out_of_date`. In development and test the pending plan is returned instead.
- `db:push` exits 0 when the schema is now the declared one, 3 when it deferred work, 2 on a usage error and 1 on any other failure. `--json` prints the plan or the push report, and `--wait-lock <seconds>` bounds the wait for the lock.

## Test matrix (`@jsails/database/testing`)

The run picks the driver, not the test:

- The default suite (`npm test`) runs on an on-disk SQLite file.
- The database suite (`npm run test:database`, which runs only `*.database.test.ts(x)` files) runs on the server named by `DATABASE_TYPE` (`mariadb` or `postgres`) at `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER` and `DATABASE_PASSWORD`, with `DATABASE_NAME` as the administrative database. CI runs it once per server.

`openMatrixDataSource(t, { entities })` returns an initialized `JsailsDataSource` on a database of its own, with the tables created by the framework's reconciler. That is a temporary file on SQLite, and on a server a new `jsails_m_<random>_test` database that is dropped when the test ends. On MariaDB the user needs privileges on `jsails\_m\_%` databases; PostgreSQL needs `CREATEDB`. `forEachDriver(name, fn, { drivers })` declares a suite for the run's driver and skips it, with the reason, on drivers it does not list. A database-suite run with a variable missing fails rather than skipping.

The engine's conformance suite (`test/conformance/engine/`) runs on the same matrix, so it is green on SQLite in the default suite and on each server leg. The data layer's regression tests (`test/regressions/`, and the old stack's in `core/test/database/regressions/`) state correct behaviour; today's failures are listed in `scripts/expected-failures/data.json`, scoped per driver with `databases`.
