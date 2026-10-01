---
title: Enums
order: 45
section: Building
---

# Enums

`defineEnum` declares a column that holds one value from a closed set, such as
a post's status or an order's state. The portable schema has no database enum
type (see [Migrations](/docs/migrations)), so the column is a plain `varchar`
for string values or an `integer` for integer values, and the set is enforced
by the model helpers. `defineEnum` and its helpers come from `jsails/database`,
`jsails/models`, and the root `jsails` entry.

## Declaring an enum

Call `defineEnum` next to the entity class, when the module loads, before the
data source initializes:

```ts
import { BaseEntity, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { defineEnum, type ModelQuery } from 'jsails/database';

type PostStatusValue = 'draft' | 'published' | 'archived';

@Entity('posts')
export class Post extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;
  declare status: PostStatusValue;

  // Installed by defineEnum at runtime; declared so TypeScript sees them.
  declare statusIs: (value: PostStatusValue) => boolean;
  declare statusIn: (values: readonly PostStatusValue[]) => boolean;
  declare static statusScope: (value: PostStatusValue) => ModelQuery<Post>;
}

export const PostStatus = defineEnum(Post, 'status', ['draft', 'published', 'archived']);
```

- The values must be all strings or all integers, non-empty, and unique. A
  string value may not contain a backslash or a control character, because
  those cannot be quoted the same way on every database.
- For a class entity, `defineEnum` adds the column decorator: a `varchar` as
  long as the longest value (or `{ length }`, which may only be longer), or an
  `integer`. When the class already declares the column with `@Column`, that
  declaration is kept.
- `{ nullable: true }` allows `null`; columns are `NOT NULL` by default.
- The result is a frozen `EnumDefinition` (`table`, `column`, `values`, `type`,
  `length`, `nullable`, `check`).

## Predicates and scopes

On a class entity, `defineEnum` installs three methods named after the column.
It adds them at runtime, so TypeScript knows them only through the `declare`
lines in the class above; without those lines, call the function forms below.

```ts
const post = Post.create({ status: 'draft' });
post.statusIs('draft'); // true
post.statusIn(['draft', 'published']); // true

const published = await Post.statusScope('published').getMany();
```

The same operations exist as functions that take the definition, which also
work for an `EntitySchema` or a table name:

| Function                               | Returns                                    |
| -------------------------------------- | ------------------------------------------ |
| `enumIs(definition, record, value)`    | whether the column equals `value`          |
| `enumIn(definition, record, values)`   | whether the column is one of `values`      |
| `enumScope(definition, value)`         | a model query filtered to `value`          |
| `enumWhere(definition, value)`         | a `qEq` predicate for `where`              |
| `enumWhereIn(definition, values)`      | a `qIn` predicate for `where`              |

Every helper rejects a value outside the set with an `EnumError`
(`unknown_value`) instead of returning `false` or an empty result, so a typo
such as `statusIs('publised')` fails loudly. `enumScope` needs a class entity.
`EnumError` messages never include the rejected value.

## The CHECK constraint

Because the set is closed, each definition carries a portable `CHECK`
constraint in `definition.check`:
`{ name: 'status_enum_check', expression: "status IN ('draft', 'published', 'archived')" }`.

`db:push` does not see enum definitions, so it creates the column but not the
constraint. `applyEnumChecks(schema, ...definitions)` folds the constraints
into a `SchemaState` for tooling that builds and diffs schema states itself; it
fails with `EnumError` (`unknown_table`, `unknown_column`) when a definition
names a table or column the schema lacks. Without the constraint, writes that
bypass the model (raw SQL, another service) can store a value outside the set,
so validate input at the boundary as well, for example with `z.enum(...)` in an
entity validation schema (see [Models](/docs/models)).

## Changing the set

Adding a value keeps every existing row valid. A value longer than the
current longest changes the derived column length, which `db:push` plans as a
column change (preview it with `db:diff`). Removing or renaming a value leaves
rows that still hold the old one, and the helpers no longer accept it as an
argument, so code cannot select those rows by it; rewrite them first with a
data migration (see [Migrations](/docs/migrations#data-migrations)).

## Next steps

- [Models](/docs/models) — the Active Record layer.
- [Database](/docs/database) — queries, scopes, and the data source.
- [Migrations](/docs/migrations) — the portable schema and `db:push`.
