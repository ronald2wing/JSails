---
title: Live Data
order: 36
section: Reference
---

# Live Data

The live layer pushes full-row updates to connected clients over Socket.IO.
It is an Active Record data layer feature, not a general query API: a client
subscribes by **publication name**, never by collection or scope, and the server
decides what each subscriber may see.

The layer is split across two packages:

- `jsails/live` — the contract: publications, the registry, the shape guard,
  change capture, and the wire types (`LiveChange`, `LiveServerMessage`,
  `ChangeLog`). Server-only; it imports TypeORM and must never enter a
  browser-safe island.
- `@jsails/live` — the engine and transport: the live service
  (`createLiveService`), the in-memory and Valkey change logs, and the
  first-party plugin that mounts the Socket.IO transport onto the application's
  HTTP server. `@jsails/live/client` is the browser surface (`useLive`).

## Defining a publication

A publication is a named, parameterized, authorization-gated query. Define one
with `definePublication`, then register it on a registry:

```ts
import { definePublication, createPublicationRegistry } from 'jsails/live';
import { qEq, query } from 'jsails/database';
import { z } from 'zod';

const publications = definePublication({
  name: 'blog.posts',
  collection: 'posts',
  fields: ['id', 'title', 'slug', 'excerpt', 'publishedAt'],
  params: z.object({}).strict(),
  authorize: () => true, // public content; see below
  query: () => query<Post>(Post).where(qEq('status', 'published')).orderBy('publishedAt', 'DESC'),
});

const registry = createPublicationRegistry();
registry.register(publications);
```

`Post` here is the application's own `ApplicationRecord` model (`jsails/models`), not a
framework export.

`collection` is the client-visible key the projected rows are delivered under.
It is stable across deploys; the client reads rows from it by id.

`definePublication` freezes the returned definition and fails closed at
construction time when `authorize` or `query` is missing, when `name` is empty,
or when the definition does not give exactly one of `fields` or `project`. A
hand-written or `as`-cast definition cannot silently deny or throw later.

## Params

`params` is a Zod schema. The server parses the client's params **before**
`authorize` runs, and rejects invalid params (`invalid_params`). Use
`.strict()` to refuse unknown keys, and keep the schema a pure function of the
params — the service documents that a clock-derived predicate is not detectable
by its shape guard and must be caught in review.

## `authorize`

`authorize` is required and default-deny: access is granted only when it returns
exactly `true`. Any other value, a throw, or a rejection denies. It receives the
parsed params, the resolved user, and the request:

```ts
authorize: ({ params, user, request }) =>
  user !== null && user.id === params.ownerId,
```

Authorization is re-evaluated on every connect and reconnect — a reconnect is a
new decision, never a cached grant. The service shares one fan-out driver
(and one membership check per change) among subscriptions with the same
`(publication, params, resolved identity)`, so two users can never share a
driver even when their params match.

## Projection

Each publication sends a full row per change, never a field delta. What a row
contains is an allowlist, so a column added to the table later never reaches a
browser by accident. There is no default that copies every column.

- **`fields`** names the scalar columns each subscriber receives. It must
  include `id`, which the client keys rows by. A name that is not a scalar
  column of the queried entity fails the subscription with
  `invalid_publication_fields`.
- **`project`** is a function from the loaded entity to the row, for derived or
  renamed values. Its result must carry `id`. Related data must be denormalized
  here, since relations are not columns.

A publication gives exactly one of the two.

Because the payload is the complete row, the client replaces its stored row
wholesale. Applying the same change twice is a no-op, and a removed field is
simply absent from the next row.

## Ordering via a position column

Ordering is **not** a protocol concern. A publication that needs order declares
`orderBy` in its `query` and its rows carry a sortable field (`publishedAt`,
`sortOrder`, `position`). The client sorts by that field:

```ts
query: () => query(Post).where(qEq('status', 'published')).orderBy('position', 'ASC'),
```

```ts
import { useLive } from '@jsails/live/client';

const posts = useLive({ publication: 'blog.posts', collection: 'posts' });
const sorted = posts.rows.value.slice().sort((a, b) => a.position - b.position);
```

A reorder is an update to one row's `position` field, which flows through the
ordinary change path. v1 uses a server-assigned integer position; fractional
indexing is a future phase, needed only for conflict-free concurrent reordering.

## Reconnect behavior

The client keeps its last-applied `sequence` across a disconnect and resubscribes
with `resumeFrom` (a positive integer; anything else is an invalid request). The
server replays retained changes when the change log still covers that sequence;
otherwise it sends a full snapshot with `resumed: false`. A change to a row that
does not satisfy the publication is forwarded only to subscribers that held that
row (`row: null` retracts it); a row a subscriber never held is not mentioned at
all, so a publication's predicate also bounds which ids a client can observe.
When a replayed retraction cannot be attributed that way, the server sends a
snapshot instead of guessing.
The hook surfaces a lost-continuity snapshot as status `refreshed`, so the island
shows a refresh rather than silently believing it has full history — a
`refreshed` state is reported only when a snapshot arrives after the client
already held a sequence.

A heartbeat runs every 15 s; 45 s of silence forces a resubscribe. The
reconnect path owns the resubscribe — the heartbeat only detects silence.

## Multi-instance

Run a single instance with the in-memory change log; it delivers its own
appends directly and resumes only clients that reconnect to the same process.

A multi-instance deployment must supply a Valkey URL (via the plugin's
`valkeyUrl` option or `VALKEY_URL`). The change log becomes a shared Valkey
Stream with a deployment-wide sequence, and delivery runs through a stream
tailer because routing locally **and** tailing would otherwise give two delivery
paths with independent timing — a local append could be routed before an
earlier remote append was read, and the client would see sequence 7 before 6.
With the shared log, `deliverLocally` is `false` and the tailer is the only
ordering that holds across instances.

The per-process buffer cannot resume a client that reconnects to a *different*
instance, so without Valkey it degrades to a full snapshot in exactly the
multi-instance topology it exists to serve.

## Wiring

`livePlugin({ registry, ... })` creates a `JsailsPlugin` whose `setup` only
provides the registry; `onServe` opens the change log (in-memory, or the shared
Valkey log when `valkeyUrl` is set), starts the service against it, and
attaches the Socket.IO transport to the running HTTP server. The registry is a
caller-supplied object — the plugin never owns it — so an application registers
publications before or after plugin construction:

```ts
import { livePlugin } from '@jsails/live';

// ... plugins.use: [['@jsails/live', { registry }]]
```

The plugin's `describe()` reports `needsLive: true`, so it is excluded from
static-only builds.

## Design decisions

Payloads are full rows, never field deltas. Every durable system this layer
was modeled against — Firestore, Linear, Debezium, Convex — ships whole
records; Meteor's per-client minimal-diff cache ("mergebox") is cited by its own
community as a reason the Meteor Development Group moved away from it.

Publication membership must be a pure function of a row's own columns:
`limit`, `offset`, and relation/clock predicates are rejected at runtime
rather than supported. A row that can enter or leave a result set without a
write is invisible to the change source, so excluding those predicates keeps
subscriptions cheaply, provably correct. This mirrors the deliberate
narrowing of ElectricSQL and Linear.