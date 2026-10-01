---
title: API Resources
order: 39
section: Building
---

# API Resources

An API resource is a JSON collection with list, create, read, update, and
delete endpoints. `jsails/api` builds one from three parts you write yourself:

- a **serializer**, which is the allowlist of fields a client may read and write;
- a **store**, which is the only code that knows where rows live;
- an **authorize** callback, which is default-deny.

Nothing infers a resource from a model. The serializer names every field that
crosses the wire, so adding a column to a table never exposes it. When rows
live in a model, [`@jsails/resources`](#model-backed-resources) writes the store
from the same explicit field list.

## Serializer

`defineSerializer` takes a map of field schemas. A `readOnly` field appears in
responses and is rejected in request bodies. A `writeOnly` field is the
reverse.

```ts
import { defineSerializer, integer, string } from 'jsails/api';

export const postSerializer = defineSerializer({
  id: { schema: integer(), readOnly: true },
  title: string({ min: 1, max: 200 }),
  body: string({ optional: true }),
  status: string(),
});
```

`validate(input)` checks a full payload and `validate(input, { partial: true })`
checks a `PATCH`. `toRepresentation(row)` renders a row through the read
allowlist. Validation errors are value-free: they name the field path and a
code, never the submitted value.

## Store

A `ResourceStore` has six methods. Every method receives the request context,
so a store scopes rows to the caller. `count` and `list` also receive the
request's `NormalizedQuery`, the parsed search, sort, and filter clauses.

```ts
import type { RequestContext } from 'jsails';
import type { FilterClause, NormalizedQuery, ResourceStore } from 'jsails/api';
import {
  query,
  qContains,
  qEq,
  qGt,
  qGte,
  qIn,
  qLt,
  qLte,
  qNe,
  qNotIn,
  type Q,
} from 'jsails/database';
import { ApplicationRecord } from 'jsails/models';

export class Post extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare body: string | null;
  declare status: string;
}

type PostInput = { title: string; body?: string; status: string };

function predicate(clause: FilterClause): Q {
  const { field, value } = clause;
  const many = Array.isArray(value) ? value : [value];
  switch (clause.operator) {
    case 'eq':
      return qEq(field, value);
    case 'neq':
      return qNe(field, value);
    case 'gt':
      return qGt(field, value);
    case 'gte':
      return qGte(field, value);
    case 'lt':
      return qLt(field, value);
    case 'lte':
      return qLte(field, value);
    case 'in':
      return qIn(field, many);
    case 'nin':
      return qNotIn(field, many);
  }
}

function filtered(q: NormalizedQuery) {
  const builder = query<Post>(Post);
  if (q.search !== null) builder.where(qContains('title', q.search));
  for (const clause of q.filterClauses) builder.where(predicate(clause));
  return builder;
}

export const postStore: ResourceStore<Post, PostInput> = {
  count: (_context: RequestContext, q: NormalizedQuery) => filtered(q).count(),
  list(offset, limit, _context, q) {
    const builder = filtered(q);
    for (const sort of q.sorts) builder.orderBy(sort.field, sort.direction === 'asc' ? 'ASC' : 'DESC');
    return builder.offset(offset).limit(limit).getMany();
  },
  get: (id) => Post.findOneBy({ id: Number(id) }),
  create: (data) => Post.create({ ...data }).save(),
  async update(id, data) {
    const post = await Post.findOneBy({ id: Number(id) });
    if (post === null) return null;
    return Object.assign(post, data).save();
  },
  async delete(id) {
    await Post.delete({ id: Number(id) });
  },
};
```

`count` and `list` must apply the same predicates, or the page count drifts
from the page contents. The handlers pass both calls the same query object.
The query only holds fields the resource declared, so a field or column a
client invents never reaches the store. A store that ignores the query is still
correct, just unfiltered.

The `search` term is a plain string, and the store decides what it matches.
The example matches it with `qContains`, which treats `%` and `_` as literal
characters. `qLike` would keep them as wildcards.

## Handlers

`createResourceHandlers` composes the three parts into a collection handler
set, for `GET` and `POST`, and a detail handler set, for `GET`, `PATCH`, and
`DELETE`.

```ts
import { createResourceHandlers, require, resourcePolicy } from 'jsails/api';
import type { RequestContext } from 'jsails';

const isSignedIn = (context: RequestContext) => context.session !== null;

export const postHandlers = createResourceHandlers({
  serializer: postSerializer,
  store: postStore,
  authorize: resourcePolicy({ list: require(isSignedIn), get: require(isSignedIn) }),
  filters: {
    fields: {
      title: { filterable: false },
      status: { type: 'string', operators: ['eq', 'in'] },
      id: { type: 'integer', filterable: false },
    },
  },
  pagination: { defaultPageSize: 20, maxPageSize: 100, maxOffset: 10_000 },
});
```

Mount them from two route files. A route module exports one named function per
HTTP method, so destructure each handler set:

```ts
// api/posts.ts
import { postHandlers } from '../app/posts.js';

export const { GET, POST } = postHandlers.collection;
```

```ts
// api/posts/[id].ts
import { postHandlers } from '../../app/posts.js';

export const { GET, PATCH, DELETE } = postHandlers.detail;
```

## Listing

A collection `GET` returns the page envelope:

```json
{ "count": 42, "results": [], "page": 2, "pageSize": 20, "next": 3, "previous": 1 }
```

It reads these query parameters:

- `page` and `pageSize` are positive integers. `pageSize` is capped at
  `maxPageSize`. A page that starts past `maxOffset` is a `400` with the code
  `page_too_deep`. Walking a whole table is a job for `ModelQuery.in_batches`,
  not page numbers.
- `search` is passed to the store as `query.search`.
- `sort=title,-id` sorts ascending by `title`, then descending by `id`.
- `filter[status]=draft` is an `eq` filter.
- `filter[status][in]=draft&filter[status][in]=review` names an operator, which
  must be in the field's `operators` list. `filter[status][]=draft` repeated is
  shorthand for `in`. Any other key that starts with `filter[` is a `400`, so a
  mistyped filter never silently returns an unfiltered page.

Without a `filters` option the handlers ignore `search`, `sort`, and `filter`,
and the store receives `EMPTY_QUERY`. With one, an undeclared field or a
disallowed operator is a `400` before the store runs. The error never repeats an
undeclared field name, an operator, or a value. It may name a declared field,
since that name comes from your allowlist.

## Model-backed resources

When rows live in a model, `defineModelResource` from `@jsails/resources`
writes the store for you. You still declare every field; the package derives
the serializer, the filter options, and a row-scoped store from that one list,
then builds the same handlers.

```ts
import { integer, require, resourcePolicy, string } from 'jsails/api';
import { qEq } from 'jsails/database';
import { defineModelResource, scopedBy } from '@jsails/resources';

import { Post } from '../models/post.js';

const ownerOf = (context) => context.session?.data.userId ?? null;
const signedIn = require((context) => context.session !== null);

export const posts = defineModelResource(Post, {
  name: 'posts',
  fields: {
    id: { schema: integer(), access: 'read', sort: true },
    title: { schema: string({ min: 1, max: 200 }), access: 'readWrite', sort: true, search: true },
    status: { schema: string(), access: 'readWrite', filter: { operators: ['eq', 'in'] } },
    ownerId: { schema: integer(), access: 'read' },
  },
  scope: scopedBy((context) => {
    const owner = ownerOf(context);
    return owner === null ? null : qEq('ownerId', owner);
  }),
  stamp: { ownerId: (context) => ownerOf(context) },
  defaultSort: [{ field: 'id', direction: 'desc' }],
  authorize: resourcePolicy({ list: signedIn, get: signedIn, create: signedIn, update: signedIn }),
});
// posts.serializer, posts.filters, posts.store, posts.authorize, posts.handlers
```

Mount `posts.handlers.collection` and `posts.handlers.detail` from `api/` route
files exactly as in [Handlers](#handlers).

- **`access`** is `read` (response only), `write` (request only, for a password
  or token), or `readWrite`. A column that is not listed is never read,
  written, or queried.
- **`sort`, `filter`, and `search`** are off unless a field opts in. Search
  matches every searchable field with escaped `qContains`, so `%` and `_` in a
  term are literal.
- **`scope`** is required. `scopedBy(where)` returns a predicate for the
  request, or `null` for no rows. `unscoped(reason)` opts out and takes a
  non-empty reason. The scope applies to `count`, `list`, `get`, `update`, and
  `delete` alike, so a row outside it is a `404`, the same as a row that does
  not exist, and a malformed id is a `404` before any query runs.
- **`stamp`** sets server-owned values on create, after the body is validated:
  one function per column, so the stamped columns are known at startup. A
  stamped column must not be writable, and a client that sends a read-only
  field gets a `400`.
- **`actions`** picks what the resource serves, like choosing a Django REST
  framework viewset: all five (`list`, `create`, `retrieve`, `update`,
  `delete`) by default, or `['list', 'retrieve']` for a read-only resource. A
  handler for an action left out answers `405` with an `Allow` header, and the
  store refuses that write, so it is safe to reuse elsewhere.
- **Unique constraints** (a `unique` column, `@Unique`, or a unique `@Index`)
  are checked before a write, like DRF's unique validators, when the resource
  supplies every column of the constraint from the body or the stamp. A
  duplicate is a `400` with code `unique`, on the field or, for a
  multi-column constraint, on the body. Nulls never conflict. The lookup spans
  the whole table, because the constraint does. When two concurrent writes
  both pass the check, the database refuses the second; the store checks
  again, finds the row that won, and answers the same `400`.
- **Each field's schema decides whether a create may omit it.** A NOT NULL
  column that is neither a field nor stamped, and that nothing else fills, is
  the database's to refuse, as with a DRF `ModelSerializer`.
- **`defaultSort`** may name only sortable fields; `id` is always the final
  tiebreaker, so pages never repeat or skip rows.

`defineModelResource` fails at startup, with a `ModelResourceError` code and no
values, when a definition is unsafe or ambiguous:

| Code                  | Rule                                                           |
| --------------------- | -------------------------------------------------------------- |
| `missing_authorize`   | `authorize` is required.                                       |
| `missing_scope`       | `scope` is required.                                           |
| `unknown_column`      | Every field names a column of the model.                       |
| `missing_primary_key` | The model has a single primary key column named `id`.          |
| `primary_key_writable` | `id` is `read`.                                               |
| `writeonly_queryable` | A `write` field is never sorted, filtered, or searched.        |
| `encrypted_field`     | An encrypted column is listed in `exposeEncrypted`.            |
| `encrypted_queryable` | An encrypted column is never sorted, filtered, or searched.    |
| `json_queryable`      | A JSON column is never sorted, filtered, or searched.          |
| `search_not_text`     | Only a text column is searchable.                              |
| `invalid_sort`        | `defaultSort` names only sortable fields.                      |
| `invalid_stamp`       | `stamp` maps columns to functions.                             |
| `stamped_field_writable` | A stamped column is not writable.                           |
| `invalid_actions`     | `actions` lists at least one known action.                     |

A write-only field cannot be filtered because a range filter and the page
`count` together would let a client read it back one comparison at a time.

The store uses the model's default data source, so it does not join a caller's
transaction. Write a store by hand when a save has to do more than set columns,
such as recording a revision or reindexing.

## Declarative form

`defineDeclarativeResource` takes the same parts as one object and also returns
a route manifest:

```ts
import { defineDeclarativeResource, integer, string } from 'jsails/api';

export const posts = defineDeclarativeResource({
  name: 'post',
  serializer: {
    id: { schema: integer(), readOnly: true },
    title: string({ min: 1 }),
    status: string(),
  },
  store: postStore,
  authorize: resourcePolicy({ list: require(isSignedIn) }),
  filters: { fields: { status: { type: 'string' } } },
});
// posts.serializer, posts.handlers, posts.routes, posts.authorize
```

The route manifest always uses `/:id` for detail routes.

## OpenAPI

`generateOpenApi` describes each resource's list operation as the page
envelope, with `page` and `pageSize` parameters. A declared query parameter
with the same name replaces the generated one.

## Admin

`defineStoreResource` from `@jsails/admin` backs an admin table with the same
store and serializer. The admin list's sort, search, and select filters reach
the store as a `NormalizedQuery`, and every save runs through
`serializer.validate` first. Pass it the same `filters` options and select
values are coerced to their declared types, so the store sees `true` rather
than `'true'` from both sides. See [Admin Panel](/docs/admin).

## Related

- [Pagination](/docs/pagination) covers the paging primitives.
- [Models](/docs/models) covers `ApplicationRecord`.
- [Routing](/docs/routing) covers API route files.
