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
new decision, never a cached grant. `user` is `null` unless the plugin is given
a `resolveUser` (below), so a publication whose `authorize` requires a user
cannot be subscribed to until one is configured. The service shares one fan-out driver
(and one membership check per change) among subscriptions with the same
`(publication, params, resolved identity)`, so two users can never share a
driver even when their params match.

## Resolving the user

The transport derives `user` from the Socket.IO handshake itself — the same
cookie or `Authorization` header an HTTP route reads — never from anything the
client puts in its subscribe payload or Socket.IO `auth` object. Pass
`resolveUser` to the plugin; it runs once per connection and receives the
handshake (`headers`, `query`, and a fetch `request`) plus the application's
service registry:

```ts
import { authSessionToken } from '@jsails/auth';
import { livePlugin } from '@jsails/live';

livePlugin({
  registry,
  allowedOrigins: ['https://example.com'],
  resolveUser: async ({ request }, services) => {
    const session = await services.get(authSessionToken).resolveSession(request);
    const user = session?.data.user;
    return user && typeof user.id === 'string' ? { id: user.id } : null;
  },
});
```

A resolver that throws rejects the connection; `null` or `undefined` means
anonymous, and a returned user must carry a non-empty string `id`. The resolved
user and the real request details (IP, origin, headers) reach every
`authorize` call, including the re-authorization a resnapshot performs. Every
`revalidateIntervalMs` (60 s by default; `0` disables it) the resolver runs
again against the connection's original handshake. A socket whose user no
longer resolves, or resolves to a user whose claims differ in any way (a
changed role or tenant, not only a changed `id`), is disconnected, so its
client reconnects and is authorized afresh. When the user is unchanged, every
open subscription runs its `authorize` again; one that is now refused is
closed with an `unauthorized` error while the socket and its other
subscriptions stay open. Subscribers share a fan-out only when their
publication, params, and complete user claims are equal.

The transport admits a connection only from an `allowedOrigins` origin, checked
before the WebSocket upgrade completes. An inbound frame larger than
`maxMessageBytes` closes the socket. It defaults to 16 KiB, or to
`maxParamsBytes` (8 KiB by default) plus 1 KiB when that is larger, and an
explicit value must exceed `maxParamsBytes` by at least 1 KiB, so params over
their cap are answered with `params_too_large` instead of a closed socket. A
publication name longer than 128 characters is refused with `invalid_request`.
Each socket may
send `inboundRate` events per second (20 by default); an event over the rate
is dropped (its acknowledgement, if any, gets `rate_limited`), and a socket
that keeps exceeding it is disconnected.

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
otherwise it sends a full snapshot with `resumed: false`. A sequence the log
has not reached (after a server restart reset the in-memory log, for example)
is treated as lost continuity, not as "nothing to replay". A change to a row that
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

A multi-instance deployment runs over the app's Valkey connections: list
`valkeyPlugin({ url })` (`jsails/plugin-sdk`) ahead of `livePlugin`, or set
`VALKEY_URL`. The change log becomes a shared Valkey
Stream with a deployment-wide sequence, and delivery runs through a stream
tailer because routing locally **and** tailing would otherwise give two delivery
paths with independent timing — a local append could be routed before an
earlier remote append was read, and the client would see sequence 7 before 6.
With the shared log, `deliverLocally` is `false` and the tailer is the only
ordering that holds across instances.

The per-process buffer cannot resume a client that reconnects to a *different*
instance, so without Valkey it degrades to a full snapshot in exactly the
multi-instance topology it exists to serve.

The tailer reads only entries after the last one it delivered, and a burst of
notifications collapses into one read. A snapshot never blocks delivery to
other subscribers: while a snapshot query runs, changes to that publication's
entity are buffered for the new subscriber, the snapshot is stamped with the
shared log's real head (read from Valkey, not a cached value), and the buffered
changes after that head are replayed to the subscriber before it joins the live
fan-out. A change committed on another instance during the query is therefore
delivered, not lost.

## Delivery limits

- `maxRows` (default 1000, at most 10 000) caps a snapshot; the cap is applied
  in the query (`LIMIT maxRows + 1`), so a publication over it fails with
  `too_many_rows` without loading every row.
- Membership checks are batched: each fan-out driver checks a flush's changes
  with one `WHERE id IN (...)` query, and at most `maxConcurrentProbes`
  (default 8) drivers query at once across the service.
- A resume coalesces the replayed slice to the newest change per id and checks
  them in one batched query; a window larger than `maxRows` distinct ids falls
  back to a snapshot.
- `flushIntervalMs` (default 16) is the change-capture coalescing window.
- `onError` receives delivery failures (a failed membership query, or a change
  the change log could not append, for example) as a value-free
  `LiveDeliveryError` (code `io_failed`) alongside the Valkey backend errors.
  It defaults to `process.emitWarning`. A failed append is reported and
  skipped; later changes still publish, and a committed write never waits on
  the change log.

## Tenancy

A publication cannot read a tenant-scoped model: subscribing to one whose
query touches a `tenantScoped` entity (its root or any joined alias) fails
with `unsupported_tenant_scope`. Change capture and fan-out run outside the
writing request's tenant context, so the tenant scope would not narrow what
a subscriber receives. Publish tenant data through a model that is not
tenant-scoped, with the tenant in the publication's params and checked in
`authorize`.

## Wiring

`livePlugin({ registry, ... })` creates a `JsailsPlugin` whose `setup` only
provides the registry; `onServe` opens the change log (in-memory, or the shared
Valkey log when the app has Valkey connections), starts the service against it, and
attaches the Socket.IO transport to the running HTTP server. The registry is a
caller-supplied object — the plugin never owns it — so an application registers
publications before or after plugin construction:

```ts
import { livePlugin } from '@jsails/live';

// ... plugins.use: [['@jsails/live', { registry, allowedOrigins, resolveUser }]]
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