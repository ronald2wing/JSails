/**
 * The live service — the composition point of the live layer
 * (docs/design/live.md §4.8).
 *
 * {@link createLiveService} drives the snapshot (registry + publication query +
 * write fence), assigns collections, routes the capture flush through the change
 * log, and multiplexes fan-out: subscriptions that present the same
 * `publication + params + resolved identity` key share one driver, so a change
 * costs one membership probe per key rather than one per subscription. Placing
 * the identity *in the key* is what keeps two users of a `user.id`-filtered
 * publication from sharing rows (docs/design/live.md §4.7, §14 item 3).
 *
 * Membership is decided per row, from the row itself: because
 * {@link assertPublicationShape} has excluded `limit`, `offset`, relation
 * predicates, and raw `apply`, the only way a row enters or leaves a set is a
 * write to its own columns, so a row that no longer matches a scalar `where` is
 * detected by probing its primary key against the publication's compiled
 * predicate (docs/design/live.md §15.3).
 */

import type { BaseEntity } from 'typeorm';

import type { ModelQuery } from 'jsails/database';
import {
  assertPublicationShape,
  fieldProjector,
  PublicationDefinitionError,
  PublicationShapeError,
  type ChangeLog,
  type LiveChange,
  type LiveRequestInfo,
  type LiveRow,
  type LiveServerMessage,
  type LiveUser,
  type ErasedPublication,
  type PublicationAuthContext,
  type PublicationRegistry,
} from 'jsails/live';

import { serializePrimaryKey } from 'jsails/plugin-sdk';

import { canonicalParams } from './canonical-params.js';
import { createWriteFence, type WriteFence } from './write-fence.js';

export interface LiveSubscribeRequest {
  readonly publication: string;
  readonly params: unknown;
  /** Last applied sequence, for resume. */
  readonly resumeFrom?: number;
  /**
   * The identity making this request. It reaches both `authorize`/`query` and
   * the fan-out key. The transport resolves it; absent means an anonymous
   * request.
   */
  readonly user?: LiveUser | null;
  readonly request?: LiveRequestInfo;
}

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
   * `dataSource.liveCapture.setListener(service.ingest)`.
   */
  ingest(changes: readonly LiveChange[]): Promise<void>;
  /**
   * Fan out changes read from a shared log by another process (or by this
   * process's own tailer). Only meaningful with `deliverLocally: false`; the
   * caller owns ordering, so changes must arrive in sequence order.
   */
  applyRemote(changes: readonly LiveChange[]): void;
}

const NOOP_REQUEST: LiveRequestInfo = Object.freeze({ ip: null, origin: null, headers: {} });

const DEFAULT_MAX_ROWS = 1000;
/** The hard row cap (docs/design/live.md §10): refuse to start above this. */
const HARD_MAX_ROWS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 16;

/** What a membership probe needs: the resolved publication query and its projection. */
interface PublicationView {
  readonly entity: typeof BaseEntity;
  /** The TypeORM entity name, which is what a captured change's `collection` carries. */
  readonly entityName: string;
  /** The client-visible collection from the publication definition. */
  readonly collection: string;
  /** The snapshot query; its builder is cloned for per-row membership probes. */
  readonly query: ModelQuery<object>;
  readonly project: (row: object) => LiveRow;
}

/** One open subscription. */
interface Subscription {
  readonly id: string;
  readonly view: PublicationView;
  readonly sink: (message: LiveServerMessage) => void;
  readonly abort: () => void;
}

/**
 * The shared fan-out driver for every subscription presenting one key.
 *
 * Equal keys mean equal publication, parsed params, and identity, so every
 * member would compute the same membership answer; the driver probes once and
 * emits to each member under its own subscription id.
 */
interface Driver {
  readonly key: string;
  /** The first member's view; any member's is equivalent for probing. */
  readonly view: PublicationView;
  readonly members: Set<Subscription>;
  /**
   * Ids the members currently hold: seeded from each member's snapshot and
   * maintained by fan-out. A change whose row fails the membership probe is
   * delivered only when the id is here — otherwise the subscriber would learn
   * the id (and write cadence) of every row it is not allowed to read.
   */
  readonly known: Set<string>;
  /**
   * Serializes this driver's deliveries. A delivery awaits a membership probe,
   * so two changes routed back-to-back would otherwise race and a client could
   * see a later sequence first (docs/design/live.md §14 item 8).
   */
  chain: Promise<void>;
}

/**
 * What a subscriber receives for each row: the publication's own `project`,
 * or a copy of exactly its `fields`. A definition with neither, which only a
 * hand-built object bypassing `definePublication` can be, fails closed rather
 * than falling back to every column.
 *
 * The client keys snapshot rows by the row's `id` and change messages by the
 * serialized primary key, so the two must agree or a change would land beside
 * the row it updates. `fields` therefore requires an entity whose primary key
 * is the single `id` column, and every row `project` returns is checked
 * against its primary key; a mismatch throws instead of reaching the wire.
 */
function subscriberProjection(
  entity: typeof BaseEntity,
  definition: ErasedPublication,
): (row: object) => LiveRow {
  if (definition.project !== undefined) {
    const project = definition.project;
    return (row) => {
      const projected = project(row);
      const id = projected['id'];
      if (
        (typeof id !== 'string' && typeof id !== 'number') ||
        String(id) !== primaryKeyOf(entity, row)
      ) {
        throw new PublicationDefinitionError(
          'invalid_projection',
          'a projected row id must equal its primary key',
        );
      }
      return projected;
    };
  }
  if (definition.fields === undefined) {
    throw new PublicationDefinitionError(
      'missing_projection',
      'a publication requires exactly one of fields or project',
    );
  }
  const primary = entity.getRepository().metadata.primaryColumns;
  if (primary.length !== 1 || primary[0]?.propertyName !== 'id') {
    throw new PublicationDefinitionError(
      'invalid_fields',
      'a fields publication needs an entity whose primary key is the single id column',
    );
  }
  return fieldProjector(entity, definition.fields);
}

/** A row's serialized primary key, the id a change message carries. */
function primaryKeyOf(entity: typeof BaseEntity, row: object): string {
  const values = entity
    .getRepository()
    .metadata.primaryColumns.map((column) => (row as Record<string, unknown>)[column.propertyName]);
  return serializePrimaryKey(values);
}

export function createLiveService(options: LiveServiceOptions): LiveService {
  if (options.maxRows !== undefined && options.maxRows > HARD_MAX_ROWS) {
    throw new TypeError(`maxRows must not exceed the hard cap of ${HARD_MAX_ROWS}`);
  }

  const registry = options.registry;
  const changeLog = options.changeLog;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onError = options.onError ?? (() => {});
  const deliverLocally = options.deliverLocally ?? true;

  const fence: WriteFence = createWriteFence();

  let started = false;
  let idCounter = 0;
  const subscriptions = new Map<string, Subscription>();
  const drivers = new Map<string, Driver>();
  const driversByEntity = new Map<string, Set<Driver>>();
  const pending = new Map<string, LiveChange>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Serialize appends so sequence assignment matches commit order. */
  let publishChain: Promise<void> = Promise.resolve();

  function nextId(): string {
    idCounter += 1;
    return String(idCounter);
  }

  /** Probe membership and project the row a subscriber should hold, or `null`. */
  async function membershipRow(view: PublicationView, change: LiveChange): Promise<LiveRow | null> {
    // A delete short-circuits: no row to probe, and the client removes the id.
    if (change.row === null) {
      return null;
    }
    const columns = view.entity.getRepository().metadata.primaryColumns;
    const idValues: unknown[] = [];
    for (const column of columns) {
      // The change log's row carries every scalar column, the raw PK included.
      const value = change.row[column.propertyName];
      if (value === undefined) {
        return null;
      }
      idValues.push(value);
    }

    const probe = view.query.builder.clone();
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
    // representable by a write to the row's own columns (docs/design/live.md §15.3).
    const member = await probe.getOne();
    if (member === null) {
      return null;
    }
    return view.project(member);
  }

  function changeMessage(
    subscription: Subscription,
    change: LiveChange,
    row: LiveRow | null,
  ): LiveServerMessage {
    return {
      type: 'change',
      subscriptionId: subscription.id,
      sequence: change.sequence,
      collection: subscription.view.collection,
      id: change.id,
      row,
    };
  }

  /**
   * The wire id of a loaded entity row, serialized exactly as the change
   * capture serializes primary keys so local rows and remote changes match.
   */
  function rowId(view: PublicationView, row: object): string {
    return primaryKeyOf(view.entity, row);
  }

  /**
   * Queue a fan-out behind the driver's previous one. Chaining preserves the
   * log's order per driver, which is the only order a client can rely on. A
   * rejected delivery is reported and does not break the chain.
   */
  function enqueueFanOut(driver: Driver, change: LiveChange): void {
    driver.chain = driver.chain
      .then(async () => {
        if (driver.members.size === 0) {
          return;
        }
        const row = await membershipRow(driver.view, change);
        if (row !== null) {
          driver.known.add(change.id);
        } else if (!driver.known.delete(change.id)) {
          // Never part of this driver's set: nothing to retract, nothing to leak.
          return;
        }
        for (const member of driver.members) {
          member.sink(changeMessage(member, change, row));
        }
      })
      .catch((error: unknown) => {
        onError(error);
      });
  }

  /** Fan a stored (sequence-assigned) change out to every entity-matched driver. */
  function route(change: LiveChange): void {
    const matched = driversByEntity.get(change.collection);
    if (matched === undefined) {
      return;
    }
    for (const driver of matched) {
      enqueueFanOut(driver, change);
    }
  }

  /**
   * Join the driver for `key`, creating it on first use, and record the ids the
   * new member holds. Returns the leave function.
   */
  function joinDriver(
    key: string,
    subscription: Subscription,
    memberIds: Iterable<string>,
  ): () => void {
    let driver = drivers.get(key);
    if (driver === undefined) {
      driver = {
        key,
        view: subscription.view,
        members: new Set(),
        known: new Set(),
        chain: Promise.resolve(),
      };
      drivers.set(key, driver);
      let byEntity = driversByEntity.get(driver.view.entityName);
      if (byEntity === undefined) {
        byEntity = new Set();
        driversByEntity.set(driver.view.entityName, byEntity);
      }
      byEntity.add(driver);
    }
    driver.members.add(subscription);
    for (const memberId of memberIds) {
      driver.known.add(memberId);
    }
    const joined = driver;
    return () => {
      joined.members.delete(subscription);
      if (joined.members.size > 0) {
        return;
      }
      drivers.delete(joined.key);
      const byEntity = driversByEntity.get(joined.view.entityName);
      byEntity?.delete(joined);
      if (byEntity !== undefined && byEntity.size === 0) {
        driversByEntity.delete(joined.view.entityName);
      }
    };
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
   * it (docs/design/live.md §6.4). The service is armed at start; only an open
   * snapshot region defers.
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
      for (const subscription of subscriptions.values()) {
        subscription.abort();
      }
      subscriptions.clear();
      drivers.clear();
      driversByEntity.clear();
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
      const query = definition.query({
        params,
        user,
        request: requestInfo,
        signal: controller.signal,
      });

      try {
        assertPublicationShape(query);
      } catch (error) {
        if (error instanceof PublicationShapeError) {
          return fail('unsupported_publication_shape');
        }
        throw error;
      }

      const entity = query.entity;
      let project: (row: object) => LiveRow;
      try {
        project = subscriberProjection(entity, definition);
      } catch (error) {
        if (error instanceof PublicationDefinitionError) {
          return fail('invalid_publication_fields');
        }
        throw error;
      }
      const view: PublicationView = {
        entity,
        entityName: entity.getRepository().metadata.name,
        collection: definition.collection,
        query,
        project,
      };
      const subscription: Subscription = { id, view, sink, abort: () => controller.abort() };

      // The fan-out key: equal keys share one driver (and one membership set).
      // Params the canonical form cannot represent are an invalid request, not
      // an internal error, and are refused before any query runs.
      let key: string;
      try {
        key = `${definition.name}:${canonicalParams(params)}:${user?.id ?? 'anonymous'}`;
      } catch {
        return fail('invalid_params');
      }
      const rowCap = definition.maxRows ?? maxRows;

      /** Load the current member rows, or `undefined` when over the row cap. */
      const loadMembers = async (): Promise<object[] | undefined> => {
        const rows = await query.getMany();
        return rows.length > rowCap ? undefined : rows;
      };

      // Snapshot (or resume replay) under the fence so a change committing
      // during the query is published only after it is emitted and armed
      // (docs/design/live.md §3, §6.4).
      let memberIds: Iterable<string> = [];
      fence.beginWrite();
      try {
        // Resume replays the retained changes instead of a snapshot when the log
        // still covers the client's last-applied sequence (§8). A successful
        // resume is signalled by replayed changes and *no* snapshot; only the
        // fallback snapshot carries `resumed: false`.
        //
        // A replayed change whose row no longer passes the membership probe is
        // forwarded only when the id is known to be held — by an existing
        // driver for this key, by the current member set, or by an earlier
        // replayed upsert. An id that is none of those is either a row the
        // client was never allowed to see (which must not be disclosed) or one
        // it held before the window; the snapshot settles both correctly.
        let resumed = false;
        let members: object[] | undefined;
        if (request.resumeFrom !== undefined) {
          const slice = await changeLog.since(request.resumeFrom);
          if (!slice.truncated) {
            let held = drivers.get(key)?.known;
            if (held === undefined) {
              members = await loadMembers();
              if (members === undefined) {
                return fail('too_many_rows');
              }
              held = new Set(members.map((row) => rowId(view, row)));
            }
            const replay: LiveServerMessage[] = [];
            const upserted = new Set<string>();
            let settled = true;
            for (const change of slice.changes) {
              if (change.collection !== view.entityName) {
                continue;
              }
              const row = await membershipRow(view, change);
              if (row !== null) {
                upserted.add(change.id);
              } else if (upserted.has(change.id)) {
                upserted.delete(change.id);
              } else if (!held.has(change.id)) {
                settled = false;
                break;
              }
              replay.push(changeMessage(subscription, change, row));
            }
            if (settled) {
              for (const message of replay) {
                sink(message);
              }
              resumed = true;
              memberIds = new Set([...held, ...upserted]);
            }
          }
        }

        if (!resumed) {
          members ??= await loadMembers();
          if (members === undefined) {
            return fail('too_many_rows');
          }
          let projected: LiveRow[];
          try {
            projected = members.map((row) => view.project(row));
          } catch (error) {
            if (error instanceof PublicationDefinitionError) {
              return fail('invalid_publication_projection');
            }
            throw error;
          }
          const sequence = changeLog.head;
          sink({ type: 'snapshot', subscriptionId: id, sequence, rows: projected, resumed: false });
          memberIds = members.map((row) => rowId(view, row));
        }
      } finally {
        fence.arm();
        fence.endWrite();
      }

      // Join the fan-out only once the snapshot succeeded; joining earlier would
      // leave a driver member behind on a getMany/row-cap failure.
      const leave = joinDriver(key, subscription, memberIds);
      subscriptions.set(id, subscription);

      return {
        id,
        async close(): Promise<void> {
          if (!subscriptions.delete(id)) {
            return;
          }
          leave();
          subscription.abort();
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
