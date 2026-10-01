# Live Reactivity Layer — Design

The maintained design record for the live layer: what it guarantees, why it is
shaped the way it is, and which alternatives were rejected. The user-facing
guide is `website/content/docs/live.md`.

Source comments cite this document as `docs/design/live.md §N`. Section numbers
are stable identifiers: renumber only together with every citation.

Where the code lives:

- `jsails/live` (`core/src/live/`) — the contract: the wire record, the server
  message protocol, post-commit change capture, row projection, the publication
  contract and shape guard, the publication registry, and the `ChangeLog`
  interface. Core needs it because `JsailsDataSource` installs the capture and
  plugins (the blog) register publications.
- `@jsails/live` (`packages/live/src/`) — the engine and transport: the live
  service, the write fence, canonical params, the in-memory and Valkey change
  logs, the Valkey change bus and stream tailer, the Socket.IO adapter, the
  plugin, and the browser client (`@jsails/live/client`).

## 1. Summary

A server-authoritative, publication-scoped reactivity layer. A publication is a
named, Zod-validated, authorization-gated query. The server captures committed
row changes, re-reads the affected rows, and pushes **complete projected rows**
over a transport (Socket.IO). Clients keep a normalized `Map<id, row>` per
collection and re-render from signals. There is no client query engine, no
Minimongo, no optimistic UI, and no field-level delta.

Two early decisions were reversed after research:

- **Field-level deltas → full projected rows.** Every production system that
  ships this (Firestore, Linear, Debezium, Convex) sends whole records. The one
  that tried field-level deltas dropped them and observed no behavior change
  (radekmie, "On Oplog Replacement in Meteor"). Meteor's mergebox — the
  machinery that computed minimal field diffs — is cited by its own community as
  a reason MDG abandoned the project.
- **Per-process ring buffer → durable change log.** Resume must survive a
  reconnect to a *different* instance. A per-process buffer cannot, so it
  degrades to a full snapshot in exactly the multi-instance topology it exists
  to serve. Ably, Linear, ElectricSQL, and Supabase all use a shared, bounded,
  persistent log with an explicit "continuity lost" signal.

One constraint narrows the API: **a publication's membership must be a pure
function of its own projected row.** No `limit`, no `offset`, no relation
predicates, no clock-derived predicates. This is enforced at runtime, not
documented as advice. The reason is in §15: without it, a row can enter or leave
a result set without being written, and the change source cannot see that.
Constraining the API makes the problem unrepresentable rather than silently
wrong.

## 2. Goals / Non-goals

### Goals

1. `definePublication({ name, collection, params, authorize, query })` yields a
   live subscription with no client-side query language.
2. Writes are server-authoritative. The client never sends mutations through the
   live channel.
3. Changes are captured **after commit**, never before. A rolled-back write
   produces no change.
4. Payloads are complete projected rows. Applying the same change twice is a
   no-op.
5. Reconnect resumes from a durable offset when the log still covers it,
   otherwise falls back to a snapshot — and the client is told which happened.
6. Multi-instance fan-out through Valkey, with a shared log for replay.
7. Authorization is default-deny, re-evaluated on every connect and reconnect,
   and **never shared across users**.

### Non-goals

- Optimistic UI / client overlays.
- Client query engine, matcher, sorter, Minimongo.
- Field-level deltas (§14 item 4).
- Oplog/binlog/logical-replication tailing.
- Exactly-once delivery. Changes are idempotent; duplicates are harmless.
- Offline persistence, presence, live aggregates.
- Conflict-free concurrent reordering (fractional indexing). Ordering uses a
  server-assigned position column.
- `limit`/`offset` publications, relation-filtered publications (`whereHas`/
  `has`), and clock-derived predicates. Rejected at runtime; see §15.

## 3. Architecture

```text
┌──────────────────────── core/src/live/ (jsails/live) ────────────────────────┐
│  change-record.ts        LiveChange, LiveChangeOperation, LiveRow            │
│  server-message.ts       LiveServerMessage (snapshot | change | error)       │
│  publication.ts          definePublication, contexts, assertPublicationShape │
│  publication-registry.ts createPublicationRegistry, publicationRegistryToken │
│  projection.ts           projectRow(entityClass, row)                        │
│  change-capture.ts       post-commit capture -> LiveChange                   │
│  change-log.ts           ChangeLog / ChangeLogSlice interfaces               │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ installed by core/src/database/data-source.ts (liveCapture)
                │ uses ModelQuery (entity, builder, applied) from model-query.ts
┌───────────────▼──────────────────── packages/live/src/ (@jsails/live) ────────┐
│  live-service.ts         createLiveService (snapshot, fan-out drivers)       │
│  write-fence.ts          createWriteFence (port of Meteor's writefence.js)   │
│  canonical-params.ts     canonicalParams (fan-out key component)             │
│  in-memory-change-log.ts createInMemoryChangeLog (single instance)           │
│  valkey-change-log.ts    createValkeyChangeLog (Streams, deployment-wide)    │
│  valkey-change-bus.ts    createValkeyChangeBus + createStreamTailer          │
│  socket-transport.ts     attachLiveSocket (origin, limits, framing)          │
│  plugin.ts               livePlugin (onServe -> wire capture + adapter)      │
│  client/client-store.ts  createLiveClientStore (normalized Map + signals)    │
│  client/use-live.ts      useLive(publication, params) hook                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Data flow:

```text
Active Record save/remove
  -> TypeORM afterInsert/afterUpdate/afterRemove (INSIDE the transaction)
  -> capture records { entity, id, operation } in the transaction's frame
  -> outermost transaction commits
  -> flush: re-read each affected row by PK
  -> projectRow -> LiveChange (full row, sequence 0)
  -> LiveService.ingest: coalesce by (collection, id), wait on the write fence
  -> ChangeLog.append (assigns the sequence)
  -> route to fan-out drivers -> one membership probe per driver
  -> emit { type: 'change', sequence, collection, id, row | null } per member
  -> client store apply -> signals -> Preact re-render
```

Snapshot flow:

```text
subscribe(publication, params)
  -> Zod parse params
  -> authorize(ctx) must return exactly true
  -> query(ctx) -> assertPublicationShape
  -> fence.beginWrite()
  -> resume replay (log covers resumeFrom) or getMany -> project rows,
     sequence = changeLog.head -> emit snapshot
  -> fence.arm(); fence.endWrite() -> queued changes flush when outstanding === 0
  -> join the fan-out driver for publication + params + identity
```

## 4. Contracts

Frozen descriptors, no `any`, value-free errors.

### 4.1 Change record (`change-record.ts`)

`LiveChange` is `{ sequence, collection, id, operation, row, at }`, with
`operation` one of `insert`/`update`/`delete`, `id` the primary key normalized
to a string, and `row` the complete projected row (`null` for a delete).
`isLiveChange` is a structural guard.

There is no `fields`/`removedFields` pair and no `version`. A full row makes
both unnecessary: the client replaces the row wholesale, so a removed field is
simply absent from the new row. `version` was removed because no such column
exists in the model layer (§14 item 7).

The sequence is assigned by the change log at append time, not by capture:
capture emits `sequence: 0` and the log's stored copy carries the real value.

### 4.2 Publication (`publication.ts`)

A `PublicationDefinition` carries `name`, `collection` (client-visible and
stable across deploys, deliberately not derived from the model name), `params`
(a Zod schema), `authorize` (must return exactly `true`), `query` (returns a
`ModelQuery`), an optional `project` (defaults to `projectRow`), and an optional
per-publication `maxRows`. `authorize` sees `{ params, user, request }`; `query`
additionally sees an `AbortSignal` the service owns.

`definePublication` freezes the definition and rejects, with a value-free
`PublicationDefinitionError`, a definition whose `authorize` or `query` is not a
function or whose `name` is empty — TypeScript checks evaporate at the JS
boundary.

There is no `ordered` flag. Ordering is a position column on the row (§6.3), so
an ordered publication is a publication whose `query` has an `orderBy` and
whose rows carry a sortable field. This deletes the entire LCS move-detection
subsystem.

### 4.2a The shape constraint

A publication's membership must be a pure function of its own projected row.
The service enforces this at subscribe time with `assertPublicationShape`,
after `query(ctx)` returns and before any rows are read. It inspects
`query.builder.expressionMap` and throws `PublicationShapeError` with a code:

- `expressionMap.limit !== undefined` → `unsupported_limit`.
- `expressionMap.offset !== undefined` → `unsupported_offset`.
- An `EXISTS` fragment in `expressionMap.wheres` (what `whereHas`/`has`
  compile to) → `unsupported_relation_predicate`.
- `ModelQuery.applied` is set (any `apply()` call) →
  `unsupported_raw_apply`.

The service maps a rejection to `error: 'unsupported_publication_shape'`.

**Honest limitation.** `limit`/`offset` are detected reliably —
`ModelQuery.limit()` calls `builder.limit()`, which sets `expressionMap.limit`.
The raw QueryBuilder's legacy `take`/`skip` fields are a different API surface
that `ModelQuery` never writes; a guard reading them would silently miss every
`limit`/`offset`. Relation predicates and raw `apply` are detected
heuristically. A clock-derived predicate
(`where(qGt('publishedAt', new Date()))`) is **not** detectable at all — it
compiles to an ordinary `andWhere` fragment indistinguishable from a scalar
comparison. That case is caught by review and by the docs, not by the guard.
See §15.4 for why the alternative (a structural query AST) is out of scope.

The guard runs once per subscription, not per change.

### 4.3 Publication registry (`publication-registry.ts`)

`createPublicationRegistry()` returns `{ register, get, list }`. `register`
performs one documented cast at the storage boundary: a definition is
contravariant in `TParams`, so a concrete definition is not assignable to the
erased `ErasedPublication`; the cast is confined there and callers reach
definitions only through `get()`/`list()`. Duplicate names throw a value-free
`PublicationRegistryError` with `code: 'duplicate_publication'`.

`publicationRegistryToken` lets publication-registering plugins (the blog's
`blog.posts`) reach the registry the live plugin was given, without the app
threading it through (§13.5).

### 4.4 Projection (`projection.ts`)

`projectRow(entityClass, row)` enumerates the scalar columns from the entity's
metadata — columns whose `relationMetadata` is undefined, the same
discriminator dirty tracking uses — copies them, and freezes the result.
Relations are excluded because they are not columns; a JSON column projects
as-is (atomic, not flattened).

### 4.5 Change log (`ChangeLog`, in `change-log.ts`)

```ts
interface ChangeLog {
  append(change: LiveChange): Promise<number>;
  since(sequence: number): Promise<ChangeLogSlice>; // { changes, truncated }
  readonly head: number;
  close(): Promise<void>;
}
```

`truncated` is true when the requested sequence predates the oldest retained
entry: the explicit "continuity lost" signal (§8).

Two implementations in `@jsails/live`:

- `createInMemoryChangeLog` — a per-process ring bounded by count (default
  1000) and approximate bytes (default 5 MiB). Single instance and tests only:
  its sequence is per-process.
- `createValkeyChangeLog` — Valkey Streams, deployment-wide sequence (§9, §13.2).

### 4.6 Write fence (`write-fence.ts`)

```ts
interface WriteFence {
  beginWrite(): void;
  endWrite(): void;
  arm(): void;
  onAllCommitted(callback: () => void): void;
  readonly outstanding: number;
}
```

A port of Meteor's `ddp-server/writefence.js`, with the addition the first
revision missed: `endWrite()`. The fence only works if **both** sides
participate — the snapshot reader and the capture flush. A reader-only fence
counts nothing (§14 item 9). Semantics in §6.4.

### 4.7 Fan-out drivers and the key

Subscriptions that present the same key share one fan-out driver. A driver
holds its members, serializes its deliveries, and probes membership once per
change, then emits to each member under its own subscription id. The key is:

```ts
`${definition.name}:${canonicalParams(params)}:${user?.id ?? 'anonymous'}`
```

It **includes the resolved identity**. Keying on params only leaks rows across
users when `query` filters by `user.id` (§14 item 3).

`canonicalParams` (`packages/live/src/canonical-params.ts`) deep-sorts object
keys, tokenizes `NaN`/`±Infinity`, and length-prefixes the JSON (the key joins
components with `:`, which the JSON may contain). Equal param sets must
serialize identically or they fail to share a driver.

The drivers are private to `createLiveService`; the earlier standalone
`multiplexer.ts` module only counted keys and was folded in when the service
started sharing probes.

### 4.8 Live service (`live-service.ts`)

`createLiveService({ registry, changeLog, maxRows?, flushIntervalMs?, onError?,
deliverLocally? })` returns `{ start, stop, subscribe, ingest, applyRemote }`.

- `subscribe(request, sink)` runs the snapshot flow (§3). `request` carries
  `publication`, `params`, optional `resumeFrom`, and the transport-resolved
  `user` and `request` info (absent means anonymous).
- `ingest(changes)` is the capture listener
  (`dataSource.liveCapture.setListener(service.ingest)`).
- `applyRemote(changes)` delivers changes another process appended to a shared
  log; with a shared log, `deliverLocally: false` makes the tailer the only
  delivery path (§9).

The server message protocol is `LiveServerMessage` in `jsails/live`
(`server-message.ts`), shared with the client:

- `snapshot` — `{ subscriptionId, sequence, rows, resumed }`.
- `change` — `{ subscriptionId, sequence, collection, id, row | null }`.
- `error` — `{ subscriptionId, code }`.

A snapshot always carries `resumed: false`; a successful resume sends replayed
`change` messages and no snapshot. The client therefore reports "refreshed"
when a snapshot arrives after it already held a sequence (§13.3).

Error codes: `unknown_publication`, `invalid_params`, `unauthorized`,
`unsupported_publication_shape`, `too_many_rows`.

**Membership is decided per row, from the row itself.** Because the shape guard
has excluded `limit`, `offset`, relation predicates, and raw `apply`, the only
way a row enters or leaves the set is a write to its own columns. The driver
probes the changed row's primary key against the publication's compiled query;
no match means the row left (`row: null`). No dependency graph, materialized
set, or query re-run is needed (§15).

### 4.9 Client store (`packages/live/src/client/client-store.ts`)

`createLiveClientStore(collection)` holds a normalized `Map<id, row>` for one
collection and exposes `apply(message)`, `rows()`, `subscribe`, and `reset`.
There is one store per collection because a `snapshot` carries no
`collection` — the client knows it from the subscription it opened. A `change`
for another collection is ignored.

### 4.10 `useLive` (`packages/live/src/client/use-live.ts`)

`useLive({ publication, collection, params, ... })` returns signals
`{ rows, status, error }` plus `dispose()`, with `status` one of `connecting` /
`live` / `refreshed` / `error`, so Preact islands re-render.

## 5. Change capture (`change-capture.ts`)

Turning committed ORM writes into `LiveChange` records is the highest-risk part
of the layer. Notes are numbered because source comments cite them.

1. **The hook fires inside the transaction.** `afterInsert`/`afterUpdate`/
   `afterRemove` are TypeORM subscriber events, which fire before commit.
   Publishing from the hook would emit changes for rolled-back writes. The JSails
   `transaction()` wrapper's `afterCommit` does not help: the Active Record path
   never routes through `transaction()` (§14 item 1).

2. **Capture, don't publish.** The hook records `{ entity, id, operation }`
   into a per-transaction buffer keyed by the TypeORM `QueryRunner` **instance**
   (a `WeakMap`). Every event in one transaction carries the same `queryRunner`
   object, so object identity is the correlation key.

3. **Flush only at the outermost commit.** TypeORM implements nested
   transactions as savepoints and broadcasts `AfterTransactionCommit` at
   **every** depth (`PostgresQueryRunner.commitTransaction` releases the
   savepoint, decrements `transactionDepth`, *then* broadcasts). A flat buffer
   would flush a change whose outer transaction can still roll back. The buffer
   is a **stack of frames**, one per depth:

   - `afterTransactionStart` → push a frame.
   - `afterInsert`/`afterUpdate`/`afterRemove` → append to the top frame.
   - `afterTransactionCommit` at depth > 0 → **merge** the top frame into its
     parent, do not flush.
   - `afterTransactionRollback` at depth > 0 → **drop** the top frame.
   - `afterTransactionCommit` at depth 0 → flush the merged frame.
   - `afterTransactionRollback` at depth 0 → drop everything.

   The event carries no depth, so the subscriber tracks it from the
   start/commit/rollback sequence.

4. **Do not double-flush.** The `transaction()` wrapper's `afterCommit` fires
   once at the outermost boundary, but only exists when app code calls
   `transaction()`. The ORM's `afterTransactionCommit` is the single flush
   trigger; wiring both to the same buffer would flush twice.

5. **Re-read, don't trust the payload.** A subscriber event's `changedColumns`
   carries property *names* only, `data` is the caller's dirty patch, and a
   delete's `databaseEntity` may be `{}`. The only reliable source of a
   complete row is a fresh `SELECT` by primary key; a delete yields `row: null`.
   A re-read that returns a *newer* value than this transaction wrote is
   correct: coalescing is last-write-wins by `(collection, id)` and payloads are
   full rows, so the newer row supersedes the intermediate one. The log's
   sequence, not the re-read time, is the ordering authority.

6. **Read the full primary key.** `defineModel` enforces a single generated
   integer key, but `PrimaryColumn` is re-exported from `jsails/models`, so a
   raw-TypeORM model can declare a composite key. The key comes from
   `metadata.primaryColumns`.

7. **Never throw into the write path.** The flush runs after commit; a throwing
   flush would surface as a failed `save()` for a write that succeeded. Errors
   are reported through `onError` and swallowed.

8. **Normalize ids to strings** at capture time. The wire format is string.

9. **The query-builder blind spot.** `QueryBuilder.insert/update/delete` do not
   fire subscriber hooks, so such writes are invisible to the live layer.
   `core/test/live/query-builder-writes.test.ts` fails the build when a
   query-builder write appears in core source. The guard is syntactic, not
   semantic: a query-builder write inside an explicit `transaction()` still
   fires `afterTransactionCommit` with an empty buffer, indistinguishable from a
   transaction that changed nothing (§14 item 13).

10. **Soft deletes are unsupported.** `defineModel` has no soft-delete column,
    so `afterRemove` is always a hard delete. `DeleteDateColumn` is re-exported,
    so a raw-TypeORM model could soft-delete, which fires `afterSoftRemove` —
    not handled.

## 6. Change Semantics

### 6.1 Full-row payloads

A change carries the complete projected row. The client replaces its stored row
wholesale. Consequences:

- A removed field is simply absent from the new row. No `removedFields` array.
- Applying the same change twice is a no-op.
- No client-side merge, no per-field precedence, no mergebox.
- Bandwidth is higher than a field delta. This is the accepted trade: every
  production system that ships this made the same trade (§14).

### 6.2 Coalescing

Within a flush window (`flushIntervalMs`, default 16 ms), changes collapse by
`(collection, id)` with last-write-wins. Because payloads are full rows, this is
a map overwrite. No operation-pair algebra, no insert+delete special cases.

### 6.3 Ordering

Ordering is a **position column on the row**, not a protocol concern.

- A publication that needs order declares `orderBy` in its `query` and its rows
  carry a sortable field (`publishedAt`, `sortOrder`, `position`).
- The client sorts by that field. A reorder is an update to one row's position
  field, which flows through the normal change path.
- Positions are server-assigned. Fractional indexing (Figma, Liveblocks) is
  future work, needed only for conflict-free concurrent reordering.

This deletes LCS move detection entirely. LCS is a text-editing algorithm; it
does not belong in a server-authoritative row store, and it is fragile with
near-duplicate items.

Per-driver delivery is serialized: a slow membership probe for change N cannot
let change N+1 overtake it (§14 item 8).

### 6.4 Write fence

Snapshot and change must not interleave. The fence guarantees:

1. `beginWrite()` before the snapshot query.
2. The ingest path calls `beginWrite()`/`endWrite()` around queuing a flush.
3. Changes arriving during the query are queued.
4. `arm()` after the snapshot is emitted.
5. Queued changes fire only when `outstanding === 0`.

Both sides must participate. A fence with only the reader counts nothing.

## 7. Authorization Model

1. **Default deny.** `authorize` is required by the type and a runtime guard.
2. **Exact `true`.** Any other return value, or a throw, denies. Matches the
   broadcast adapter's `authorizeChannel`.
3. **Params first.** Zod parse runs before `authorize`.
4. **Re-evaluate on reconnect.** A reconnect is a new authorization decision.
5. **Row-level filtering via scopes.** `query` may call `.scope('published')`
   on its `ModelQuery`. Scopes are server-side; clients cannot name them.
6. **No client collection names.** Only registered publication names resolve.
7. **Per-socket limits.** At most 100 open subscriptions per socket plus a
   subscribe rate limit (§10).
8. **Origin check.** An exact-match allowlist, mirroring the broadcast
   adapter's connection check.
9. **Never share a driver across identities.** The fan-out key includes
   `user.id` (§4.7).

Threat model: a malicious client can subscribe to any registered publication
with any params. It cannot run arbitrary queries, cannot name a collection,
cannot bypass `authorize`, cannot see rows outside the publication's scope, and
cannot share another user's driver.

## 8. Reconnect Protocol

Client state per subscription: `{ subscriptionId, sequence }`.

```text
disconnect
  -> client keeps sequence
  -> reconnect
  -> subscribe { publication, params, resumeFrom: sequence }
  -> server:
       if changeLog.since(sequence).truncated: emit snapshot (resumed: false)
       else: replay the changes since sequence (no snapshot)
  -> client applies, updates sequence
```

Rules:

- **Sequence is deployment-wide** with the Valkey log, so resume works across
  instances.
- **Lost continuity is visible.** A snapshot after the client already held a
  sequence shows a "refreshed" state rather than silently claiming full history.
- **Unknown id in a change** is an insert; apply it. `row: null` for an unknown
  id is a no-op.
- **Heartbeat** every 15 s. No message for 45 s forces a reconnect; the
  reconnect path owns the resubscribe.
- **Idempotency.** Applying the same change twice is a no-op.

## 9. Multi-Instance

- **Replay log:** Valkey Streams (`<prefix>:changes`, `XADD MAXLEN ~`,
  `XRANGE` for `since`).
- **Notification:** Valkey pub/sub carries only "the stream advanced"; it is
  fire-and-forget and cannot replay. Using one mechanism for both was the
  first revision's mistake.
- **Cursor:** each instance tails the stream with its own cursor, **not** a
  consumer group (consumer groups are competing consumers; fan-out needs one
  cursor per server).
- **Sequence:** deployment-wide, so resume is instance-agnostic.
- **One delivery path:** with a shared log the service sets
  `deliverLocally: false` and delivers only what the tailer reads. Routing local
  appends *and* tailing gives two paths with independent timing, so a client
  could see sequence 7 before 6.
- **Future:** a Postgres-backed log (Linear's model) if Streams retention proves
  too short.

## 10. Scale Limits

| Limit                         | Default | Enforcement                             |
| ----------------------------- | ------- | --------------------------------------- |
| Subscriptions per socket      | 100     | Socket adapter                          |
| Subscribe attempts per socket | 10/s    | Socket adapter token bucket             |
| Rows per publication snapshot | 1,000   | Live service, `error: 'too_many_rows'`  |
| Hard row cap                  | 10,000  | Live service refuses to start above it  |
| Valkey stream length          | 1,000   | `XADD MAXLEN ~` (`maxChanges` option)   |
| In-memory log entries         | 1,000   | `createInMemoryChangeLog`               |
| In-memory log bytes           | 5 MiB   | `createInMemoryChangeLog`               |
| Flush interval                | 16 ms   | Live service coalescing                 |
| Change payload                | 64 KB   | Socket adapter; oversized forces a snapshot |
| Params payload                | 8 KB    | Socket adapter; oversized rejected      |

Fan-out cost per change is one membership probe per matching driver, not per
subscription: N clients with the same publication, params, and user share one
probe.

## 11. Risks and Traps

1. **Query-builder writes bypass the subscriber.** Mitigation: the grep guard
   (§5 note 9).
2. **The hook fires pre-commit.** Mitigation: capture, then flush after the
   outermost commit (§5 notes 1–3).
3. **The hook payload is not a full row.** Mitigation: re-read by PK after
   commit (§5 note 5).
4. **The fan-out key must include identity.** Otherwise rows leak across users.
5. **The fence needs both sides.** A reader-only fence counts nothing.
6. **No `version` column exists.** Idempotent full-row changes make it
   unnecessary.
7. **Scope leakage.** A publication that forgets `.scope()` exposes all rows.
   Docs show the scoped form first.
8. **Relation serialization.** Default projection excludes relations. A custom
   `project` that includes them can leak or blow up payload size; the adapter
   caps change bytes.
9. **Memory leaks.** Subscriptions close on disconnect, unsubscribe, and auth
   failure.
10. **Savepoint commits fire the commit event.** Mitigation: the depth stack
    (§5 note 3).
11. **Membership churn.** A row can enter or leave a set without being written.
    Mitigation: the shape constraint (§15).

## 12. Future Work

1. **Optimistic UI.** Client overlays with server reconciliation. Needs a
   mutation channel and a rollback protocol.
2. **Fractional indexing.** Conflict-free concurrent reordering (Figma,
   Liveblocks). Only if concurrent reorder is a real requirement.
3. **Postgres-backed change log.** Linear's model, if Streams retention is too
   short.
4. **Postgres LISTEN/NOTIFY source.** Lower latency than the ORM hook. Never
   binlog/logical replication.
5. **Presence.** Built on the same bus.
6. **Live aggregates.** Incremental counts with snapshot fallback.
7. **Offline persistence.** IndexedDB store with a replay queue.
8. **Per-row authorization filters.** A predicate per row, for publications that
   cannot express access as a scope.
9. **Compression.** Batching and compression for large lists.
10. **`limit`/`offset` publications.** Requires re-running the query and diffing
    the result set on every relevant change, because the evicted row was never
    written. Convex rewrote `limit` into pinned range queries; Zero re-engineered
    `limit()` in 1.8. Both are large. Gated on the structural query layer below.
11. **Relation-filtered publications (`whereHas`/`has`).** Requires a
    table→publication dependency graph. `ModelQuery` discards its `Q` tree after
    compiling it (`applyQ`) and `whereHas` emits an opaque `EXISTS` string
    (`applyWhereHas`), so the graph cannot be derived today.
12. **Structural query layer.** A retained AST on `ModelQuery` (instead of
    compiling straight to `SelectQueryBuilder`) is the prerequisite for both 10
    and 11, and for the LISTEN/NOTIFY source. It is a core query-surface change,
    not a live-layer task.

## 13. Transport, Client, and Tooling

### 13.1 Socket.IO transport (`socket-transport.ts`)

`attachLiveSocket(server, service, options)` mounts a dedicated Socket.IO
server on the application's existing `node:http.Server` at `/_jsails/live` — no
second listener, no shared connection or room with the broadcast namespace. Its
security posture mirrors the broadcast adapter rather than inventing a new one:

- an exact-match `Origin` allowlist (required, non-empty); a missing or
  non-matching origin is rejected;
- at most 100 open subscriptions per socket and a 10/s subscribe token bucket;
- params capped at 8 KB (rejected) and change payloads at 64 KB (an oversized
  change replaces the subscription's state with a snapshot);
- the adapter owns `socket → subscriptions` and closes them all on disconnect.

Client events are only `subscribe`/`unsubscribe`; there is no client-to-server
mutation event and no client-named collection. The adapter maps the service's
subscription ids to client-visible ids it owns.

### 13.2 Valkey change log and fan-out (`valkey-change-log.ts`, `valkey-change-bus.ts`)

`createValkeyChangeLog` appends with `XADD MAXLEN ~` under `<prefix>:changes`
(default prefix `jsails:live`) and assigns a deployment-wide sequence from a
counter; `since` reads with `XRANGE` and reports `truncated` for a trimmed-away
sequence. `createValkeyChangeBus` publishes a notification after each append;
`createStreamTailer` reads the stream from its own cursor on each notification
and hands changes to `LiveService.applyRemote` in sequence order. A malformed
stream entry is dropped without throwing. Connection errors are sanitized and
never echo the URL. `livePlugin` selects this shape whenever a Valkey URL is
configured (option or `VALKEY_URL`) and fails the serve on a bad connection
rather than silently degrading to single-instance.

### 13.3 Client store and `useLive`

- No matcher, no sorter, no predicate evaluation in the client. Ordering is the
  consumer's job, using a position field on the row.
- A `change` for an unknown id is an insert (the client may have missed the
  snapshot row); `row: null` for an unknown id is a no-op.
- **`resumed: false` is not the refreshed signal** — every snapshot carries it.
  The hook reports `refreshed` when a snapshot arrives after this client
  already held a sequence, which is the actual lost-continuity case.
- **The heartbeat never re-subscribes on a live socket.** Every `subscribe`
  allocates a new server-side subscription, so re-emitting on each tick would
  leak one per tick. The heartbeat only detects silence and forces a reconnect.
- `UseLiveOptions.extraHeaders` supplies the `Origin` a non-browser caller
  needs; `UseLiveOptions.createSocket` lets a test drive the reconnect decision.
- The browser surface is its own subpath (`@jsails/live/client`): the package
  root mounts the Socket.IO server and connects to Valkey, so a client island
  must not import it.

### 13.4 CLI and packaging

- `jsails live:list` (`core/src/cli/commands/live-list.ts`) prints each
  publication's name, collection, and whether `authorize` is present — never
  params schemas. Publications are registered at runtime by application code,
  and the registry is captured in `livePlugin`'s closure, so the default path
  loads the app config, resolves `plugins.use`, and reports that publications
  are registered at runtime; a `loadRegistry` seam renders the list when an
  embedding runtime or a test supplies a registry.
- `jsails/live` is a `core/package.json` export.

### 13.5 First consumer: the blog

The blog plugin registers `blog.posts` (published posts, ordered by
`publishedAt`) through `publicationRegistryToken`, read with `tryGet` so an app
without the live layer still works. `authorize: () => true` is acceptable only
because the content is public. The starter's live page is a client island, not
a server component: `useLive` opens its socket when the hook runs, which must
not happen during SSR. The blog app config wires `@jsails/live` before
`@jsails/blog` with `{ registry: createPublicationRegistry() }`.

## 14. Revision Log

Recorded so the reasoning survives. Items are numbered continuously and cited
as `§14 item N`.

### Blockers

1. **The hook fires inside the transaction, not after commit.** Revision 1
   justified its error handling with the `transaction()` wrapper's
   `afterCommit` semantics, but the subscriber hooks fire before commit and the
   Active Record path never routes through `transaction()`. **Fix:**
   capture-then-flush (§5).

2. **`ModelQuery` hid its entity class.** The metadata-driven projection had no
   way to reach the metadata. **Fix:** the public `ModelQuery.entity` accessor.

3. **The fan-out key leaked rows across users.** Keying on
   `publication:params` shares one driver between users whose `query` filters
   by `user.id`. **Fix:** include the resolved identity.

### Design reversals

4. **Field-level deltas → full rows.** Firestore, Linear, Debezium, and Convex
   all send whole records. The one system that shipped field-level deltas
   dropped them and observed no behavior change (radekmie, "On Oplog Replacement
   in Meteor"). Meteor's mergebox is cited by its own community as a reason MDG
   abandoned the project. **Fix:** full projected rows.

5. **Per-process ring buffer → durable shared log.** A per-process buffer cannot
   resume a client that reconnects to a different instance, so it degrades to a
   full snapshot in exactly the multi-instance topology it exists to serve.
   Ably, Linear, ElectricSQL, and Supabase all use a shared, bounded, persistent
   log. **Fix:** Valkey Streams with a deployment-wide sequence.

6. **LCS move detection → position column.** LCS is a text-editing algorithm.
   Figma and Liveblocks use fractional indexing; Linear uses a `sortOrder`
   column. **Fix:** a position column on the row.

### Corrections

7. **`@jsails.version` does not exist.** No version column, no version field in
   the model spec. Revision 1 designed dedup and last-write-wins around a
   feature that must first be invented. **Fix:** removed; full-row idempotency
   makes it unnecessary.

8. **Delivery order under slow probes.** Delivery awaits a membership probe,
   so back-to-back changes fired without awaiting could overtake each other and
   the client would apply sequence 2 before 1. **Fix:** a delivery chain per
   fan-out driver.

9. **The write fence had only one side.** Revision 1's `beginWrite → getMany →
   arm` counted nothing, because the capture path never called `beginWrite`.
   **Fix:** `endWrite()` added; the ingest path participates.

10. **No stable params hash existed.** Revision 1 assumed a `stableHash`
    helper; the only hash in `support/` is the async password `hash()`.
    **Fix:** `canonicalParams`, a deterministic serialization rather than a
    hash, so equal params share a driver without collision risk.

### Revision 3 — what revision 2 got wrong

11. **Savepoint commits fire the commit event.** Revision 2 said "flush on
    `afterTransactionCommit`" with a flat buffer keyed by QueryRunner. TypeORM
    broadcasts it at every transaction depth. **Fix:** a depth-stacked buffer,
    flush only at depth zero, merge on savepoint commit, drop on savepoint
    rollback (§5 note 3).

12. **Membership churn was deferred, not solved.** "Re-read by PK and apply
    idempotently" is correct only for rows that are themselves written. A row
    can enter or leave a result set without a write (`limit` eviction, relation
    filters, clock predicates), and the change source cannot see it. **Fix:**
    constrain publications to "membership is a pure function of the row" and
    enforce it at runtime (§15).

13. **The grep guard is syntactic, not semantic.** It does not cover a
    query-builder write inside an explicit `transaction()`, which fires the
    commit event with an empty buffer. **Fix:** documented as a known,
    unfixable-without-a-query-AST gap (§5 note 9).

14. **Composite PKs and soft deletes.** Revision 2 assumed a single integer id
    and hard deletes. `defineModel` enforces both, but `PrimaryColumn` and
    `DeleteDateColumn` are re-exported from `jsails/models`, so raw-TypeORM
    models can escape. **Fix:** read the full key from `metadata.primaryColumns`;
    document soft deletes as unsupported (§5 notes 6, 10).

## 15. Membership Churn

"Re-read by PK and let the client apply changes idempotently" is correct for
rows that are themselves written. It is **silently wrong** for a row that
enters or leaves a publication's result set without being written.

### 15.1 The failure

A publication is a server-side query. The change source reports
`(entity, id, operation)`. Consider:

- `query(Post).where(qEq('status', 'published')).orderBy('publishedAt', 'DESC')`
  with `limit(20)`. A new post is inserted at rank 5. Rank 20 must be removed
  from the client's set. Rank 20 was never written. The change source cannot
  see it.
- `whereHas('author', qEq('active', true))`. Deactivating an author removes all
  their posts from the set. No post row was written.
- `where(qLt('publishedAt', new Date()))`. The clock passes a post's publication
  time. The post enters the set. No write occurred.

In each case the client's set diverges from the server's, permanently, until a
full snapshot. The divergence is invisible: no error, no log, just stale data.

### 15.2 What real systems do

Every system that ships this picked one of three strategies, and the choice
tracks how rich its change source is:

| System      | Strategy                                     | Why it can                                                               |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| Convex      | Re-run the query, diff the result            | Queries are executable functions; it records the read set instrumentally |
| Firestore   | Re-run the query, diff the result            | The query is persisted server-side; both sides diff two full evaluations |
| Zero        | Materialized set, incremental advance        | Consumes Postgres logical replication, so it knows which rows moved      |
| Meteor      | Live cursor with `added`/`changed`/`removed` | Tails the MongoDB oplog, a richer feed than a row hook                   |
| ElectricSQL | `where`-only shapes, delete on unmatch       | Deliberately has no `limit`/`order`                                      |
| Linear      | Subscription-filtered log, client-side sort  | No live `limit`; a list view is "all subscribed rows, sorted locally"    |

The pattern: **the richer the change source, the more the system can infer.**
JSails' change source is a row hook. It knows a row changed; it does not know
which other rows are affected. That is the weakest feed in the table, and it
rules out the first three strategies.

The `limit` case is the tell. Convex had to rewrite `limit` into pinned range
queries because limit-based pagination produces duplicate and missing rows under
reactivity. Zero had to re-engineer `limit()` in 1.8 because 1.7 re-ran the
whole query to find the first 50. ElectricSQL simply does not support it. Nobody
solved live `limit` cheaply.

### 15.3 The decision: constrain the shape

A publication's membership must be a **pure function of its own projected
row**. Concretely, `query` may use:

- `where` with scalar `Q` predicates on the publication entity's own columns.
- `scope(...)`, which compiles to a `Q`.
- `includes(...)` for eager loading (projection still excludes relations).
- `orderBy(...)` — ordering is a client-side sort over a position field (§6.3).

It may **not** use:

- `limit(...)` / `offset(...)` — eviction needs a re-run.
- `whereHas(...)` / `has(...)` — membership depends on another table.
- `apply(...)` — arbitrary SQL defeats every guarantee.
- Clock-derived predicates — membership flips with no write.

With those excluded, the only way a row changes membership is a write to its own
columns, which the capture hook reports and the flush re-reads. The churn cases
become **unrepresentable**, not merely unhandled.

This is the same trade ElectricSQL and Linear made, and it is the only one that
is correct given a row-level change source.

### 15.4 Enforcement, honestly

Three tiers, cheapest first:

1. **Runtime guard.** `assertPublicationShape` reads `expressionMap.limit`/
   `offset` — reliable. It scans `expressionMap.wheres` for `EXISTS` to catch
   relation predicates and reads `ModelQuery.applied` for `apply`. These are
   heuristics.
2. **Docs.** The docs page shows only the scalar-`where` form and states the
   ban explicitly.
3. **Not achievable today.** A clock-derived predicate compiles to an ordinary
   `andWhere` fragment, indistinguishable from a scalar comparison. Catching it
   requires a retained query AST, which `ModelQuery` does not have — `applyQ`
   compiles `Q` straight into the `SelectQueryBuilder` and discards the tree,
   and `applyWhereHas` emits an opaque `EXISTS` string.

A reviewer who wants the clock case caught must build the structural query layer
(§12 item 12), which is a core query-surface change.

### 15.5 What this costs

- A blog index cannot be a live `limit(20)` list. It can be a live list of all
  published posts, sorted client-side, with the client paginating. For a blog
  that is fine; for a feed with 100k rows it is not.
- A publication cannot filter by a relation. It can filter by a denormalized
  column on the row itself (e.g. `authorActive` maintained by the app), which
  makes the dependency explicit and the change visible.
- The `maxRows` cap (1,000 default) bounds the "all rows" case.

The denormalization escape hatch is worth stating in the docs: if you need a
relation filter, put the value on the row. That is a real design pressure, and
it is the same pressure every system in §15.2 applies.
