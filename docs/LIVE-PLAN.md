# JSails Live Reactivity Layer — Implementation Plan

Status: implemented — historical design record. Retained (do not delete): 65 source-comment citations reference its section numbers. See `jsails/live` and `website/content/docs/live.md`.

Revision 3 supersedes revisions 1 and 2. Revision 2's three blockers and two
design reversals are recorded in §14. Revision 3's two defects — savepoint depth
and membership churn — are recorded in §15. Read §15 first if you are reviewing
this plan: it changes the publication contract.

## 1. Summary

Add a server-authoritative, publication-scoped reactivity layer to JSails. A
publication is a named, Zod-validated, authorization-gated query. The server
captures committed row changes, re-reads the affected rows, and pushes
**complete projected rows** over a transport (Socket.IO in v1). Clients keep a
normalized `Map<collection, Map<id, row>>` and re-render from signals. There is
no client query engine, no Minimongo, no optimistic UI, and no field-level
delta in v1.

Two revision-1 decisions were reversed after research:

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

Revision 3 adds one constraint that is not a reversal but a narrowing: **a v1
publication's membership must be a pure function of its own projected row.** No
`limit`, no `offset`, no relation predicates, no clock-derived predicates. This
is enforced at runtime, not documented as advice. The reason is in §15: without
it, a row can enter or leave a result set without being written, and the change
source cannot see that. Constraining the API makes the problem unrepresentable
rather than silently wrong.

What survives from revision 1: the named-publication boundary, server-authoritative
writes, the normalized client store, the write fence, and the multiplexer.

## 2. Goals / Non-goals

### Goals

1. `definePublication(name, { params, authorize, query })` yields a live
   subscription with no client-side query language.
2. Writes are server-authoritative. The client never sends mutations through the
   live channel.
3. Changes are captured **after commit**, never before. A rolled-back write
   produces no change.
4. Payloads are complete projected rows. Applying the same change twice is a
   no-op.
5. Reconnect resumes from a durable offset when the log still covers it,
   otherwise falls back to a snapshot — and the client is told which happened.
6. Multi-instance fan-out through Valkey pub/sub, with a shared log for replay.
7. Authorization is default-deny, re-evaluated on every connect and reconnect,
   and **never shared across users**.
8. No new dependencies. `core/package.json` already carries `socket.io`,
   `socket.io-client`, `ioredis`, `@socket.io/redis-adapter`, `zod`, and
   `@preact/signals`.

### Non-goals (v1)

- Optimistic UI / client overlays. Future phase.
- Client query engine, matcher, sorter, Minimongo.
- Field-level deltas. Reversed; see §14.
- Oplog/binlog/logical-replication tailing.
- Exactly-once delivery. Changes are idempotent; duplicates are harmless.
- Offline persistence.
- Presence, live aggregates.
- Conflict-free concurrent reordering (fractional indexing). v1 uses a server-
  assigned position column.
- `limit`/`offset` publications, relation-filtered publications (`whereHas`/
  `has`), and clock-derived predicates. Rejected at runtime; see §15.
- Live aggregates, presence, offline persistence.

## 3. Architecture

```
┌─────────────────────────────── core/src/live/ ───────────────────────────────┐
│                                                                              │
│  change-record.ts        LiveChange, LiveChangeOperation, LiveRow            │
│  publication.ts          definePublication, PublicationDefinition, contexts  │
│  publication-registry.ts createPublicationRegistry                           │
│  projection.ts           projectRow(entityClass, row)                        │
│  change-capture.ts       post-commit capture -> LiveChange                   │
│  change-log.ts           ChangeLog contract + InMemoryChangeLog              │
│  write-fence.ts          createWriteFence (port of writefence.js)            │
│  multiplexer.ts          createMultiplexer (per publication+params+identity) │
│  live-service.ts         createLiveService (subscribe/snapshot/change)       │
│  index.ts                barrel -> jsails/live                               │
│                                                                              │
└───────────────┬──────────────────────────────────────────────┬───────────────┘
                │ imports                                      │ imports
┌───────────────▼──────────────────┐          ┌────────────────▼───────────────┐
│ core/src/database/               │          │ core/src/broadcast/            │
│  entity-subscribers.ts (hook)    │          │  socketio-adapter.ts (origin,  │
│  data-source.ts (subscriber wire)│          │  auth, max subscriptions)      │
│  model-query.ts (entity accessor)│          │  redis.ts (lazy ioredis)       │
│  transaction.ts (afterCommit)    │          │                                │
└──────────────────────────────────┘          └────────────────────────────────┘
                │
┌───────────────▼────────────────────────────── plugins/live/src/ ─────────────┐
│  plugin.ts          definePlugin, onServe -> attach adapter                  │
│  socket-adapter.ts  Socket.IO namespace, framing, per-socket limits          │
│  valkey-change-log.ts  ValkeyChangeLog (Streams) + pub/sub fan-out           │
│  client-store.ts    createLiveClientStore (normalized Map + signals)         │
│  use-live.ts        useLive(publication, params) client hook                 │
│  index.ts           barrel -> @jsails/live                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Data flow:

```
Active Record save/remove
  -> TypeORM afterInsert/afterUpdate/afterRemove hook (INSIDE the transaction)
  -> capture enqueues { entity, id, operation } into a per-transaction buffer
  -> transaction commits
  -> afterCommit flush: re-read each affected row by PK
  -> projectRow -> LiveChange (full row)
  -> ChangeLog.append (assigns sequence)
  -> Multiplexer fan-out to matching subscriptions
  -> LiveService emits { type: 'change', sequence, collection, id, row | null }
  -> ClientStore.apply -> signals -> Preact re-render
```

Snapshot flow:

```
subscribe(publication, params)
  -> Zod parse params
  -> authorize(ctx) must return exactly true
  -> fence.beginWrite()
  -> query(ctx).getMany()
  -> project rows, read sequence = changeLog.head
  -> emit { type: 'snapshot', sequence, rows }
  -> fence.arm() -> queued changes flush when outstanding === 0
```

## 4. Core Contracts

All contracts live in `core/src/live/`. Frozen descriptors, no `any`, ESM `.js`
extensions, `noUncheckedIndexedAccess` assumed.

### 4.1 `change-record.ts`

```ts
export type LiveChangeOperation = 'insert' | 'update' | 'delete';

export type LiveRow = Readonly<Record<string, unknown>>;

export interface LiveChange {
  /** Monotonic sequence assigned by the change log. */
  readonly sequence: number;
  /** Client-visible collection key from the publication. */
  readonly collection: string;
  /** Primary key, normalized to string. */
  readonly id: string;
  readonly operation: LiveChangeOperation;
  /** Complete projected row. `null` for delete. */
  readonly row: LiveRow | null;
  readonly at: number;
}

export function isLiveChange(value: unknown): value is LiveChange;
```

There is no `fields`/`removedFields` pair and no `version`. A full row makes
both unnecessary: the client replaces the row wholesale, so a removed field is
simply absent from the new row. `version` was removed because no such column
exists in the model layer (§14, defect 7).

### 4.2 `publication.ts`

```ts
import { z } from 'zod';
import type { ModelQuery } from '../database/model-query.js';
import type { LiveRow } from './change-record.js';

export interface LiveUser {
  readonly id: string;
  readonly [claim: string]: unknown;
}

export interface LiveRequestInfo {
  readonly ip: string | null;
  readonly origin: string | null;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface PublicationAuthContext<TParams> {
  readonly params: TParams;
  readonly user: LiveUser | null;
  readonly request: LiveRequestInfo;
}

export interface PublicationQueryContext<TParams> extends PublicationAuthContext<TParams> {
  readonly signal: AbortSignal;
}

export interface PublicationDefinition<TParams, TRow extends object> {
  readonly name: string;
  /** Client-visible collection key. Stable across deploys. */
  readonly collection: string;
  readonly params: z.ZodType<TParams>;
  /** Must return exactly true. Any other value denies. */
  readonly authorize: (
    context: PublicationAuthContext<TParams>,
  ) => boolean | Promise<boolean>;
  readonly query: (context: PublicationQueryContext<TParams>) => ModelQuery<TRow>;
  /** Defaults to projectRow(entityClass, row). */
  readonly project?: (row: TRow) => LiveRow;
  /** Per-publication row cap. Defaults to service maxRows. */
  readonly maxRows?: number;
}

export function definePublication<TParams, TRow extends object>(
  definition: PublicationDefinition<TParams, TRow>,
): PublicationDefinition<TParams, TRow> {
  return Object.freeze({ ...definition });
}
```

`ordered` is gone. Ordering is a position column on the row (§6.3), so an
ordered publication is just a publication whose `query` has an `orderBy` and
whose rows carry a sortable field. The client sorts by that field. This deletes
the entire LCS move-detection subsystem.

### 4.2a The shape constraint

A v1 publication's membership must be a pure function of its own projected row.
The service enforces this at subscribe time, after `query(ctx)` returns:

```ts
export type PublicationShapeErrorCode =
  | 'unsupported_limit'
  | 'unsupported_offset'
  | 'unsupported_relation_predicate'
  | 'unsupported_raw_apply';

export class PublicationShapeError extends Error {
  readonly code: PublicationShapeErrorCode;
  constructor(code: PublicationShapeErrorCode) {
    super('publication shape is not supported by the live layer');
    this.name = 'PublicationShapeError';
    this.code = code;
  }
}

export function assertPublicationShape(query: ModelQuery<object>): void;
```

`assertPublicationShape` inspects `query.builder.expressionMap`:

- `expressionMap.limit !== undefined` → `unsupported_limit`.
- `expressionMap.offset !== undefined` → `unsupported_offset`.
- A relation subquery is present → `unsupported_relation_predicate`. Detection
  is best-effort: `whereHas`/`has` compile to an `EXISTS` fragment in
  `expressionMap.wheres`, so the guard scans those fragments for `EXISTS`.
- `apply()` was used → `unsupported_raw_apply`. `ModelQuery.apply()` currently
  records no flag; when the guard lands (Phase 5), add an `#applied` flag to
  `ModelQuery` at `apply()` and read it here.

**Honest limitation.** `limit`/`offset` are detected reliably — `ModelQuery.limit()`
calls `builder.limit()`, which sets `expressionMap.limit` (and `offset()`
sets `expressionMap.offset`). Note the raw QueryBuilder's legacy `take`/`skip`
fields are a different API surface and are never what `ModelQuery` writes; a
guard reading `take`/`skip` would silently miss every `limit`/`offset`. Relation
predicates and raw `apply` are detected heuristically. A clock-derived predicate
(`where(q => q.gt('publishedAt', new Date()))`) is **not** detectable at all —
it compiles to an ordinary `andWhere` fragment indistinguishable from a scalar
comparison. That case is caught by review and by the docs, not by the guard.
This is stated plainly rather than papered over; see §15.4 for why the
alternative (a structural query AST) is out of scope for v1.

The guard runs once per subscription, not per change. Its cost is negligible.

### 4.3 `publication-registry.ts`

```ts
import type { PublicationDefinition } from './publication.js';

export type ErasedPublication = PublicationDefinition<unknown, object>;

export interface PublicationRegistry {
  register<TParams, TRow extends object>(
    definition: PublicationDefinition<TParams, TRow>,
  ): void;
  get(name: string): ErasedPublication | undefined;
  list(): readonly ErasedPublication[];
}

export function createPublicationRegistry(): PublicationRegistry;
```

`register` performs one documented cast at the storage boundary:

```ts
// Variance: PublicationDefinition is contravariant in TParams, so a concrete
// definition is not assignable to the erased form. The cast is confined here;
// callers only reach definitions through get()/list().
definitions.set(definition.name, definition as unknown as ErasedPublication);
```

Duplicate names throw a value-free `PublicationRegistryError` with
`code: 'duplicate_publication'`.

### 4.4 `projection.ts`

```ts
import type { BaseEntity } from '../database/application-record.js';
import type { LiveRow } from './change-record.js';

export function projectRow(
  entityClass: typeof BaseEntity,
  row: object,
): LiveRow;
```

Implementation enumerates scalar columns from metadata, using the discriminator
already proven in `core/src/database/dirty.ts:63-66`:

```ts
const columns = entityClass
  .getRepository()
  .metadata.columns.filter((column) => column.relationMetadata === undefined)
  .map((column) => column.propertyName);
```

Relations are excluded because they are not columns. Non-data columns
(`@jsails.temporaryDefault`, encrypted columns) are excluded by the same filter
plus an explicit check. The result is frozen.

### 4.5 `change-log.ts`

```ts
import type { LiveChange } from './change-record.js';

export interface ChangeLogSlice {
  readonly changes: readonly LiveChange[];
  /** True when the requested sequence predates the oldest retained entry. */
  readonly truncated: boolean;
}

export interface ChangeLog {
  append(change: LiveChange): Promise<number>;
  since(sequence: number): Promise<ChangeLogSlice>;
  readonly head: number;
  close(): Promise<void>;
}

export interface InMemoryChangeLogOptions {
  readonly maxChanges?: number;
  readonly maxBytes?: number;
}

export function createInMemoryChangeLog(
  options?: InMemoryChangeLogOptions,
): ChangeLog;
```

Defaults: `maxChanges: 1000`, `maxBytes: 5 * 1024 * 1024`. The in-memory
implementation is for single-instance deployments and tests. The Valkey
implementation (§9) is the multi-instance one.

### 4.6 `write-fence.ts`

```ts
export interface WriteFence {
  beginWrite(): void;
  endWrite(): void;
  arm(): void;
  onAllCommitted(callback: () => void): void;
  readonly outstanding: number;
}

export function createWriteFence(): WriteFence;
```

Port of `packages/ddp-server/writefence.js:1-112`, with one addition revision 1
missed: `endWrite()`. The fence only works if **both** sides participate — the
snapshot reader and the change capture. Revision 1 had only the reader, so the
fence counted nothing (§14, defect 5).

### 4.7 `multiplexer.ts`

```ts
import type { LiveChange } from './change-record.js';

export interface Multiplexer {
  /** Returns an unsubscribe function. Identical keys share one driver. */
  register(key: string, handler: (change: LiveChange) => void): () => void;
  close(): Promise<void>;
}

export function createMultiplexer(): Multiplexer;
```

The key is built by the service, not the multiplexer, and **includes the
resolved identity**:

```ts
const key = `${publication.name}:${canonicalParams(params)}:${user?.id ?? 'anonymous'}`;
```

Revision 1 keyed on params only, which leaks rows across users when `query`
filters by `user.id` (§14, defect 4). `canonicalParams` is a new pure helper
(sorted-key `JSON.stringify` of the Zod-parsed params) — it does not exist in
the codebase today and must be written in Phase 4.

### 4.8 `live-service.ts`

```ts
import type { LiveChange, LiveRow } from './change-record.js';
import type { PublicationRegistry } from './publication-registry.js';
import type { ChangeLog } from './change-log.js';

export interface LiveSubscribeRequest {
  readonly publication: string;
  readonly params: unknown;
  /** Last applied sequence, for resume. */
  readonly resumeFrom?: number;
}

export type LiveServerMessage =
  | {
      readonly type: 'snapshot';
      readonly subscriptionId: string;
      readonly sequence: number;
      readonly rows: readonly LiveRow[];
      /** False when the server could not resume and sent a full snapshot. */
      readonly resumed: boolean;
    }
  | {
      readonly type: 'change';
      readonly subscriptionId: string;
      readonly sequence: number;
      readonly collection: string;
      readonly id: string;
      readonly row: LiveRow | null;
    }
  | {
      readonly type: 'error';
      readonly subscriptionId: string;
      readonly code: string;
    };

export interface LiveSubscriptionHandle {
  readonly id: string;
  close(): Promise<void>;
}

export interface LiveServiceOptions {
  readonly registry: PublicationRegistry;
  readonly changeLog: ChangeLog;
  readonly maxRows?: number;
  readonly flushIntervalMs?: number;
}

export interface LiveService {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(
    request: LiveSubscribeRequest,
    sink: (message: LiveServerMessage) => void,
  ): Promise<LiveSubscriptionHandle>;
}

export function createLiveService(options: LiveServiceOptions): LiveService;
```

`resumed: false` on a snapshot is the Ably `resumed: false` signal: the client
knows continuity was lost and can show a "refreshed" state rather than silently
believing it has a complete history.

### 4.9 `plugins/live/src/client-store.ts`

```ts
import type { LiveRow, LiveServerMessage } from 'jsails/live';

export interface LiveClientStore {
  apply(message: LiveServerMessage): void;
  rows(collection: string): ReadonlyMap<string, LiveRow>;
  subscribe(listener: () => void): () => void;
  reset(): void;
}

export function createLiveClientStore(): LiveClientStore;
```

### 4.10 `plugins/live/src/use-live.ts`

```ts
import type { LiveRow } from 'jsails/live';

export interface UseLiveResult {
  readonly rows: readonly LiveRow[];
  readonly status: 'connecting' | 'live' | 'refreshed' | 'error';
  readonly error: string | null;
}

export function useLive(
  publication: string,
  params: Record<string, unknown>,
): UseLiveResult;
```

## 5. Phase-by-Phase Plan

Effort: S = ≤1 day, M = 2–3 days, L = 4–5 days.

### Phase 1 — Change record and projection

**Goal:** The wire type and the metadata-driven row projection.

**Files:**
- `core/src/live/change-record.ts`
- `core/src/live/projection.ts`
- `core/src/live/index.ts` (barrel)
- `core/test/live/change-record.test.ts`
- `core/test/live/projection.test.ts`

**Notes:**
- `projectRow` needs the entity class. `ModelQuery` stores it in a private
  `#entity` field (`core/src/database/model-query.ts:118-119`) with no getter.
  **Add a public `get entity(): typeof BaseEntity` accessor** next to `builder`
  at `:113`. This is a prerequisite for Phase 5 and is the smallest change that
  unblocks projection.
- Projection excludes relations via `relationMetadata === undefined`
  (`core/src/database/dirty.ts:63-66` is the proven pattern).
- Freeze the projected row.

**Tests:**
- `isLiveChange` accepts a well-formed record and rejects each malformed shape.
- `projectRow` includes scalar columns, excludes relations, excludes
  `temporaryDefault` columns, freezes the result.
- A row with a JSON column projects the column as-is (atomic, not flattened).

**Verification:** `npm run build && node --test core/dist/test/live/change-record.test.js core/dist/test/live/projection.test.js`

**Deps:** none.

**Effort:** S.

### Phase 2 — Publication contract and registry

**Goal:** `definePublication` and a registry that rejects duplicates.

**Files:**
- `core/src/live/publication.ts`
- `core/src/live/publication-registry.ts`
- `core/src/live/index.ts` (extend)
- `core/test/live/publication-registry.test.ts`

**Notes:**
- `authorize` is required by the type. A publication without it cannot be
  constructed.
- `collection` is explicit, not derived from the model name, so renames do not
  break clients.
- Registry errors are value-free: `{ code: 'duplicate_publication' }`, no echoed
  names.

**Tests:**
- Register and retrieve by name.
- Duplicate registration throws with the right code.
- `list()` returns frozen definitions.
- A definition missing `authorize` is rejected by a runtime guard.

**Verification:** build + targeted test.

**Deps:** Phase 1.

**Effort:** S.

### Phase 3 — Post-commit change capture

**Goal:** Turn committed ORM writes into `LiveChange` records. This is the
highest-risk phase.

**Files:**
- `core/src/live/change-capture.ts`
- `core/src/database/entity-subscribers.ts` (extend the hook payload)
- `core/src/database/data-source.ts` (wire the capture subscriber)
- `core/test/live/change-capture.test.ts`
- `core/test/live/query-builder-writes.test.ts` (grep guard)

**Notes — the correctness core:**

1. **The hook fires inside the transaction.** `afterInsert`/`afterUpdate`/
   `afterRemove` are TypeORM subscriber events
   (`core/src/database/entity-subscribers.ts:204-232`), which fire before
   commit. Publishing from the hook would emit changes for rolled-back writes.
   Revision 1's `afterCommit` rationale was inert because the Active Record path
   never routes through `transaction()` (§14, defect 1).

2. **Capture, don't publish.** The hook records
   `{ entityClass, id, operation }` into a per-transaction buffer keyed by the
   TypeORM `QueryRunner` **instance** (a `WeakMap<QueryRunner, Frame[]>`). Every
   event in one transaction carries the same `queryRunner` object
   (`node_modules/typeorm/subscriber/event/BaseEvent.d.ts:22`), so object
   identity is the correlation key. Nothing is published yet.

3. **Flush only at the outermost commit — this is the part revision 2 got
   wrong.** TypeORM implements nested transactions as savepoints and broadcasts
   `AfterTransactionCommit` at **every** depth, not just the outermost
   (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:150-158`: the
   savepoint is released, `transactionDepth` is decremented, *then* the event
   fires). A flat buffer would therefore flush a change whose outer transaction
   can still roll back — publishing a row that never existed.

   The buffer is a **stack of frames**, one per transaction depth:

   - `afterTransactionStart` → push a frame.
   - `afterInsert`/`afterUpdate`/`afterRemove` → append to the top frame.
   - `afterTransactionCommit` at depth > 0 → **merge** the top frame into its
     parent, do not flush.
   - `afterTransactionRollback` at depth > 0 → **drop** the top frame.
   - `afterTransactionCommit` at depth 0 → flush the merged frame.
   - `afterTransactionRollback` at depth 0 → drop everything.

   The event carries no depth, so the subscriber tracks it from the
   start/commit/rollback sequence. This is the only correct reading of the
   TypeORM contract, and it is why Phase 3 is L rather than M.

4. **Do not double-flush.** The JSails `transaction()` wrapper has its own
   `afterCommit` (`core/src/database/transaction.ts:178-180`) that fires once at
   the outermost boundary and joins nested calls without savepoints
   (`:212-219`). It is a correct signal, but it only exists when app code calls
   `transaction()`. A plain `save()` never touches it. **Use the ORM's
   `afterTransactionCommit` as the single flush trigger** and leave the wrapper's
   `afterCommit` alone. Wiring both to the same buffer would flush twice.

5. **Re-read, don't trust the payload.** `changedColumns` carries property
   *names* only (`entity-subscribers.ts:274`), and `data` is the caller's dirty
   patch, not the full row. A delete's `databaseEntity` may be `{}`
   (`removeContext`, `:279-282`). The only reliable source of a complete row is
   a fresh `SELECT` by PK. For deletes, the row is gone, so `row: null`.

   A re-read that returns a *newer* value than the one this transaction wrote is
   correct, not a lost change: coalescing is last-write-wins by
   `(collection, id)` and payloads are full rows, so emitting the newer row
   supersedes the intermediate one. The change log's sequence, not the re-read
   time, is the ordering authority.

6. **Read the full primary key, not just `id`.** `defineModel` enforces a single
   generated integer PK (`core/src/models/define-model.ts:131`, rejected
   otherwise at `:374-377`), so the common case is one column. But
   `PrimaryColumn` is re-exported (`core/src/models/index.ts:69`), so a
   raw-TypeORM model can declare a composite key. Read the key from
   `metadata.primaryColumns` and join the values; do not assume one column.

7. **Never throw into the write path.** The flush runs after commit; a throwing
   flush would surface as a failed `save()` for a write that succeeded. Wrap in
   try/catch, report, swallow.

8. **Normalize ids to strings** at capture time. The wire format is string.

9. **The query-builder blind spot.** `entity-subscribers.ts:30-34` documents
   that `QueryBuilder.insert/update/delete` do not fire hooks. Add a grep test
   that fails when a query-builder write appears outside an allowlist. This is
   mandatory, not optional — it is the one failure mode that is silently wrong
   rather than visibly broken.

   **The grep guard is syntactic, not semantic.** A query-builder write *inside*
   an explicit `transaction()` still fires `afterTransactionCommit` — with an
   empty buffer. The guard cannot distinguish that from a transaction that
   changed nothing. Document this: query-builder writes are invisible to the
   live layer, full stop, and the guard only catches the obvious spelling.

10. **Soft deletes are unreachable through `defineModel`.** There is no
    `@DeleteDateColumn` support (`core/src/models/model-schema.ts:216-220`
    rejects the date-default shape), so `afterRemove` is always a hard delete.
    `DeleteDateColumn` is re-exported (`core/src/models/index.ts:70`), so a
    raw-TypeORM model could soft-delete, which fires `afterSoftRemove` — not
    handled. Document the escape hatch as unsupported for live publications.

**Tests:**
- Insert/update/delete each produce one `LiveChange` with a full row.
- A rolled-back transaction produces **no** change.
- **A savepoint rollback inside a committed outer transaction produces no
  change for the rolled-back rows** (the depth-stack test).
- **A savepoint commit inside a transaction that later rolls back produces no
  change** (the flush-only-at-depth-zero test).
- A throwing flush does not fail the `save()`.
- A delete produces `row: null`.
- A bulk `save([a, b, c])` produces three changes from one flush.
- The grep guard fails on a planted query-builder write.

**Verification:** build + targeted tests + a `FileDataSource` integration test.

**Deps:** Phase 1.

**Effort:** L.

### Phase 4 — Change log, write fence, multiplexer

**Goal:** The in-process plumbing between capture and the service.

**Files:**
- `core/src/live/change-log.ts`
- `core/src/live/write-fence.ts`
- `core/src/live/multiplexer.ts`
- `core/src/live/canonical-params.ts`
- `core/test/live/change-log.test.ts`
- `core/test/live/write-fence.test.ts`
- `core/test/live/multiplexer.test.ts`
- `core/test/live/canonical-params.test.ts`

**Notes:**
- `ChangeLog` is a bounded ring buffer in memory, bounded by count and bytes.
  `since` reports `truncated` when the requested sequence predates the oldest
  retained entry.
- `WriteFence` is a port of `packages/ddp-server/writefence.js:1-112` plus
  `endWrite()`. Both the snapshot reader and the capture flush must call
  `beginWrite`/`endWrite`, or the fence counts nothing.
- `canonicalParams` is new: sorted-key `JSON.stringify` of Zod-parsed params.
  It must be deterministic across key order, number formatting, and nested
  objects, or two equal param sets fail to multiplex.
- The multiplexer key includes the resolved identity (§4.7).

**Tests:**
- Log: append, `since` in range, `since` before oldest reports truncated, byte
  cap evicts oldest.
- Fence: queued callbacks fire only after `arm()` and `outstanding === 0`;
  `endWrite` decrements; a write begun before `arm` still blocks the flush.
- Multiplexer: same key shares one handler; different identity does not share.
- `canonicalParams`: key order, nested objects, numbers vs strings.

**Verification:** build + targeted tests.

**Deps:** Phase 1.

**Effort:** M.

### Phase 5 — Live service

**Goal:** Snapshot + change orchestration, transport-agnostic.

**Files:**
- `core/src/live/live-service.ts`
- `core/test/live/live-service.test.ts`

**Notes:**
- Snapshot order: parse params → `authorize` → **`assertPublicationShape`** →
  `fence.beginWrite` → `getMany` → project → emit snapshot → `fence.arm`.
- The shape guard runs after `query(ctx)` returns and before any rows are read.
  A rejected shape emits `error: 'unsupported_publication_shape'` and closes the
  subscription. It is not a warning.
- The capture flush calls `fence.beginWrite`/`endWrite` around its publish, so a
  change committing during the snapshot query is queued, not lost.
- Coalesce within the flush window by `(collection, id)`: last write wins.
  Because payloads are full rows, coalescing is a simple map overwrite — no
  operation-pair algebra.
- Enforce `maxRows`; exceeding it emits `error: 'too_many_rows'`.
- Resume: if `resumeFrom` is present and the log covers it, emit the changes
  since then with `resumed: true`; otherwise emit a snapshot with
  `resumed: false`.
- **Membership is decided per row, from the row itself.** Because the shape
  guard has excluded `limit`, `offset`, relation predicates, and raw `apply`,
  the only way a row enters or leaves the set is a write to its own columns.
  The service therefore does not need a dependency graph, a materialized set, or
  a query re-run. This is the whole point of the constraint (§15).

**Tests:**
- Snapshot then change for insert, update, delete.
- A change committing during the snapshot query is delivered after the snapshot.
- Coalescing collapses two updates into one.
- `maxRows` exceeded emits the error.
- Unauthorized subscribe emits `error: 'unauthorized'`.
- Resume within the log window emits changes with `resumed: true`.
- Resume outside the window emits a snapshot with `resumed: false`.
- A publication using `limit` is rejected with `unsupported_limit`.
- A publication using `offset` is rejected with `unsupported_offset`.
- A publication using `whereHas` is rejected with
  `unsupported_relation_predicate`.
- A publication using `apply` is rejected with `unsupported_raw_apply`.
- A row that stops matching a scalar `where` (e.g. `status` flips from
  `published` to `draft`) is removed from the client set — the change carries
  `row: null` because the re-read no longer matches the predicate.

**Verification:** build + targeted tests.

**Deps:** Phases 2, 3, 4.

**Effort:** L.

### Phase 6 — Socket.IO live adapter

**Goal:** The transport, reusing the broadcast adapter's security posture.

**Files:**
- `plugins/live/package.json`
- `plugins/live/tsconfig.json`
- `plugins/live/jsails.plugin.json`
- `plugins/live/src/plugin.ts`
- `plugins/live/src/socket-adapter.ts`
- `plugins/live/src/index.ts`
- `plugins/live/test/socket-adapter.test.ts`

**Notes:**
- Reuse the origin check (`core/src/broadcast/socketio-adapter.ts:335-346`) and
  `DEFAULT_MAX_SUBSCRIPTIONS = 100` (`:51`).
- Add a subscribe rate limit (10/s per socket).
- The adapter owns `Map<socketId, Set<subscriptionId>>` and clears it on
  `disconnect`.
- Client messages: `subscribe` / `unsubscribe`. Server messages: the
  `LiveServerMessage` union.
- Cap params at 8 KB and a change payload at 64 KB; an oversized change forces a
  snapshot.

**Prerequisite (ordering correction, added during implementation):** the plugin
imports the core contract through `jsails/live`, which `core/package.json` does
not export until Phase 9. Move three of Phase 9's wiring items into this phase
as prerequisites: add `./live` to `core/package.json` `exports`, add
`jsails/live` to `core/jsails.plugin.json` `provides` (the two must stay equal —
a test enforces this), and insert `@jsails/live` into the root `package.json`
build/test/typecheck chains after `@jsails/blog` and before `@jsails/tenancy`.
Phase 9 keeps the `live:list` command, the docs page, and its
starter/website verification.

**Tests:**
- Subscribe receives a snapshot.
- A write produces a change on the socket.
- Disconnect closes every subscription.
- Exceeding `maxSubscriptions` is rejected.
- Oversized params are rejected.

**Verification:** build + in-process Socket.IO client/server test.

**Deps:** Phase 5.

**Effort:** M.

### Phase 7 — Valkey change log and fan-out

**Goal:** Multi-instance. This is where revision 1 was wrong.

**Files:**
- `plugins/live/src/valkey-change-log.ts`
- `plugins/live/test/valkey-change-log.test.ts`
- `plugins/live/test/valkey-change-log-live.test.ts` (env-gated)

**Notes:**
- **Two separate mechanisms, deliberately.** Valkey pub/sub carries the live
  push (sub-millisecond, fire-and-forget). Valkey **Streams** carries the replay
  log (`XADD` with `MAXLEN ~`, `XRANGE` for `since`). Pub/sub cannot replay;
  Streams can. Using one for both is the mistake revision 1 made.
- Stream key `jsails:live:changes`, trimmed by `MAXLEN ~ 10000`.
- Each instance reads the stream with its own cursor — **not** a consumer group.
  Consumer groups are competing consumers; fan-out needs one independent cursor
  per server.
- The sequence is the stream entry id, so it is **deployment-wide**, not
  per-process. This is what makes cross-instance resume work.
- Reuse the lazy ioredis pattern (`core/src/broadcast/redis.ts:86-128`) and
  sanitized errors (`:147-155`).
- A malformed stream entry is dropped without throwing.

**Tests:**
- Two logs over a fake stream deliver a change to both.
- `since` returns entries after a given id.
- A trimmed-away id reports `truncated`.
- A live Valkey test (gated by `JSAILS_TEST_VALKEY=1`) round-trips a change.
- A malformed entry is dropped.

**Verification:** build + unit tests; live test when Valkey is available.

**Deps:** Phase 4.

**Effort:** M.

### Phase 8 — Client store and `useLive`

**Goal:** The browser side.

**Files:**
- `plugins/live/src/client/client-store.ts`
- `plugins/live/src/client/use-live.ts`
- `plugins/live/src/client/index.ts` (the `./client` subpath barrel)
- `plugins/live/test/client-store.test.ts`
- `plugins/live/test/use-live.test.ts`

**Notes:**
- Normalized `Map<id, row>` **per collection**. No matcher, no sorter, no
  predicate evaluation. Ordering is the consumer's job, using a position field
  on the row.
- **One store per collection, not one store keyed by collection.** A `snapshot`
  message carries no `collection` field (§4.8) — the client knows it from the
  subscription it opened — so the store is bound at construction. A `change`
  does carry one, and a change for another collection is ignored.
- `apply` handles `snapshot`, `change`, `error`.
- A `change` for an unknown id is an insert (the client may have missed the
  snapshot row); apply it. A `change` with `row: null` for an unknown id is a
  no-op.
- `useLive` returns a signals-backed result so Preact islands re-render.
- The browser surface is a separate subpath (`@jsails/live/client`): the package
  root mounts the Socket.IO server and connects to Valkey, so a client island
  must not import it.

**Tests:**
- Snapshot populates the store.
- Change applies insert/update/delete.
- Applying the same change twice is a no-op.
- A change for an unknown id inserts.
- A reconnect that falls back to a snapshot sets status `refreshed`.

**Defects found while implementing (both fixed):**
- **`resumed: false` is not the refreshed signal.** The service sends
  `resumed: false` on *every* snapshot — a successful resume emits replayed
  changes and no snapshot at all — so reading the flag marked every first
  connect as `refreshed`. The hook now reports `refreshed` when a snapshot
  arrives after this client already held a sequence, which is the actual
  lost-continuity case.
- **The heartbeat re-subscribed on a live socket.** Every `subscribe` allocates
  a new server-side subscription, so re-emitting on each tick leaked one
  subscription per tick instead of resuming. The heartbeat now only detects
  silence and forces a reconnect; the reconnect path owns the resubscribe.

**Deviations:**
- `UseLiveOptions.extraHeaders` and `UseLiveOptions.createSocket` are injection
  seams. The first supplies the `Origin` the adapter's allowlist requires from a
  non-browser caller (a browser sends its own); the second lets a test drive the
  reconnect decision without a transport drop, which `socket.io-client` does not
  expose to the server side.

**Verification:** build + targeted tests (15 store, 9 hook).

**Deps:** Phase 5.

**Effort:** M.

### Phase 9 — CLI, packaging, docs

**Goal:** Make the layer discoverable and shippable.

**Files:**
- `core/src/cli/command-catalog.ts` (add `live:list`, following `:50-198`)
- `core/src/live/index.ts` (final barrel; the `./live` export, `provides`
  entry, and root-chain insertion moved into Phase 6 as prerequisites)
- `website/content/docs/live.md`
- `core/test/cli/live-list.test.ts`

**Notes:**
- `jsails live:list` prints name, collection, and whether `authorize` is
  present. It does not print params schemas.
- Docs cover: defining a publication, params, authorize, projection, ordering
  via a position column, reconnect behavior, and the multi-instance caveat.

**Tests:**
- `live:list` output includes a registered publication.
- Export/provides equality test passes.
- Website check passes.

**Deviations:**
- **`core/src/cli/live-commands.ts` is a new file.** The catalog's `load()`
  thunk dynamic-imports it, so the runner cannot live in the catalog itself.
- **The command is honest about what it cannot see.** Publications are
  registered at runtime by application code; the registry is a caller-supplied
  object captured in `livePlugin`'s closure and is never surfaced through
  `setup`, `PluginContext`, or `PluginDescription`. The default path therefore
  loads the app config, resolves `plugins.use`, and reports that publications
  are registered at runtime. A `loadRegistry` dependency seam renders the
  name/collection/authorize list when an embedding runtime (or a test) supplies
  a registry.
- **The catalog entry alone does not make a command reachable.** `index.ts`
  gates dispatch through hardcoded command sets, so `live:list` needed a
  `LIVE_COMMANDS` set, an `isBuiltinCommand` entry, a help line, a dispatch
  branch (via the existing `parseCustomInvocation` for `--config`), and a
  required-command message entry. Two routing tests in `core/test/cli/cli.test.ts`
  assert the command is reachable and listed in `--help`; removing the dispatch
  branch makes the first one fail.

**Verification:** `npm run check`, `npm --prefix website run check`,
`npm run verify:starter -- --skip-browser`.

**Deps:** Phase 8.

**Effort:** M.

### Phase 10 — First consumer, starter, full verification

**Goal:** Prove the layer on a real feature.

**Files:**
- `plugins/blog/src/plugin.ts` (register `blog.posts`; follow `schema.entities`
  at `:269` and `configureHttp` at `:292`)
- `templates/starter-web/` (a live page using `useLive`)
- `scripts/verify-starter.mjs` (update expected key sets/counts)
- `core/test/app/starter.test.ts`
- `core/test/cli/create-cli.test.ts`
- `plugins/blog/test/live-publication.test.ts`

**Notes:**
- The blog publication is
  `definePublication({ name: 'blog.posts', collection: 'posts', params: z.object({}).strict(), authorize: () => true, query: () => query(JsailsContentPost).where(qEq('status', 'published')).orderBy('publishedAt', 'DESC') })`.
  `authorize: () => true` is acceptable only because the content is public; add
  a comment saying so.
- The starter page renders the live list and a connection status badge.
- Update starter file counts in `scripts/verify-starter.mjs` and the two tests.
  The starter whitelist is fixed.

**Deviations:**
- **`definePublication` takes one options object**, not `(name, options)`, and
  `where` takes a `Q` predicate (`qEq`), not a plain object. The plan's sketch
  was wrong on both.
- **A registry token was required.** The blog plugin had no way to reach the
  registry, so `publicationRegistryToken` was added to
  `core/src/live/publication-registry.ts` and the live plugin provides the
  caller-supplied registry under it during `setup`. The blog plugin reads it
  with `tryGet`, so an app that does not run the live layer still works — the
  publication simply is not registered.
- **`@jsails/live` re-exports the core contract.** The plugin barrel previously
  exported only the transport, so an app config could not import
  `createPublicationRegistry` from the same specifier it passes to
  `plugins.use`. The barrel now re-exports the contract from `jsails/live`.
- **The starter page is a client island, not a server component.** `useLive`
  opens its socket when the hook runs, which must not happen during SSR.
  Islands hydrate only in the browser, so `pages/live.tsx` renders static
  markup and `ui/live-posts.tsx` is registered in `client/main.tsx`.
- **File counts moved 51→53 and 54→56** (the page and the island), across
  `scripts/verify-starter.mjs`, `core/test/app/starter.test.ts`, and
  `core/test/cli/create-cli.test.ts`. `@jsails/live` was also added to the
  web-base dependencies and to `ADMIN_PLUGINS` in the verify harness, which
  packs every workspace plugin a fixture installs.
- **The blog app config wires the live plugin** before `@jsails/blog`, passing
  `{ registry: createPublicationRegistry() }`.

**Tests:**
- Blog publication returns published posts only.
- Starter verification passes with the new page.
- Full `npm run check`.

**Verification:** the full gate from `core/AGENTS.md`:
1. `npm run format`
2. `npm run lint`
3. `npm run build:clean`
4. `npm run check`
5. `npm run verify:starter -- --skip-browser`
6. `npm --prefix website run check`

**Deps:** Phase 9.

**Effort:** L.

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

Within a flush window, collapse by `(collection, id)` with last-write-wins.
Because payloads are full rows, this is a map overwrite. No operation-pair
algebra, no insert+delete special cases.

### 6.3 Ordering

Ordering is a **position column on the row**, not a protocol concern.

- A publication that needs order declares `orderBy` in its `query` and its rows
  carry a sortable field (`publishedAt`, `sortOrder`, `position`).
- The client sorts by that field. A reorder is an update to one row's position
  field, which flows through the normal change path.
- v1 uses a server-assigned integer position. Fractional indexing (Figma,
  Liveblocks) is a future phase, needed only for conflict-free concurrent
  reordering.

This deletes LCS move detection entirely. LCS is a text-editing algorithm; it
does not belong in a server-authoritative row store, and it is fragile with
near-duplicate items.

### 6.4 Write fence

Snapshot and change must not interleave. The fence guarantees:

1. `beginWrite()` before the snapshot query.
2. The capture flush calls `beginWrite()`/`endWrite()` around its publish.
3. Changes arriving during the query are queued.
4. `arm()` after the snapshot is emitted.
5. Queued changes fire only when `outstanding === 0`.

Both sides must participate. A fence with only the reader counts nothing.

## 7. Authorization Model

1. **Default deny.** `authorize` is required by the type.
2. **Exact `true`.** Any other return value denies. Matches `authorizeChannel`
   (`core/src/broadcast/socketio-adapter.ts:443-457`).
3. **Params first.** Zod parse runs before `authorize`.
4. **Re-evaluate on reconnect.** A reconnect is a new authorization decision.
5. **Row-level filtering via scopes.** `query` may call `.scope('published')`
   (`core/src/database/model-query.ts:199`). Scopes are internal; clients cannot
   name them.
6. **No client collection names.** Only registered publication names resolve.
7. **Per-socket limits.** `DEFAULT_MAX_SUBSCRIPTIONS = 100` plus a subscribe
   rate limit.
8. **Origin check.** Reuse the broadcast adapter's origin validation
   (`:335-346`).
9. **Never share a driver across identities.** The multiplexer key includes
   `user.id` (§4.7). This is the fix for the revision-1 leak.

Threat model: a malicious client can subscribe to any registered publication
with any params. It cannot run arbitrary queries, cannot name a collection,
cannot bypass `authorize`, cannot see rows outside the publication's scope, and
cannot share another user's driver.

## 8. Reconnect Protocol

Client state per subscription: `{ subscriptionId, sequence }`.

```
disconnect
  -> client keeps sequence
  -> reconnect
  -> send { type: 'subscribe', publication, params, resumeFrom: sequence }
  -> server:
       if changeLog.since(sequence).truncated: emit snapshot, resumed: false
       else: emit changes since sequence, resumed: true
  -> client applies, updates sequence
```

Rules:

- **Sequence is deployment-wide** (the Valkey stream id), so resume works across
  instances. This is the fix for revision 1's per-process epoch.
- **`resumed: false`** tells the client continuity was lost. It shows a
  "refreshed" state rather than silently believing it has full history.
- **Unknown id in a change** is an insert; apply it.
- **Heartbeat** every 15s. No message for 45s forces a resubscribe.
- **Idempotency.** Applying the same change twice is a no-op.

## 9. Multi-Instance

- **Live push:** Valkey pub/sub on `jsails:live:changes`. Fire-and-forget,
  sub-millisecond.
- **Replay:** Valkey Streams on the same key, `MAXLEN ~ 10000`. Each instance
  reads with its own cursor, not a consumer group.
- **Sequence:** the stream entry id. Deployment-wide, so resume is
  instance-agnostic.
- **Fan-out:** local subscribers receive changes from both local writes and
  remote stream entries. Duplicates are harmless because changes are idempotent.
- **Ordering:** the stream gives a total order. Cross-instance ordering is
  therefore coherent, unlike revision 1's per-process sequences.
- **Future:** a Postgres-backed log (Linear's model) if Streams retention proves
  too short.

## 10. Scale Limits

| Limit | Default | Enforcement |
| --- | --- | --- |
| Subscriptions per socket | 100 | Adapter, reuses `DEFAULT_MAX_SUBSCRIPTIONS` |
| Subscribe attempts per socket | 10/s | Adapter token bucket |
| Rows per publication snapshot | 1,000 | `LiveService`, `error: 'too_many_rows'` |
| Hard row cap | 10,000 | `LiveService`, refuses to start above this |
| Change log entries | 10,000 | Valkey `MAXLEN ~` |
| In-memory log entries | 1,000 | `InMemoryChangeLog` |
| In-memory log bytes | 5 MB | `InMemoryChangeLog` |
| Flush interval | 16 ms | `LiveService` coalescing |
| Change payload | 64 KB | Adapter; oversized forces a snapshot |
| Params payload | 8 KB | Adapter; oversized rejected |

Fan-out cost is `O(subscriptions × distinct ids)` per flush. The multiplexer
shares one driver per `(publication, params, identity)`, so N clients with the
same params and the same user cost one query.

## 11. Risks and Traps

1. **Query-builder writes bypass the subscriber.** `entity-subscribers.ts:30-34`.
   Mitigation: the grep guard test (Phase 3), mandatory.
2. **The hook fires pre-commit.** Publishing from the hook emits changes for
   rolled-back writes. Mitigation: capture-then-flush-after-commit (Phase 3).
3. **The hook payload is not a full row.** `changedColumns` is names only
   (`:274`); `data` is a dirty patch; a delete's `databaseEntity` may be `{}`
   (`:279-282`). Mitigation: re-read by PK after commit.
4. **`ModelQuery` hides its entity.** `#entity` at `model-query.ts:118-119`.
   Mitigation: add a public accessor (Phase 1).
5. **Multiplexer key must include identity.** Otherwise rows leak across users.
6. **The fence needs both sides.** A reader-only fence counts nothing.
7. **No `version` column exists.** Do not design around one. Idempotent full-row
   changes make it unnecessary.
8. **Snapshot/change race.** The fence closes it only if capture participates.
9. **Scope leakage.** A publication that forgets `.scope()` exposes all rows.
   Docs show the scoped form first.
10. **Relation serialization.** Default projection excludes relations. A custom
    `project` that includes them can leak or blow up payload size. Cap bytes.
11. **Id type mismatch.** Normalize to string at capture.
12. **Memory leaks.** Close subscriptions on disconnect, unsubscribe, and auth
    failure.
13. **Starter file counts.** Adding a starter page changes the whitelist counts
    in three places.
14. **Savepoint commits fire the commit event.** `AfterTransactionCommit`
    broadcasts at every depth (`PostgresQueryRunner.js:150-158`). A flat buffer
    flushes non-durable changes. Mitigation: the depth stack (Phase 3, note 3).
15. **Membership churn.** A row can enter or leave a set without being written.
    Mitigation: the shape constraint (§15).

## 12. Future Phases

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
    compiling to SQL (`query-expressions.ts:460-471`) and `whereHas` emits an
    opaque `EXISTS` string (`relation-query.ts:259-268`), so the graph cannot be
    derived today.
12. **Structural query layer.** A retained AST on `ModelQuery` (instead of
    compiling straight to `SelectQueryBuilder`) is the prerequisite for both 10
    and 11, and for the LISTEN/NOTIFY source. It is a core query-surface change,
    not a live-layer task.

## 13. Verification Strategy

### Per-phase

- **Phases 1–2:** pure unit tests, no I/O.
- **Phase 3:** `FileDataSource` integration tests, including a rollback test and
  the grep guard.
- **Phase 4:** in-memory log, fake clock, fence boundary tests.
- **Phases 5–6:** Socket.IO client/server in-process, simulated disconnects.
- **Phase 7:** two logs over a fake stream; live Valkey test env-gated.
- **Phase 8:** authorization matrix and idempotency.
- **Phase 9:** CLI output, export/provides equality, website check.
- **Phase 10:** full gate.

### Full gate (from `core/AGENTS.md`)

```sh
npm run format
npm run lint
npm run build:clean
npm run check
npm run verify:starter -- --skip-browser
npm --prefix website run check
```

### Clean-checkout check

```sh
git archive HEAD | tar -x -C /tmp/check && cd /tmp/check && npm ci && npm run check
```

### Structure check

Every new path must pass `scripts/check-src-structure.mjs`: no `utils.ts`,
`helpers.ts`, `internal.ts`; no `-helpers`/`-shared`/`-utils`/`-common`/`-misc`
suffixes; no basename collisions. The proposed names pass.

### Evidence standard

A passing build is not QA for a behavior change. Each phase needs at least one
behavioral test that fails before the change and passes after. Phase 3 needs a
rollback test; Phase 5 needs a snapshot-race test; Phase 7 needs a
cross-instance resume test.

## 14. Revision Log — what revision 1 got wrong

Recorded so the reasoning survives.

### Blockers

1. **The hook fires inside the transaction, not after commit.** Revision 1
   justified its try/catch with `transaction.ts:25-38` `afterCommit` semantics.
   But the subscriber hooks are TypeORM `afterInsert`/`afterUpdate`/`afterRemove`
   (`entity-subscribers.ts:204-232`), which fire before commit, and the Active
   Record path never routes through `transaction()`. Publishing from the hook
   would emit changes for rolled-back writes. **Fix:** capture-then-flush.

2. **`ModelQuery` hides its entity class.** `#entity` at
   `model-query.ts:118-119`, no getter. Revision 1's metadata-driven projection
   had no way to reach the metadata. **Fix:** add a public accessor.

3. **The multiplexer key leaked rows across users.** Keying on
   `publication:params` shares one driver between users whose `query` filters by
   `user.id`. **Fix:** include the resolved identity.

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

7. **`@jsails.version` does not exist.** No `VersionColumn`, no version field in
   the model spec. Revision 1 designed dedup and last-write-wins around a
   feature that must first be invented. **Fix:** removed; full-row idempotency
   makes it unnecessary.

8. **`stableHash` does not exist.** Only an async password `hash()` in
   `support/cryptography.ts:84`. **Fix:** `canonicalParams` is new work in
   Phase 4.

9. **The write fence had only one side.** Revision 1's `beginWrite → getMany →
   arm` counted nothing, because the capture path never called `beginWrite`.
   **Fix:** `endWrite()` added; capture participates.

10. **Citation corrections.** `.scope()` is on `ModelQuery`
    (`model-query.ts:199`), not `scopes.ts:97` (which is the registrar).
    `data-source.ts:200-219` is the subscriber wire, not `:182-220`.

### Revision 3 — what revision 2 got wrong

11. **Savepoint commits fire the commit event.** Revision 2 said "flush on
    `afterTransactionCommit`" with a flat buffer keyed by QueryRunner. But
    TypeORM broadcasts `AfterTransactionCommit` at **every** transaction depth
    (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:150-158`:
    release savepoint, decrement depth, *then* broadcast). A flat buffer would
    flush a change whose outer transaction can still roll back — publishing a
    row that never existed. **Fix:** a depth-stacked buffer, flush only at depth
    zero, merge on savepoint commit, drop on savepoint rollback.

12. **Membership churn was deferred, not solved.** Revision 2's "re-read by PK
    and apply idempotently" is correct only for rows that are themselves
    written. A row can enter or leave a result set without a write (`limit`
    eviction, relation filters, clock predicates), and the change source cannot
    see it. The client diverges silently. **Fix:** constrain v1 publications to
    "membership is a pure function of the row" and enforce it at runtime (§15).

13. **The grep guard is syntactic, not semantic.** Revision 2 treated it as
    covering the query-builder blind spot. It does not: a query-builder write
    inside an explicit `transaction()` fires the commit event with an empty
    buffer, which the guard cannot distinguish from a no-op transaction.
    **Fix:** documented as a known, unfixable-without-a-query-AST gap.

14. **Composite PKs and soft deletes.** Revision 2 assumed a single integer id
    and hard deletes. `defineModel` enforces both, but `PrimaryColumn` and
    `DeleteDateColumn` are re-exported (`core/src/models/index.ts:69-70`), so
    raw-TypeORM models can escape. **Fix:** read the full key from
    `metadata.primaryColumns`; document the escape hatch as unsupported.

## 15. Membership Churn — the problem revision 2 deferred

Revision 2 said "re-read by PK and let the client apply changes idempotently."
That is correct for rows that are themselves written. It is **silently wrong**
for a row that enters or leaves a publication's result set without being
written. This section solves it.

### 15.1 The failure

A publication is a server-side query. The change source reports
`(entityClass, id, operation)`. Consider:

- `query(Post).where({ status: 'published' }).orderBy('publishedAt', 'desc')`
  with `limit(20)`. A new post is inserted at rank 5. Rank 20 must be removed
  from the client's set. Rank 20 was never written. The change source cannot
  see it.
- `whereHas('author', q => q.where({ active: true }))`. Deactivating an author
  removes all their posts from the set. No post row was written.
- `where(q => q.lt('publishedAt', new Date()))`. The clock passes a post's
  publication time. The post enters the set. No write occurred.

In each case the client's set diverges from the server's, permanently, until a
full snapshot. The divergence is invisible: no error, no log, just stale data.

### 15.2 What real systems do

Every system that ships this picked one of three strategies, and the choice
tracks how rich its change source is:

| System | Strategy | Why it can |
| --- | --- | --- |
| Convex | Re-run the query, diff the result | Queries are executable functions; it records the read set instrumentally |
| Firestore | Re-run the query, diff the result | The query is persisted server-side; both sides diff two full evaluations |
| Zero | Materialized set, incremental advance | Consumes Postgres logical replication, so it knows which rows moved |
| Meteor | Live cursor with `added`/`changed`/`removed` | Tails the MongoDB oplog, a richer feed than a row hook |
| ElectricSQL | `where`-only shapes, delete on unmatch | Deliberately has no `limit`/`order` |
| Linear | Subscription-filtered log, client-side sort | No live `limit`; a list view is "all subscribed rows, sorted locally" |

The pattern: **the richer the change source, the more the system can infer.**
JSails' change source is a row hook. It knows a row changed; it does not know
which other rows are affected. That is the weakest feed in the table, and it
rules out strategies 1–3.

The `limit` case is the tell. Convex had to rewrite `limit` into pinned range
queries because limit-based pagination produces duplicate and missing rows under
reactivity. Zero had to re-engineer `limit()` in 1.8 because 1.7 re-ran the
whole query to find the first 50. ElectricSQL simply does not support it. Nobody
solved live `limit` cheaply.

### 15.3 The decision: constrain the shape

A v1 publication's membership must be a **pure function of its own projected
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
columns, which the capture hook already reports and Phase 3 already re-reads.
The churn cases become **unrepresentable**, not merely unhandled.

This is not a limitation to apologize for. It is the same trade ElectricSQL and
Linear made, and it is the only one that is correct given a row-level change
source.

### 15.4 Enforcement, honestly

Three tiers, cheapest first:

1. **Runtime guard (implemented).** `assertPublicationShape` reads
   `expressionMap.take`/`skip` for `limit`/`offset` — reliable, those are real
   fields. It scans `expressionMap.wheres` for `EXISTS` to catch relation
   predicates, and reads a `#applied` flag for `apply`. These are heuristics.
2. **Docs (implemented).** The docs page shows only the scalar-`where` form and
   states the ban explicitly.
3. **Not achievable in v1.** A clock-derived predicate compiles to an ordinary
   `andWhere` fragment, indistinguishable from a scalar comparison. Catching it
   requires a retained query AST, which `ModelQuery` does not have — it compiles
   `Q` straight to `SelectQueryBuilder` and discards the tree
   (`query-expressions.ts:460-471`), and `whereHas` emits an opaque `EXISTS`
   string (`relation-query.ts:259-268`).

The plan states this plainly rather than claiming full enforcement. A reviewer
who wants the clock case caught must build the structural query layer (§12.12),
which is a core query-surface change and out of scope here.

### 15.5 What this costs

- A blog index cannot be a live `limit(20)` list. It can be a live list of all
  published posts, sorted client-side, with the client paginating. For a blog
  that is fine; for a feed with 100k rows it is not, and that is a future phase.
- A publication cannot filter by a relation. It can filter by a denormalized
  column on the row itself (e.g. `authorActive` maintained by the app), which
  makes the dependency explicit and the change visible.
- The `maxRows` cap (1,000 default) bounds the "all rows" case.

The denormalization escape hatch is worth stating in the docs: if you need a
relation filter, put the value on the row. That is a real design pressure, and
it is the same pressure every system in §15.2 applies.
