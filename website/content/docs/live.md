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

- `jsails/live` — the server surface: publications, the registry, and the
  transport-agnostic service. Server-only; it imports TypeORM and must never
  enter a browser-safe island.
- `@jsails/live` — the first-party plugin that mounts the Socket.IO transport
  onto the application's HTTP server. `@jsails/live/client` is the browser
  surface (`useLive`).

## Defining a publication

A publication is a named, parameterized, authorization-gated query. Define one
with `definePublication`, then register it on a registry:

```ts
import { definePublication, createPublicationRegistry } from 'jsails/live';
import { query } from 'jsails/database';
import { z } from 'zod';

const publications = definePublication({
  name: 'blog.posts',
  collection: 'posts',
  params: z.object({}).strict(),
  authorize: () => true, // public content; see below
  query: () => query(Post).where({ status: 'published' }).orderBy('publishedAt', 'desc'),
});

const registry = createPublicationRegistry();
registry.register(publications);
```

`Post` here is the application's own `ApplicationRecord` model (`jsails/models`), not a
framework export.

`collection` is the client-visible key the projected rows are delivered under.
It is stable across deploys; the client reads rows from it by id.

`definePublication` freezes the returned definition and fails closed at
construction time when `authorize` or `query` is missing (or `name` is empty),
so a hand-written or `as`-cast definition cannot silently deny or throw later.

## Params

`params` is a Zod schema. The server parses the client's params **before**
`authorize` runs, and rejects invalid params (`invalid_params`). Use
`.strict()` to refuse unknown keys, and keep the schema a pure function of the
params — the service documents that a clock-derived predicate is not detectable
by its shape guard and must be caught in review.

## authorize

`authorize` is required and default-deny: access is granted only when it returns
exactly `true`. Any other value, a throw, or a rejection denies. It receives the
parsed params, the resolved user, and the request:

```ts
authorize: ({ params, user, request }) =>
  user !== null && user.id === params.ownerId,
```

Authorization is re-evaluated on every connect and reconnect — a reconnect is a
new decision, never a cached grant. The multiplexer keys fan-out by
`(publication, params, resolved identity)`, so two users can never share a
delivery driver even when their params match.

## Projection

Each publication projects a full row per change — never a field delta. The
default projection (`projectRow`) copies an entity's scalar columns and drops
relations; they are not columns and live on the other side of a foreign key.
A publication can override it with a `project` callback when it needs a custom
shape, and must denormalize any related data it wants on the wire.

Because the payload is the complete row, the client replaces its stored row
wholesale. Applying the same change twice is a no-op, and a removed field is
simply absent from the next row.

## Ordering via a position column

Ordering is **not** a protocol concern. A publication that needs order declares
`orderBy` in its `query` and its rows carry a sortable field (`publishedAt`,
`sortOrder`, `position`). The client sorts by that field:

```ts
query: () => query(Post).where({ status: 'published' }).orderBy('position', 'asc'),
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
with `resumeFrom`. The server replays retained changes when the change log still
covers that sequence; otherwise it sends a full snapshot with `resumed: false`.
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

`livePlugin({ registry, ... })` builds a `JsailsPlugin` whose `setup` constructs
the service from the registry and attaches the Socket.IO adapter via `onServe`.
The registry is a caller-supplied object — the plugin never owns it — so an
application registers publications before or after plugin construction:

```ts
import { livePlugin } from '@jsails/live';

// ... plugins.use: [['@jsails/live', { registry }]]
```

The plugin's `describe()` reports `needsLive: true`, so it is excluded from
static-only builds.

## Design decisions

Payloads are full rows, never field deltas. Every durable system this layer
was modeled against — Firestore, Linear, Debezium, Convex — ships whole
records; Meteor's mergebox minimal-diff is cited by its own community as a
reason MDG moved away from it.

Publication membership must be a pure function of a row's own columns:
`limit`, `offset`, and relation/clock predicates are rejected at runtime
rather than supported. A row that can enter or leave a result set without a
write is invisible to the change source, so excluding those predicates keeps
subscriptions cheaply, provably correct. This mirrors the deliberate
narrowing of ElectricSQL and Linear.