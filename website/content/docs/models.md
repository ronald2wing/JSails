---
title: Models
order: 7
section: Building
---

# Models

The `jsails/models` subpath is the one-import surface for authoring a JSails
model. A model is a class that declares only the shape of its data — no TypeORM
decorators, no hand-written subscribers, no `entities` entry. The compiler
derives the table, columns, foreign keys, and migrations from the class shape,
and `defineModel` lowers that spec onto TypeORM at bootstrap time.

```ts
import { ApplicationRecord, delegate } from 'jsails/models';

export class Post extends ApplicationRecord {
  declare title: string;           // => varchar(255)
  declare published: boolean;      // => boolean
  declare author: Author;          // => many-to-one FK (author_id)
  declare comments: Comment[];     // => one-to-many inverse
}
```

`ApplicationRecord` imports `reflect-metadata` and re-exports TypeORM's
`BaseEntity`, so class-level Active Record queries (`Post.find()`,
`Post.findOneBy({ ... })`) are available without a repository. Every model that
extends it installs the `@jsails.*` decorator namespace on `globalThis` as a
transitive side effect — no separate import or preamble.

## `@jsails.*` decorators

When inference cannot know the intent, decorate a field in place with an inline
`@jsails.*` decorator. TypeScript type-checks the decorator against the
generated `.jsails/framework-symbols.d.ts` ambient declaration; the runtime
installer sets `globalThis.jsails` to an inert namespace, so the emitted
`__decorate` call does not throw. The compiler reads the decorator AST and
folds it into the model spec; the runtime `@jsails.*` factories are no-ops.

### Class decorators

| Decorator | Effect |
| --------- | ------ |
| `@jsails.table(name)` | Override the derived table name (`Post` → `post`). |
| `@jsails.renamedFrom(old)` | The table was previously named `old`; the reconciler emits `rename_table` instead of drop + create. |

`@jsails.table` is how a model maps onto an existing table whose name does not
follow the class-name convention. `@jsails.renamedFrom` on the class is the
table-level counterpart of the column marker; it is idempotent and may be left
in place.

### Scalar decorators

| Decorator               | Effect                                                   |
| ----------------------- | -------------------------------------------------------- |
| `@jsails.maxLength(n)`  | Set the varchar column length (compiler default: 255).   |
| `@jsails.unique()`      | Add a unique constraint on the column.                   |
| `@jsails.nullable()`    | Allow `null` in the column (compiler default: not null). |
| `@jsails.default(v)`    | Permanent column default, baked into the schema and TypeORM column. |
| `@jsails.temporaryDefault(v)` | One-off default used only while adding a `NOT NULL` column to an existing table. |
| `@jsails.replacedFrom(old, expression)` | Replace `old` with this column: add nullable, copy through `expression`, drop `old`, then tighten. |
| `@jsails.encrypts()`    | Encrypt the column before persistence (see below).       |

`@jsails.maxLength` requires the column type to be `string` (the compiler infers
`varchar`); applying it to a non-string field is a compiler error. `@jsails.nullable`
and `@jsails.unique` apply to any scalar.

`@jsails.temporaryDefault` never becomes part of the declared schema: the
reconciler adds the column with that value, then immediately drops the default.
A data migration can backfill the real values after the schema phase.

`@jsails.replacedFrom` is a destructive, explicit transition. The copy
expression is raw SQL owned by the caller; the engine validates only the
column identifiers. Primary-key columns cannot be replaced.

### Data-backed JSON columns

A structured value stored in a `json` column should have one contract for
validation, JSON Schema, and storage. Decorate the field with
`@jsails.data(Contract)` and type it with `DataValue`:

```ts
import { ApplicationRecord } from 'jsails/models';
import { defineData, type DataValue } from 'jsails/data';
import { z } from 'jsails/zod';

export const Preferences = defineData({
  name: 'Preferences',
  properties: {
    theme: z.enum(['light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
  },
});

export class User extends ApplicationRecord {
  @jsails.data(Preferences)
  declare preferences: DataValue<typeof Preferences>;
}
```

The compiler emits a portable `json` column; at runtime `defineModel` validates
the field against the contract on insert and on a present update. A list uses
`defineDataList(Preferences)`. `@jsails.data` and `@jsails.encrypts()` cannot be
combined. See [Data Contracts](/docs/data-contracts) for the full contract, JSON Schema,
AI tool, and list surface.

### Relation decorators

| Decorator                                            | Effect                            |
| ---------------------------------------------------- | --------------------------------- |
| `@jsails.belongsTo(Target, opts?)` | Owning many-to-one (this entity holds the FK). |
| `@jsails.oneToOne(Target, opts?)`  | Owning one-to-one (this entity holds the unique FK). |
| `@jsails.hasMany(Target, opts?)`   | Inverse one-to-many (the FK lives on the target). |
| `@jsails.hasOne(Target, opts?)`    | Inverse one-to-one (the unique FK lives on the target). |

Relation options are `touch`, `counter_cache`, `inverse`, `foreignKey`, and
`onDelete` (`CASCADE` / `RESTRICT` / `SET NULL` / `NO ACTION`).

A relation decorator replaces type inference for that field. Without it, a bare
field typed as another model class lowers to `many-to-one` and a `Model[]` field
lowers to `one-to-many` with a conventional inverse name (plural → singular
stripping). The decorator is needed only when the inference is ambiguous (two
models reference each other in both directions) or when you want behaviour flags
(`touch`, `counter_cache`).

### One-to-one

Declare the owning side with `@jsails.oneToOne` and the inverse side with
`@jsails.hasOne`:

```ts
// models/profile.ts — owns the unique FK
export class Profile extends ApplicationRecord {
  @jsails.oneToOne(User, { onDelete: 'CASCADE' })
  declare user: User;
}

// models/user.ts — inverse side, no column
export class User extends ApplicationRecord {
  @jsails.hasOne(Profile)
  declare profile: Profile;
}
```

The join column follows the framework convention — `<relation>_<referenced
column>`, so `user_id` — and the schema synthesizer adds a unique constraint on
it. An inverse side defaults its `inverse` to the owning class name
(`User` → `user`); pass `{ inverse: 'account' }` when the owning property is
named differently. A self-referential inverse (`Person.spouse`) requires an
explicit `inverse`.

`foreignKey` overrides the column name only for a deliberate deviation. On a
hand-written TypeORM entity, `@JoinColumn()` is still required to mark the
owning side — it is TypeORM's ownership signal, not a JSails API. The naming
strategy gives that bare decorator the conventional column name, so
`@JoinColumn({ name: 'user_id' })` is unnecessary unless you deviate. See
[Database](/docs/database#the-raw-escape-hatch).

Renaming an owning one-to-one relation is data-preserving when marked on the
relation field:

```ts
@jsails.renamedFrom('legacy_user_id')
@jsails.oneToOne(User)
declare user: User;
```

The reconciler emits `rename_column` for the FK column and cascades the rename
through the unique constraint and foreign key. An inverse `@jsails.hasOne` owns
no column, so a `renamedFrom` marker there is ignored.

**`touch: true`** wires `belongs_to(..., { touch: true })` — when a child is
inserted, updated, or deleted, the parent's `updated_at` timestamp is set to
now. **`counter_cache: true`** wires `has_many(..., { counter_cache: true })` —
maintains a `<name>_count` column on the parent incremented/decremented on child
insert/delete. **`inverse`** names the property on the target that points back,
used only when the conventional name is wrong.

### `@jsails.encrypts()`

Adding `@jsails.encrypts()` to a scalar field marks it for transparent
encryption at the entity-subscriber boundary. `defineModel` wires the
`encrypts()` hook bridge from `jsails/database`, which encrypts the column
before `insert`/`update` and decrypts it after `load`. The encrypter is
resolved from the environment:

The key comes from `JSAILS_ENCRYPTION_KEY`; optional decrypt-only rotation keys
come from `JSAILS_ENCRYPTION_PREVIOUS_KEYS`. See [Encryption](/docs/encryption)
for key material, envelope format, and rotation semantics.

When no key is configured, `defineModel` installs a sentinel encrypter that
throws a value-free `EncryptionError` on first use — a keyless deployment fails
at the first write or read rather than silently persisting plaintext. Migrations
are unaffected (DDL never reads or writes rows).

The default mode is AES-256-GCM with a random IV per call; the encrypted column
is not queryable by equality. Pass `{ deterministic: true, deterministicKey }`
to `encrypts()` directly (not through the decorator) for equality-queryable
ciphertext at the accepted cost of leaking plaintext equality.

The `@jsails.encrypts()` decorator is a **compile-time marker** only. The
runtime encryption is wired by `defineModel` calling `encrypts(entity,
resolveModelEncrypter(), fields)`, not by the decorator factory (which is a
no-op).

## `defineModel` and the compiler pipeline

The compiler derives a `ModelSpec` from the class — table name, primary key,
column specs (type, length, nullable, unique), relation specs (kind, owning or
inverse, target, join column, inverse, delete action, touch flag, counter
cache), and an `encrypted` field list — and
emits a `defineModel(Class, spec)` call into the generated
`.jsails/models.registry.ts`.

`defineModel` is the only place TypeORM exists in the model pipeline. It applies
TypeORM's own decorator factories programmatically (`@Entity`, `@Column`,
`@ManyToOne`, `@OneToOne`, `@OneToMany`, `@JoinColumn`), derives lifecycle hooks from
relation behaviour flags (`belongs_to` / `has_many` → `touch` / `counter_cache`),
registers the class and hooks in the JSails model registry, and validates the
spec eagerly (rejecting invalid types, varchar columns without length, and
encrypted fields that name a non-column).

```ts
// Generated .jsails/models.registry.ts  (compiler output)
import { defineModel } from 'jsails/models';
import { Post } from '../src/models/post.js';

defineModel(Post, {
  table: 'post',
  primaryKey: { name: 'id', kind: 'integer' },
  columns: [
    { name: 'title', type: 'varchar', length: 255 },
    { name: 'published', type: 'boolean' },
  ],
  relations: [
    { kind: 'many-to-one', name: 'author', target: Author, joinColumn: 'author_id' },
    { kind: 'one-to-many', name: 'comments', target: Comment, inverse: 'post' },
  ],
  encrypted: ['title'],
});
```

## Low-level relation functions

`jsails/models` re-exports the declarative relation DSL from `jsails/database`:

```ts
import { belongs_to, has_many, has_one, accepts_nested_attributes_for } from 'jsails/models';
```

Each function returns an `EntityHooksDefinition[]` array that composes with the
existing hook-bridge seam. They are the same functions `defineModel` calls
internally; importing them directly is the escape hatch when you need finer
control than the compiler pipeline provides.

| Function                                 | Hooks wired                               |
| ---------------------------------------- | ----------------------------------------- |
| `belongs_to(Class, prop, options?)`      | Owning M2O **or O2O**: `touch` on parent, optional `dependent`. |
| `has_many(Class, prop, options?)`        | `counter_cache` on parent, `touch`, `dependent`, `through`. |
| `has_one(Class, prop, options?)`         | Inverse O2O: `touch` on child, optional `dependent`. |
| `accepts_nested_attributes_for(Class, prop, fields)` | Nested child data through parent `save()`. |

## `delegate`

`delegate(methods, options)` forwards a property (getter or method) through a
relation on an Active Record entity.

```ts
import { delegate } from 'jsails/models';

class Comment extends ApplicationRecord {
  delegate('name', { to: 'author', prefix: true });  // => this.author_name -> this.author.name
  delegate(['title', 'published'], { to: 'post' });   // => this.title -> this.post.title
}
```

A `null`/`undefined` target throws a value-free `DelegateError` (`nil_target`)
unless `allow_nil: true` is set (returns `undefined` instead).

## `bootstrapModels`

`bootstrapModels()` imports the compiled `.jsails/models.registry.js`, populating
the model registry before a `JsailsDataSource` harvests it. The config loaders
call it automatically before constructing a data source; a project with no
models has no registry and the call is a silent no-op.

```ts
import { bootstrapModels } from 'jsails/models';
await bootstrapModels();
// => true when a registry was found, false when the project has no models.
```

## How this relates to `jsails/database`

The `jsails/models` DSL is a compiler-driven authoring convenience over the
lower-level data layer. Every concept it produces — entities, columns, relations,
hooks — lands in `jsails/database` through `defineModel`. When you need the
depth (query expressions, model query, relation loading, transactions,
migrations), read the [Database](/docs/database) page. The model page
documents the authoring surface only: how you write a model class, what the
decorators do, and how the compiler lowers it.

## Next steps

- [Database](/docs/database) — entities, queries, relation loading, and transactions.
- [Migrations](/docs/migrations) — recording and applying schema history.
