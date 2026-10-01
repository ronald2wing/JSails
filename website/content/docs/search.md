---
title: Search
order: 21
section: Extending
---

# Search

The blog ships with **Orama** as its default search engine. Orama is an
in-process TypeScript search library: typo tolerance, BM25 ranking, filters,
facets, and (optionally) vector search work without another service.

## Defaults and fallback

- **Orama** is the default. It builds its index lazily from published posts and
  updates it after admin saves.
- **Database** is the no-embedded-index fallback. It searches the repository
  directly and needs no service.
- The index is per-process. A multi-instance deployment should choose an
  external engine or rebuild each process against the same content.

## Selecting an engine

`createBlogSearchEngine` is the engine-neutral factory:

```js
import { createBlogSearchEngine } from '@jsails/blog';

const search = createBlogSearchEngine({
  driver: process.env.SEARCH_DRIVER ?? 'orama',
  repository: blogRepository,
  url: process.env.SEARCH_URL,
  apiKey: process.env.SEARCH_API_KEY,
  index: process.env.SEARCH_INDEX,
});
```

Pass the same instance to `blogPlugin({ search })` and
`blogAdmin({ search })`. Supported drivers:

- `orama` — default embedded engine
- `database` — repository search, no service
- `meilisearch`
- `typesense`
- `opensearch`

## Jamal services

External engines are opt-in services in `jamal.config.js`, like Laravel Sail:

```js
services: {
  db: { type: 'mariadb' },
  valkey: { type: 'valkey' },
  search: { type: 'meilisearch' },
},
local: {
  ports: { db: 3306, valkey: 6379, search: 7700 },
},
```

Jamal also supports `typesense` and `opensearch`. Add only the service you
select. Orama and the database driver need no search service.

`SEARCH_DRIVER=meilisearch` with `SEARCH_URL=http://127.0.0.1:7700` is the
first external setup. Typesense requires an API key; OpenSearch is intended for
enterprise/hosted deployments.

## BullMQ

BullMQ is not an embedded queue. It needs **Valkey** (Redis-compatible) in
development and production. JSails uses the same Valkey service for jobs,
cache, and broadcast; a custom in-memory adapter is suitable only for tests or
single-process prototypes.
