---
title: Pagination
order: 38
section: Building
---

# Pagination

Pagination is a framework-wide primitive, not a plugin or a database feature.
JSails uses offset/limit page-number pagination: a request carries `page` and
`pageSize`, the server returns one window plus the total count. The same
primitives and the same markup serve server-rendered apps and static (SSG)
exports — only the place the handlers run differs.

## Core primitives

`jsails/api` owns the bounded pagination core. It has no database coupling: it
validates and normalizes the query parameters, caps the page size, and computes
numeric `next`/`previous` links without assuming a route or hostname.

```ts
import { normalizePagination, paginate, paginateArray } from 'jsails/api';
import type { Page, QueryAdapter } from 'jsails/api';

const params = { page: 2, pageSize: 25 };
const { page, pageSize } = normalizePagination(params);
// page: 2, pageSize: 25
```

`normalizePagination(params, options?)` accepts untrusted input. `page` and
`pageSize` must be positive integers — no string coercion — and `pageSize` is
capped at `maxPageSize` (default 100). An out-of-range page is not an error; it
returns an empty result set. Invalid input throws a value-free validation error.

`Page<T>` is the envelope every paginator returns:

```ts
interface Page<T> {
  count: number;      // total items across all pages
  results: T[];       // items on the current page
  page: number;       // 1-based current page
  pageSize: number;   // applied page size (already capped)
  next: number | null;
  previous: number | null;
}
```

`paginate` works against any store through a two-method adapter, so pagination
never depends on a concrete database:

```ts
interface QueryAdapter<T> {
  count(): Promise<number>;
  list(offset: number, limit: number): Promise<T[]>;
}

const adapter: QueryAdapter<Post> = {
  count: () => Post.count(),
  list: (offset, limit) => Post.find({ skip: offset, take: limit }),
};

const page: Page<Post> = await paginate(adapter, params);
```

`paginateArray(items, params, options?)` is the pure, synchronous counterpart.
It slices an in-memory array and is browser-safe, so the same envelope shape
works in a client island as on the server.

```ts
const page = paginateArray(allPosts, { page: 1, pageSize: 20 });
```

Both functions accept `PaginationOptions` — `{ maxPageSize?, defaultPageSize? }`
— defaulting to a page size of 20 and a maximum of 100.

## Resource handlers

`createResourceHandlers` (`jsails/api`) auto-paginates a collection `GET`. It
reads `?page=` and `?pageSize=` from the request URL, applies the same positive-
integer validation and cap, and returns the `Page` envelope with `results`
mapped through the resource serializer. No per-resource pager code is needed.

```ts
import { createResourceHandlers } from 'jsails/api';

const handlers = createResourceHandlers({
  serializer,
  store,
  authorize,
  pagination: { defaultPageSize: 20, maxPageSize: 100 },
});
```

A request to the collection route with `?page=2&pageSize=25` returns
`{ count, results, page, pageSize, next, previous }`. The detail routes are
unaffected.

## ORM batching

`ModelQuery` (`jsails/database`) exposes `limit(n)`, `offset(n)`, and
`orderBy(column, direction?)` for manual windows. For whole-table traversal use
the stable batch iterators instead of page-number paging:

```ts
import { query } from 'jsails/database';

await query(Post).in_batches(100, async (rows, page) => {
  // rows is a fully loaded, annotated page; page is 1-based
});

await query(Post).find_each(async (row) => {
  // one row at a time; internally batches at 100 by default
}, { batchSize: 250 });
```

`in_batches(size, fn, { offset? })` calls `fn(rows, page)` for each non-empty
page and stops at the first empty page. When no `orderBy` is set it uses a
deterministic primary-key ordering; the primary key is always appended as a
tiebreaker so the cursor is total. `options.offset` skips that many rows before
the first batch only. `find_each(fn, { batchSize? })` is the row-level
convenience over it.

Page-number pagination and batching answer different questions. A page window
is a view for a user; a batch walk is a traversal for a job. Batches use keyset
(cursor) paging: each page continues strictly after the last row of the
previous page, so deleting or inserting rows during the walk cannot shift the
window. The precise guarantee is that rows present for the whole walk are seen
exactly once; concurrent inserts and deletes may or may not be observed, and
there is no snapshot isolation. Use `in_batches`/`find_each` for migrations,
exports, and backfills; use `paginate` for interactive lists.

## Load more

One recipe covers server-rendered and static apps. Render the current window
from a `Page<T>`, add a sentinel that asks for the next window, and let
`pagerAttrs` build the prev/next controls. The markup is identical in both
environments; only the handler target changes.

```tsx
// PostFeed.tsx — same markup on the server and in an island.
import { intersectAttrs, pagerAttrs } from 'jsails/client'; // or 'jsails/server-components'
import type { Page } from 'jsails/api';

export function PostFeed({ page }: { page: Page<Post> }) {
  const pager = pagerAttrs(page, { action: 'page' });
  return (
    <div>
      <ul>{page.results.map((post) => <li>{post.title}</li>)}</ul>
      {pager.previous && <a {...pager.previous}>Previous</a>}
      {pager.next && <a {...pager.next}>Next</a>}
      {page.next !== null && <div {...intersectAttrs('loadMore')}>Loading…</div>}
    </div>
  );
}
```

`pagerAttrs(page, options?)` returns `{ previous, next }` maps that spread onto
a `call` trigger; each direction is `null` when there is no link. Defaults are
action `page`, fields `page`/`pageSize`, and a 100 cap. `intersectAttrs(action)`
emits `data-jsails-intersect`; the client fires the named action once when the
element enters the viewport. The `Page<T>` comes from `paginate` (a store) or
`paginateArray` (in-memory) — the component does not care which produced it.

### Where the handlers run

**Server components.** `loadMore` and `page` are server actions on the
component. The same attributes dispatch to the server binding, which parses the
JSON args and calls the action: `page` receives `{ page, pageSize }`, `loadMore`
receives `{}`. The action updates state, the component re-renders with the next
`Page`, and the new sentinel re-arms.

```tsx
// server component actions
actions: {
  page: defineAction({
    input: z.object({ page: z.number(), pageSize: z.number() }),
    run(state, args) {
      state.page = args.page;
      state.pageSize = args.pageSize;
    },
  }),
  loadMore: defineAction({
    input: z.object({}),
    run(state) {
      state.page += 1;
    },
  }),
}
```

**Islands/SSG.** The same markup works in a pure Preact island, but the
handlers are local functions passed to `useIslandTools`. It returns the ref to
attach to the island root and wires both `data-jsails-intersect` and
`data-jsails-call` to the map. `jsails/api` is browser-safe, so the island can
slice client-available data with `paginateArray`.

```tsx
import { useState } from 'preact/hooks';
import { paginateArray } from 'jsails/api';
import type { Page } from 'jsails/api';
import { intersectAttrs, pagerAttrs, useIslandTools } from 'jsails/client';

export function PostFeed({ posts }: { posts: Post[] }) {
  const [page, setPage] = useState<Page<Post>>(() => paginateArray(posts, { page: 1 }));
  const { ref } = useIslandTools({
    handlers: {
      loadMore: () =>
        setPage((current) => paginateArray(posts, { page: current.next ?? current.page })),
      page: (args) =>
        setPage(paginateArray(posts, { page: Number(args.page), pageSize: Number(args.pageSize) })),
    },
  });
  const pager = pagerAttrs(page, { action: 'page' });

  return (
    <div ref={ref}>
      <ul>{page.results.map((post) => <li>{post.title}</li>)}</ul>
      {pager.previous && <a {...pager.previous}>Previous</a>}
      {pager.next && <a {...pager.next}>Next</a>}
      {page.next !== null && <div {...intersectAttrs('loadMore')}>Loading…</div>}
    </div>
  );
}
```

Server actions need a server, so a pure static export uses the island form. The
island receives the full dataset as props (serialized into the static page),
slices it locally, and re-arms after each state update. No server round trip is
involved.

The once-only semantics are the gotcha in both forms: the observer fires the
action a single time per element entry, then unobserves it. The effect re-runs
after every render, so the next render's sentinel re-arms. The handler must
update state so the next render produces a new sentinel (or removes it when
`next` is `null`); otherwise the feed stops after one page. Re-arming is the
component's responsibility, not the client's.

Offset pagination drifts under concurrent writes, so a "load more" feed can
repeat or skip rows while the underlying table changes. That is acceptable for
an interactive list; for a full scan use `in_batches`/`find_each` instead.

## Choosing

- **Page-number pagination (`paginate`/`paginateArray`)** — interactive lists
  where users expect numbered pages or a bounded window. Works on the server
  and in a static island.
- **`in_batches`/`find_each`** — whole-table traversal: migrations, exports,
  backfills. Keyset paging sees each row present for the whole walk exactly
  once; concurrent writes may or may not be observed. Not a user-facing pager.
- **The load-more recipe** — one markup for both environments: an intersect
  sentinel plus `pagerAttrs` controls over a `Page<T>`. Server components wire
  the actions on the server; islands wire the same names through
  `useIslandTools`.
- **Plain "load more" button** — when automatic triggering is undesirable or
  the action is expensive; the user controls when the next window loads.
- **Prev/next links** — when the result set is small, order is stable, and deep
  linking to a page matters. `pagerAttrs` builds these in either environment.
