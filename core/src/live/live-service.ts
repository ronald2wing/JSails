/**
 * The live service — the composition point of the live layer (LIVE-PLAN.md §4.8,
 * Phase 5).
 *
 * {@link createLiveService} drives the snapshot (registry + publication query +
 * write fence), assigns collections, routes the capture flush through the change
 * log, and multiplexes fan-out keyed by `publication + params + resolved
 * identity`. The multiplexer itself stays identity-agnostic; placing the identity
 * *in the key* is this service's responsibility (LIVE-PLAN.md §14 blocker 3).
 *
 * Membership is decided per row, from the row itself: because
 * {@link assertPublicationShape} has excluded `limit`, `offset`, relation
 * predicates, and raw `apply`, the only way a row enters or leaves a set is a
 * write to its own columns, so a row that no longer matches a scalar `where` is
 * detected by probing its primary key against the publication's compiled
 * predicate (LIVE-PLAN.md §15.3).
 */

import type { BaseEntity } from 'typeorm';

import type { ModelQuery } from '../database/model-query.js';
import { canonicalParams } from './canonical-params.js';
import type { ChangeLog } from './change-log.js';
import type { LiveChange, LiveRow } from './change-record.js';
import { createMultiplexer, type Multiplexer } from './multiplexer.js';
import { projectRow } from './projection.js';
import type { LiveRequestInfo, LiveUser, PublicationAuthContext } from './publication.js';
import type { PublicationRegistry } from './publication-registry.js';
import { createWriteFence, type WriteFence } from './write-fence.js';

// ---------------------------------------------------------------------------
// Shape constraint (§4.2a)
// ---------------------------------------------------------------------------

/** Why a publication's query shape is rejected by the live layer. */
export type PublicationShapeErrorCode =
  | 'unsupported_limit'
  | 'unsupported_offset'
  | 'unsupported_relation_predicate'
  | 'unsupported_raw_apply';

/** Raised by {@link assertPublicationShape} for a shape the live layer refuses. Value-free. */
export class PublicationShapeError extends Error {
  readonly code: PublicationShapeErrorCode;

  constructor(code: PublicationShapeErrorCode) {
    super('publication shape is not supported by the live layer');
    this.name = 'PublicationShapeError';
    this.code = code;
  }
}

/**
 * Reject a publication whose membership is not a pure function of its own
 * projected row (LIVE-PLAN.md §4.2a).
 *
 * Reliability here is deliberately honest. `limit`/`offset` are detected
 * reliably: `ModelQuery.limit()`/`offset()` route to `builder.limit()`/`offset()`,
 * which set `expressionMap.limit`/`offset` — the raw QueryBuilder's legacy
 * `take`/`skip` fields are a *different*, unused API surface, so a guard reading
 * `take`/`skip` would silently miss every `limit`/`offset`. Relation predicates
 * (`whereHas`/`has` compile to `EXISTS (...)` fragments in `expressionMap.wheres`)
 * and raw `apply` (the `#applied` flag read via `query.applied`) are detected
 * heuristically. A clock-derived predicate is **not** detectable at all — it
 * compiles to an ordinary `andWhere` fragment indistinguishable from a scalar
 * comparison — and is caught by review and docs, not this guard (§15.4).
 */
export function assertPublicationShape(query: ModelQuery<object>): void {
  const map = query.builder.expressionMap;
  if (map.limit !== undefined) {
    throw new PublicationShapeError('unsupported_limit');
  }
  if (map.offset !== undefined) {
    throw new PublicationShapeError('unsupported_offset');
  }
  if (map.wheres.some((clause) => containsExists(clause.condition))) {
    throw new PublicationShapeError('unsupported_relation_predicate');
  }
  if (query.applied) {
    throw new PublicationShapeError('unsupported_raw_apply');
  }
}

/** Scan a compiled WHERE fragment for an EXISTS subquery, recursing into brackets. */
function containsExists(condition: unknown): boolean {
  if (typeof condition === 'string') {
    return /EXISTS/i.test(condition);
  }
  if (Array.isArray(condition)) {
    return condition.some((entry) => containsExists(entry));
  }
  if (typeof condition === 'object' && condition !== null) {
    // A WhereWrappingOperator carries `condition`; a WherePredicateOperator does
    // not, and no EXISTS string appears anywhere but a string fragment.
    return Object.values(condition as Record<string, unknown>).some((value) =>
      containsExists(value),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request / message / handle (§4.8)
// ---------------------------------------------------------------------------

export interface LiveSubscribeRequest {
  readonly publication: string;
  readonly params: unknown;
  /** Last applied sequence, for resume. */
  readonly resumeFrom?: number;
  /**
   * The resolved identity making this request.
   *
   * The plan's §4.8 request carries only `publication`/`params`/`resumeFrom`,
   * while §4.7 and §7 require identity in both the authorization context and the
   * multiplexer key. Phase 6's transport resolves and passes it; Phase 5 exposes
   * it as optional fields (defaulting to an anonymous, opaque request) so the
   * fan-out-by-identity and authorization behaviours are testable before the
   * adapter exists.
   */
  readonly user?: LiveUser | null;
  readonly request?: LiveRequestInfo;
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
  /**
   * Receives delivery failures (a membership probe that throws). A failed
   * delivery is dropped rather than retried: the next change for the same row
   * re-probes membership, and a client that missed one change can resubscribe
   * with `resumeFrom`. Defaults to a no-op so a service without a logger still
   * cannot crash the write path.
   */
  readonly onError?: (error: unknown) => void;
  /**
   * Whether a change this process appended is fanned out immediately.
   *
   * Defaults to `true`, which is correct for a process-local log: the appending
   * process is the only one that can see the change, so it must deliver it.
   *
   * A shared log (Valkey Streams) must set this to `false` and deliver through
   * {@link LiveService.applyRemote} instead. Routing locally *and* tailing the
   * stream gives two delivery paths with independent timing: a local append can
   * be routed before an earlier remote append has been read, so the client sees
   * sequence 7 before 6 and a sequence watermark then drops 6. One path — the
   * stream tailer — is the only ordering that holds across instances.
   */
  readonly deliverLocally?: boolean;
}

export interface LiveService {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(
    request: LiveSubscribeRequest,
    sink: (message: LiveServerMessage) => void,
  ): Promise<LiveSubscriptionHandle>;
  /**
   * The capture-flush entry point: attach as
   * `dataSource.liveCapture.setListener(service.ingest)`. The plan's §3 lists
   * `(subscribe/snapshot/change)` as the service's capabilities; `ingest` is the
   * `change` half, present even though §4.8's interface enumerates only the
   * snapshot-facing methods.
   */
  ingest(changes: readonly LiveChange[]): Promise<void>;
  /**
   * Fan out changes read from a shared log by another process (or by this
   * process's own tailer). Only meaningful with `deliverLocally: false`; the
   * caller owns ordering, so changes must arrive in sequence order.
   */
  applyRemote(changes: readonly LiveChange[]): void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const NOOP_REQUEST: LiveRequestInfo = Object.freeze({ ip: null, origin: null, headers: {} });

const DEFAULT_MAX_ROWS = 1000;
/** §10 "Hard row cap": refuse to start above this. */
const HARD_MAX_ROWS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 16;

/** One open subscription's resolved state. */
interface Subscription {
  readonly id: string;
  readonly entity: typeof BaseEntity;
  readonly entityName: string;
  readonly collection: string;
  readonly project: (row: object) => LiveRow;
  /** The snapshot query; its builder is cloned for per-row membership probes. */
  readonly query: ModelQuery<object>;
  readonly sink: (message: LiveServerMessage) => void;
  readonly abort: () => void;
  /** The closure registered with the multiplexer and invoked on fan-out. */
  receive: (change: LiveChange) => void;
  /** Multiplexer slot teardown, wired after construction. */
  unsubscribe: () => void;
  /**
   * Serializes this subscription's deliveries. `deliver` awaits a membership
   * probe, so two changes routed back-to-back would otherwise race and the
   * client could see a later sequence first (LIVE-PLAN.md §14 defect 8).
   */
  deliveryChain: Promise<void>;
}

export function createLiveService(options: LiveServiceOptions): LiveService {
  if (options.maxRows !== undefined && options.maxRows > HARD_MAX_ROWS) {
    throw new Error(`maxRows ${options.maxRows} exceeds the hard cap of ${HARD_MAX_ROWS}`);
  }

  const registry = options.registry;
  const changeLog = options.changeLog;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onError = options.onError ?? (() => {});
  const deliverLocally = options.deliverLocally ?? true;

  const fence: WriteFence = createWriteFence();
  const multiplexer: Multiplexer = createMultiplexer();

  let started = false;
  let idCounter = 0;
  const subscriptions = new Map<string, Subscription>();
  const byEntity = new Map<string, Set<Subscription>>();
  const pending = new Map<string, LiveChange>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Serialize appends so sequence assignment matches commit order. */
  let publishChain: Promise<void> = Promise.resolve();

  function nextId(): string {
    idCounter += 1;
    return String(idCounter);
  }

  /** Probe membership and project the row a subscriber should hold, or `null`. */
  async function membershipRow(
    subscription: Subscription,
    change: LiveChange,
  ): Promise<LiveRow | null> {
    // A delete short-circuits: no row to probe, and the client removes the id.
    if (change.row === null) {
      return null;
    }
    const columns = subscription.entity.getRepository().metadata.primaryColumns;
    const idValues: unknown[] = [];
    for (const column of columns) {
      // The projected row carries the raw PK value (projectRow copies scalars).
      const value = change.row[column.propertyName];
      if (value === undefined) {
        return null;
      }
      idValues.push(value);
    }

    const probe = subscription.query.builder.clone();
    if (columns.length === 1) {
      probe.andWhereInIds(idValues[0]);
    } else {
      const idMap: Record<string, unknown> = {};
      for (const column of columns) {
        idMap[column.propertyName] = change.row[column.propertyName];
      }
      probe.andWhereInIds(idMap);
    }

    // `getOne()` returns null when the row is gone or no longer satisfies the
    // publication's predicate — the membership flip the shape constraint makes
    // representable by a write to the row's own columns (LIVE-PLAN.md §15.3).
    const member = await probe.getOne();
    if (member === null) {
      return null;
    }
    return subscription.project(member);
  }

  /** Deliver one change to one subscription, translating and re-checking membership. */
  async function deliver(subscription: Subscription, change: LiveChange): Promise<void> {
    if (change.collection !== subscription.entityName) {
      return;
    }
    const row = await membershipRow(subscription, change);
    subscription.sink({
      type: 'change',
      subscriptionId: subscription.id,
      sequence: change.sequence,
      collection: subscription.collection,
      id: change.id,
      row,
    });
  }

  /**
   * Queue a delivery behind this subscription's previous one.
   *
   * `deliver` awaits a membership probe, so firing it with `void` lets a later
   * change overtake an earlier one whose probe is slower — the client would
   * then apply sequence 2 before sequence 1 and hold a stale row. Chaining
   * preserves the log's order per subscription, which is the only order the
   * client can rely on. A rejected delivery is reported and does not break the
   * chain for subsequent changes.
   */
  function enqueueDelivery(subscription: Subscription, change: LiveChange): void {
    subscription.deliveryChain = subscription.deliveryChain.then(
      () => deliver(subscription, change),
      () => deliver(subscription, change),
    );
    subscription.deliveryChain = subscription.deliveryChain.catch((error: unknown) => {
      onError(error);
    });
  }

  /** Fan a stored (sequence-assigned) change out to every entity-matched subscription. */
  function route(change: LiveChange): void {
    const subscribers = byEntity.get(change.collection);
    if (subscribers === undefined) {
      return;
    }
    for (const subscription of subscribers) {
      subscription.receive(change);
    }
  }

  function scheduleDrain(): void {
    if (flushTimer !== null || pending.size === 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drain();
    }, flushIntervalMs);
  }

  /** Coalesce the pending buffer into the change log and fan out. */
  async function drain(): Promise<void> {
    if (pending.size === 0) {
      return;
    }
    const batch = [...pending.values()];
    pending.clear();
    publishChain = publishChain.then(async () => {
      for (const change of batch) {
        const sequence = await changeLog.append(change);
        // The log assigns the sequence on a copy; carry it onto the routed record.
        // With a shared log the tailer delivers instead, so routing here would
        // create a second, unordered delivery path (see `deliverLocally`).
        if (deliverLocally) {
          route({ ...change, sequence });
        }
      }
    });
    await publishChain;
  }

  /**
   * Ingest a capture flush's committed changes, coalesced by (collection, id).
   * The fence holds the publish until any in-flight snapshot has armed and
   * closed, so a change committing during the snapshot query is delivered after
   * it (LIVE-PLAN.md §6.4). The service is armed at start; only an open snapshot
   * region defers.
   */
  function ingest(changes: readonly LiveChange[]): Promise<void> {
    if (!started || changes.length === 0) {
      return Promise.resolve();
    }
    fence.beginWrite();
    for (const change of changes) {
      pending.set(`${change.collection}\u0000${change.id}`, change);
    }
    fence.onAllCommitted(() => {
      scheduleDrain();
    });
    fence.endWrite();
    return publishChain;
  }

  return {
    async start(): Promise<void> {
      started = true;
      fence.arm();
    },

    async stop(): Promise<void> {
      started = false;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending.clear();
      for (const subscription of [...subscriptions.values()]) {
        subscription.abort();
        subscription.unsubscribe();
      }
      subscriptions.clear();
      byEntity.clear();
    },

    async subscribe(request, sink): Promise<LiveSubscriptionHandle> {
      const id = nextId();

      const fail = (code: string): LiveSubscriptionHandle => {
        sink({ type: 'error', subscriptionId: id, code });
        return { id, close: async () => {} };
      };

      const definition = registry.get(request.publication);
      if (definition === undefined) {
        return fail('unknown_publication');
      }

      let params: unknown;
      try {
        params = definition.params.parse(request.params);
      } catch {
        return fail('invalid_params');
      }

      const user = request.user ?? null;
      const requestInfo = request.request ?? NOOP_REQUEST;
      const authContext: PublicationAuthContext<unknown> = { params, user, request: requestInfo };

      let allowed: boolean;
      try {
        allowed = (await definition.authorize(authContext)) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return fail('unauthorized');
      }

      const controller = new AbortController();
      const queryContext = {
        params,
        user,
        request: requestInfo,
        signal: controller.signal,
      };
      const query = definition.query(queryContext);

      try {
        assertPublicationShape(query);
      } catch (error) {
        if (error instanceof PublicationShapeError) {
          return fail('unsupported_publication_shape');
        }
        throw error;
      }

      const entity = query.entity;
      const entityName = entity.getRepository().metadata.name;
      const collection = definition.collection;
      const project = definition.project ?? ((row) => projectRow(entity, row));

      const subscription: Subscription = {
        id,
        entity,
        entityName,
        collection,
        project,
        query,
        sink,
        abort: () => controller.abort(),
        receive: () => {},
        unsubscribe: () => {},
        deliveryChain: Promise.resolve(),
      };

      // Snapshot (or resume replay) under the fence so a change committing
      // during the query is published only after it is emitted and armed
      // (LIVE-PLAN.md §3, §6.4).
      fence.beginWrite();
      let emitted = false;
      try {
        // Resume replays the retained changes instead of a snapshot when the log
        // still covers the client's last-applied sequence (§8). Because the
        // `change` message carries no `resumed` field, a successful resume is
        // signalled by emitting replayed changes and *no* snapshot; only the
        // fallback snapshot carries `resumed: false` (§4.8's union has no other
        // representation for §8's "resumed: true").
        if (request.resumeFrom !== undefined) {
          const slice = await changeLog.since(request.resumeFrom);
          if (!slice.truncated) {
            for (const change of slice.changes) {
              await deliver(subscription, change);
            }
            emitted = true;
          }
        }

        if (!emitted) {
          const rows = await query.getMany();
          const rowCap = definition.maxRows ?? maxRows;
          if (rows.length > rowCap) {
            return fail('too_many_rows');
          }
          const projected = rows.map((row) => project(row));
          const sequence = changeLog.head;
          sink({ type: 'snapshot', subscriptionId: id, sequence, rows: projected, resumed: false });
        }
      } finally {
        fence.arm();
        fence.endWrite();
      }

      // Wire the fan-out driver now that the snapshot succeeded; registering
      // earlier would leak a multiplexer slot on a getMany/snapshot failure.
      const key = `${definition.name}:${canonicalParams(params)}:${user?.id ?? 'anonymous'}`;
      subscription.receive = (change) => {
        enqueueDelivery(subscription, change);
      };
      // The driver is registered under the identity-bearing key (blocker 3); the
      // service routes through `byEntity`, while the multiplexer dedups the key
      // and owns slot teardown.
      subscription.unsubscribe = multiplexer.register(key, subscription.receive);

      subscriptions.set(id, subscription);
      let subscribers = byEntity.get(entityName);
      if (subscribers === undefined) {
        subscribers = new Set();
        byEntity.set(entityName, subscribers);
      }
      subscribers.add(subscription);

      return {
        id,
        async close(): Promise<void> {
          const current = subscriptions.get(id);
          if (current === undefined) {
            return;
          }
          subscriptions.delete(id);
          const set = byEntity.get(current.entityName);
          set?.delete(current);
          if (set !== undefined && set.size === 0) {
            byEntity.delete(current.entityName);
          }
          current.abort();
          current.unsubscribe();
        },
      };
    },

    ingest,

    applyRemote(changes: readonly LiveChange[]): void {
      if (!started) {
        return;
      }
      for (const change of changes) {
        route(change);
      }
    },
  };
}
