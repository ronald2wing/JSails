---
title: Migrations
order: 6
section: Building
---

# Migrations

JSails reconciles your database with a **declarative desired-state engine**.
Your model classes are the single source of truth — there is no migration file
to write, no JSON artifact to check in, and no applied-state ledger.

```sh
jsails db:push --config jsails.config.js           # diff and apply
jsails db:push --dry-run --config jsails.config.js  # print the plan only
jsails db:diff --config jsails.config.js            # read-only plan
jsails db:diff --sql --config jsails.config.js      # driver-specific SQL preview
```

## How it works

`db:push` diffs the declared model schema (the `@jsails.*` decorators on your
`ApplicationRecord` subclasses) against the **live database** — it introspects
the current state via TypeORM's `QueryRunner.getTables()`, computes a minimal
operation plan, and applies it.

`db:diff` prints the same plan without applying anything. Add `--sql` to print
the driver-specific SQL each operation would run.

There is **no `migrations/` directory, no JSON migration files, and no
`jsails_migrations` tracking table**. Every run derives the plan fresh from the
models and the current database shape.

### Destructive changes are refused by default

Every operation in the plan is classified safe or destructive before any DDL
runs. The classification is **atomic**: if any operation is destructive and
`--allow-destructive` is absent, the engine applies **nothing**.

| Safe | Destructive |
|------|-------------|
| `create_table` | `drop_table` |
| `add_column` (nullable, permanent default, or temporary default) | `drop_column` |
| `copy_column` (state-neutral; see column replacement) | `drop_index`, `drop_unique`, `drop_fk`, `drop_check` |
| `rename_column`, `rename_table` | `alter_column` — type, length, precision, nullability tightening, or primary-key change |
| `add_index`, `add_unique`, `add_fk`, `add_check` | a column replacement (it drops the old column) |
| `alter_column` whose only change is the default | **any structural `alter_column` on SQLite** (SQLite rebuilds the table) |
| `alter_inheritance`, `alter_polymorphic` (metadata only) | |

An `add_column` that is `NOT NULL` with no default is refused by the differ —
the existing rows have no value. Declare a `@jsails.temporaryDefault` (below) to
generate a two-step safe plan, or add the column nullable and tighten it after a
backfill.

Pass `--allow-destructive` to apply a plan that contains destructive operations.
You are responsible for your own backups — the engine cannot reverse a
destructive change without a ledger.

### Renames: `@jsails.renamedFrom`

Without a hint the differ sees a dropped column and a new one. Mark a renamed
column or relation with `@jsails.renamedFrom` so the plan emits `rename_column`
instead of drop + add:

```ts
export class Post extends ApplicationRecord {
  @jsails.renamedFrom('summary') declare excerpt: string;
}
```

The marker is **idempotent** — it matches nothing once the rename has been
applied, so it is safe to leave in the source. It is a side-channel hint, not a
schema field.
An owning `@jsails.oneToOne` (or `@jsails.belongsTo`) relation is also a valid
target: the marker renames its FK column and the rename cascades through the
unique constraint and foreign key. An inverse relation owns no column, so a
marker there is ignored.

### Table names and table renames

A model's table is the snake_case class name unless `@jsails.table` overrides it:

```ts
@jsails.table('legacy_posts')
export class Post extends ApplicationRecord {
  declare title: string;
}
```

To rename an existing table without dropping its rows, put
`@jsails.renamedFrom` on the class:

```ts
@jsails.renamedFrom('posts')
@jsails.table('articles')
export class Article extends ApplicationRecord {
  declare title: string;
}
```

The reconciler turns that into `rename_table posts -> articles` and rewrites
every foreign key that referenced the old table. Like the column marker, it is
idempotent.

### Adding a `NOT NULL` column

Declare a one-off default on the column:

```ts
export class Post extends ApplicationRecord {
  @jsails.temporaryDefault('draft')
  declare status: string;
}
```

The plan is `add_column` with `DEFAULT 'draft'`, then `alter_column` to drop the
default. Both operations are safe. Existing rows receive `'draft'`; a data
migration can then replace it with the real value. The temporary default never
appears in the declared schema, so it cannot leak into a later diff.

### Replacing a column

When a column must be replaced rather than renamed or altered in place, mark the
new column with the old name and a copy expression:

```ts
export class Post extends ApplicationRecord {
  @jsails.replacedFrom('legacy_status', 'legacy_status')
  declare status: string;
}
```

The plan is:

1. `add_column` — the new column, nullable, no default.
2. `copy_column` — `UPDATE post SET status = legacy_status`.
3. `drop_column` — the old column.
4. `alter_column` — tighten the new column to its declared definition.

The expression is **raw SQL owned by the caller**; the engine validates only the
table and column identifiers. Primary-key columns cannot be replaced. The plan is
destructive because it drops the old column, so it requires
`--allow-destructive`. Indexes, uniques, and foreign keys on either column are
dropped/re-added by the normal constraint diff around the four steps.

### Portable schema

The engine supports these column types: `integer`, `varchar` (with a ceiled
`length`), `text`, `boolean`, `datetime`, `decimal(precision, scale?)`, `float`,
`bigint`, `uuid`, `json`, `date`, `time`. A single generated integer primary key
or a composite primary key is supported. Simple (non-partial, non-expression,
non-fulltext, non-spatial) indexes, simple unique constraints, table-level
`CHECK`, and single- or multi-column foreign keys with
`CASCADE` / `RESTRICT` / `SET NULL` / `NO ACTION` actions round out the set.
Many-to-many relations are supported through explicit junction entities or
`@JoinTable()`. Deferrable foreign keys and unique constraints are available on
Postgres only.

Rejected types raise `UnsupportedSchemaError`: partial and expression indexes,
database enums, generated UUIDs, computed columns, `@CreateDateColumn` /
`@UpdateDateColumn`, and function defaults.

## Data migrations

Schema reconciliation (phase 1) handles the table shape. Data migrations
(phase 2) transform the rows — backfilling a new column, normalising values, or
cleaning up after a rename. They are defined as named pairs in `jsails.config.js`
and run on **every** `db:push`, including when the schema is already up to date.

```ts
// jsails.config.js
import { JsailsDataSource, defineDataMigration, readDatabaseEnvironment } from 'jsails';

const database = readDatabaseEnvironment();

export const dataMigrations = {
  backfill_slugs: defineDataMigration({
    name: 'backfill_slugs',
    // Optional: default true. Set false for chunked backfills or self-managed
    // transactions.
    transactional: true,
    async up(ctx) {
      await ctx.queryRunner.query(
        "UPDATE post SET slug = LOWER(title) WHERE slug IS NULL",
      );
    },
    async down(ctx) {
      await ctx.queryRunner.query("UPDATE post SET slug = NULL");
    },
  }),
};

export default new JsailsDataSource({ ...database, entities: [Post] });
```

`ctx.queryRunner` is a TypeORM `QueryRunner`. Call `ctx.queryRunner.query(sql)`
for raw SQL; there is no DSL. Data migrations are expected to run DML only —
never DDL; the tables are already reconciled by phase 1.

Data migrations run in **dependency order**: a migration's `dependencies` are
visited first, a dependency cycle is rejected before any database work, and
declaration order (object key order) is the tiebreaker for independent
migrations. There is no ledger, so dependencies order work within one push; they
do not record that a migration ran.

### Per-migration transactions

Each data migration runs inside its own transaction by default. A failure rolls
back that migration's writes only:

```text
schema phase        commits
migration A         commits
migration B         fails → B rolls back
migration C         never runs
```

Earlier migrations stay committed. The run stops at the first failure. Because
there is no ledger, A runs again on the next `db:push`, so idempotency remains
mandatory. Set `transactional: false` for:

- long backfills that intentionally commit in batches;
- a migration that manages its own transaction;
- a migration that performs external I/O — do not hold a database transaction
  across network calls.

A `transactional: false` migration must commit or roll back any transaction it
opens. The runner rolls back a leaked transaction and fails with a value-free
error rather than handing a dirty session to the next migration.

The transaction covers DML. On MySQL/MariaDB, DDL auto-commits, so a data
migration that runs DDL is not atomic; data migrations are DML-only by contract.
The schema phase is separate: Postgres/SQLite reconcile in one transaction;
MySQL/MariaDB DDL auto-commits.

### The idempotency contract

Data migrations are **not tracked** — there is no ledger recording which ones
have run. They execute on every `db:push`, so every data migration **must be
idempotent**. The canonical form is a guarded statement:

```sql
UPDATE post SET slug = LOWER(title) WHERE slug IS NULL;
```

An unguarded `INSERT` duplicates rows on every push. This is the developer's
responsibility.

Data migrations never run if phase 1 refuses (destructive without
`--allow-destructive`) or fails.

### `down` is manual

The `down` function is **not invoked by any command**. There is no
`db:push --down` and no automatic rollback. `down` is a documented escape hatch
you can call from a script or REPL when you need to reverse a data migration
by hand.

## Polymorphic relations

A polymorphic relation lives on the **child** only; the target entity declares
nothing and the inverse is inferred.

```ts
@PolymorphicRelation({ targets: [Post, Comment], relatedName: 'owner' })
export class Like extends BaseEntity {
  // like_type varchar(190), like_id integer are generated columns
}
```

Read it both directions:

```ts
const owner = await loadPolymorphic(like, 'owner'); // child → parent
const likes = await loadPolymorphicInverse(post, 'likes'); // parent → children
```

There is no database-level FK — the target varies per row.

## Honest limits

- **Live-only objects are skipped.** Partial, expression, fulltext, and spatial
  indexes, database enums, generated and computed columns, and function defaults
  that exist only in the live database are filtered from introspection, so they
  never cause phantom diffs.
- **Type canonicalization on MySQL/MariaDB is heuristic.** The engine resolves
  ambiguous mapped types (`tinyint` → boolean vs integer, `longtext` → text vs
  json) by preferring the **declared** model type as a tiebreaker. Unsigned
  integers are canonicalized to signed — precision is lossy.
- **SQLite introspection is best-effort.** SQLite has no real type system; the
  engine matches types by string comparison, and every structural
  `alter_column` on SQLite is destructive because SQLite rebuilds the table. A
  default-only alteration remains safe.
- **No automatic rollback.** Without a ledger the engine cannot know what ran.
  Destructive changes are refused by default — the operator owns backups. Data
  migration `down` functions are invoked only manually.
- **Per-migration transactions are not a ledger.** They prevent a half-finished
  `up`; they do not prevent a committed migration from running again. A
  `transactional: false` migration has no framework boundary at all.
- **SQL preview is driver SQL, not a plan guarantee.** `db:diff --sql` renders
  through TypeORM's driver without connecting. Operations that need to
  introspect a live table (some SQLite rebuilds) print a preview-unavailable
  note instead.

## Next steps

- [Models](/docs/models) — the declarative Active Record model surface.
- [Database](/docs/database) — the portable schema, validation, and query
  expressions.
- [CLI](/docs/cli) — `db:push` and `db:diff`.