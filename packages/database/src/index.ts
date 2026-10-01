/**
 * `@jsails/database`: the JSails data layer, written fresh beside the old
 * stack in core and replacing it at the data cutover (DAT-15). It holds
 * records and data sources (`ApplicationRecord`, `JsailsDataSource` with its
 * model binding, `FileDataSource`, the model-set `dataHandle`), the write
 * pipeline (record hooks and validation, declared effects, set writes,
 * attachments) and its key-only change feed (`ds.changes`), the
 * immutable `ModelQuery` with keyset batch walks, relation loading (one
 * statement per level, `includes`, `loadRelation`, `Loaded<T, S>`), the
 * `database()` plugin
 * and `databaseToken`, the supported-driver list, the data engine (the
 * SQL-level `Engine` contract over SQLite, MariaDB and PostgreSQL, the
 * plugin's options schema, `DatabaseError` and the query ledger),
 * transactions bound at the engine's lease (`transaction`,
 * `withTestTransaction`, `detached`), the statement layer (the `ir`
 * builders, the tenant policy as a pure rewrite, the guarded compile,
 * `Where<T>` and `Q`) and column codecs with the owned hydrator. The model
 * layer is `@jsails/database/model`, the schema core and the `db:*` command
 * modules `@jsails/database/schema`, raw SQL `@jsails/database/unguarded`,
 * and the three-driver test matrix `@jsails/database/testing`.
 */

export { DATABASE_DRIVERS, type DatabaseDriver } from './drivers.js';
export * from './change/index.js';
export * from './codec/index.js';
export * from './engine/index.js';
export * from './plugin/index.js';
export * from './query/index.js';
export * from './record/index.js';
export * from './relation/index.js';
export * from './statement/index.js';
export * from './transaction/index.js';
