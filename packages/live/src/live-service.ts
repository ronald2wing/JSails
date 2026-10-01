/**
 * The live service — the composition point of the live layer
 * (docs/design/live.md §4.8).
 *
 * {@link createLiveService} drives the snapshot (registry + publication query),
 * assigns collections, routes the capture flush through the change log, and
 * multiplexes fan-out: subscriptions that present the same
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
 * predicate (docs/design/live.md §15.3). A driver probes every change it has
 * queued in one `WHERE id IN (...)` query, and a service-wide limiter bounds how
 * many drivers probe at once, so one write fanned out to thousands of keys
 * cannot exhaust the connection pool.
 *
 * **Snapshot ordering without a write fence.** A subscription opens a buffer
 * for its entity *before* it reads the log head and runs its query. Every
 * change routed while the snapshot is in flight lands in that buffer, whichever
 * path routed it — a local flush or a shared log's tailer. When the snapshot is
 * emitted the subscription joins its driver, and the buffered changes after the
 * head it read are replayed to it alone, ahead of anything the driver delivers
 * later. A change the query already saw is replayed harmlessly (the probe reads
 * the current row and the client applies rows idempotently); a change it missed
 * cannot be lost, because it was appended after the head and therefore routed
 * after the buffer opened. Nothing blocks writers, so a slow snapshot delays
 * only its own subscriber.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { BaseEntity } from 'typeorm';

import { tenantScopeColumn, type ModelQuery } from 'jsails/database';
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

import { JsailsError, serializePrimaryKey } from 'jsails/plugin-sdk';

import { canonicalParams, userFingerprint } from './canonical-params.js';
import { detach, escalate } from 'jsails/support';

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
   * How many drivers may run a membership probe at the same time. Defaults to
   * 8: a write fans out to every driver of its entity, and without a bound a
   * popular table with thousands of distinct keys would issue thousands of
   * concurrent queries against the pool.
   */
  readonly maxConcurrentProbes?: number;
  /**
   * Receives delivery failures (a membership probe that throws). A failed
   * delivery is dropped rather than retried: the next change for the same row
   * re-probes membership, and a client that missed one change can resubscribe
   * with `resumeFrom`. Defaults to a no-op so a service without a logger still
   * cannot crash the write path; the `live` plugin always supplies one. A
   * handler that throws is reported as a process warning and otherwise
   * ignored, so it cannot stall delivery either.
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
   * Whether `request` would pass its publication's `authorize` now: the
   * publication exists, the params parse, and `authorize` returns exactly
   * `true`. The transport re-checks every open subscription with it, so a
   * grant that was revoked after the subscribe does not keep streaming.
   */
  authorize(request: LiveSubscribeRequest): Promise<boolean>;
  /**
   * The capture-flush entry point: attach as
   * `dataSource.liveCapture.setListener(service.ingest)`. It resolves as soon
   * as the changes are queued and never rejects: the capture listener runs
   * inside the writer's commit, so waiting for the coalescing window or the
   * log would add that latency to every write, and a failed append is
   * reported through `onError` instead.
   */
  ingest(changes: readonly LiveChange[]): Promise<void>;
  /**
   * Fan out changes read from a shared log by another process (or by this
   * process's own tailer). Only meaningful with `deliverLocally: false`; the
   * caller owns ordering, so changes must arrive in sequence order.
   */
  applyRemote(changes: readonly LiveChange[]): void;
}

/**
 * A change log that can read its head from the backend rather than from a
 * locally cached value. A shared log's cached head only moves on this
 * process's own appends, so a snapshot watermark taken from it would sit below
 * changes other instances already appended.
 */
export interface HeadReadingChangeLog extends ChangeLog {
  readHead(): Promise<number>;
}

/** Why the live service reported a delivery failure. Value-free. */
export type LiveDeliveryErrorCode = 'io_failed';

/** A change-log append, membership probe, or replay that failed; carries the original as `cause`. */
export class LiveDeliveryError extends JsailsError {
  constructor(
    readonly code: LiveDeliveryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const NOOP_REQUEST: LiveRequestInfo = Object.freeze({ ip: null, origin: null, headers: {} });

const DEFAULT_MAX_ROWS = 1000;
/** The hard row cap (docs/design/live.md §10): refuse to start above this. */
const HARD_MAX_ROWS = 10_000;
const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_CONCURRENT_PROBES = 8;
/** Ids per `WHERE id IN (...)` probe; keeps a statement well under driver parameter limits. */
const PROBE_BATCH_SIZE = 500;

type QueryBuilder = ModelQuery<object>['builder'];

/** What a membership probe needs: the publication predicate and its projection. */
interface PublicationView {
  readonly entity: typeof BaseEntity;
  /** The TypeORM entity name, which is what a captured change's `collection` carries. */
  readonly entityName: string;
  /** The client-visible collection from the publication definition. */
  readonly collection: string;
  /**
   * The publication's builder before the snapshot row cap is applied; cloned
   * for every membership probe so a probe never inherits the cap.
   */
  readonly probeBase: QueryBuilder;
  readonly project: (row: object) => LiveRow;
}

/** One open subscription. */
interface Subscription {
  readonly id: string;
  readonly view: PublicationView;
  readonly sink: (message: LiveServerMessage) => void;
  readonly abort: () => void;
}

/** Changes routed to a driver, delivered to every member not still replaying. */
interface BatchTask {
  readonly kind: 'batch';
  readonly changes: LiveChange[];
}

/** The changes a new member missed while its snapshot was in flight. */
interface ReplayTask {
  readonly kind: 'replay';
  readonly subscription: Subscription;
  /** Ids the member holds after its snapshot or resume. */
  readonly held: Set<string>;
  readonly changes: readonly LiveChange[];
}

type DriverTask = BatchTask | ReplayTask;

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
   * Members whose replay task has not run yet. A batch queued before the
   * member joined skips it: the replay covers those changes, and delivering a
   * later sequence first would make the client's watermark drop the replay.
   */
  readonly replaying: Set<Subscription>;
  /**
   * Ids the members currently hold: seeded from each member's snapshot and
   * maintained by fan-out. A change whose row fails the membership probe is
   * delivered only when the id is here — otherwise the subscriber would learn
   * the id (and write cadence) of every row it is not allowed to read.
   */
  readonly known: Set<string>;
  /**
   * Work not yet started, in order. Tasks run one at a time per driver so a
   * client never sees a later sequence before an earlier one
   * (docs/design/live.md §14 item 8).
   */
  readonly tasks: DriverTask[];
  running: boolean;
}

/**
 * The changes routed for one entity while a subscription's snapshot is in
 * flight, newest per id. Coalescing bounds the buffer by distinct rows, and
 * the replay probes the current row anyway, so only the last change per id
 * carries information.
 */
type SnapshotBuffer = Map<string, LiveChange>;

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

/**
 * Whether the query reads a `tenantScoped` model, as its main table or a join.
 *
 * Changes are routed to drivers by entity alone and the fan-out key carries no
 * tenant, so one tenant's write would reach another tenant's subscriber of the
 * same publication. Until delivery is tenant-aware such a publication is
 * refused outright rather than filtered after the fact.
 */
function readsTenantScopedModel(query: ModelQuery<object>): boolean {
  if (tenantScopeColumn(query.entity) !== undefined) {
    return true;
  }
  return query.builder.expressionMap.aliases.some(
    (alias) =>
      alias.hasMetadata &&
      typeof alias.metadata.target === 'function' &&
      tenantScopeColumn(alias.metadata.target) !== undefined,
  );
}

function readsHead(log: ChangeLog): log is HeadReadingChangeLog {
  return typeof (log as Partial<HeadReadingChangeLog>).readHead === 'function';
}

/** A counting semaphore: at most `limit` tasks run at once, the rest wait in order. */
function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createLiveService(options: LiveServiceOptions): LiveService {
  if (options.maxRows !== undefined && options.maxRows > HARD_MAX_ROWS) {
    throw new TypeError(`maxRows must not exceed the hard cap of ${HARD_MAX_ROWS}`);
  }
  const maxConcurrentProbes = options.maxConcurrentProbes ?? DEFAULT_MAX_CONCURRENT_PROBES;
  if (!Number.isInteger(maxConcurrentProbes) || maxConcurrentProbes < 1) {
    throw new TypeError('maxConcurrentProbes must be a positive integer');
  }

  const registry = options.registry;
  const changeLog = options.changeLog;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const errorHandler = options.onError;
  function onError(error: unknown): void {
    if (errorHandler === undefined) {
      return;
    }
    try {
      errorHandler(error);
    } catch {
      // The handler runs inside the publish chain and detached drivers; letting
      // its failure propagate would reject the chain and stop every later
      // publish. The warning carries no value from either error.
      process.emitWarning('a live onError handler threw', { code: 'JSAILS_LIVE_ON_ERROR' });
    }
  }
  const deliverLocally = options.deliverLocally ?? true;
  const limit = createLimiter(maxConcurrentProbes);
  // Fan-out runs on timers and promise chains started by whichever write or
  // subscribe happened to trigger them. Running that work in the context the
  // service was built in keeps it from inheriting the trigger's async-local
  // state, such as the writing request's tenant, which would scope every probe
  // to that tenant.
  const detached = AsyncLocalStorage.snapshot();
  const readHead: () => Promise<number> = readsHead(changeLog)
    ? () => changeLog.readHead()
    : () => Promise.resolve(changeLog.head);

  let started = false;
  let idCounter = 0;
  const subscriptions = new Map<string, Subscription>();
  const drivers = new Map<string, Driver>();
  const driversByEntity = new Map<string, Set<Driver>>();
  const buffersByEntity = new Map<string, Set<SnapshotBuffer>>();
  const pending = new Map<string, LiveChange>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Serialize appends so sequence assignment matches commit order. Every link
   * settles successfully (failures go to `onError`, which never throws), so
   * one failed append or fan-out can never stall the batches queued behind it.
   */
  let publishChain: Promise<void> = Promise.resolve();

  function nextId(): string {
    idCounter += 1;
    return String(idCounter);
  }

  function reportDeliveryFailure(error: unknown): void {
    onError(new LiveDeliveryError('io_failed', 'a live delivery failed', { cause: error }));
  }

  /**
   * Probe the membership of every row the changes name in batched
   * `WHERE id IN (...)` queries, and return the projected row each id should
   * hold. An id absent from the result is gone or no longer satisfies the
   * publication's predicate — the membership flip the shape constraint makes
   * representable by a write to the row's own columns (docs/design/live.md §15.3).
   */
  async function probeRows(
    view: PublicationView,
    changes: readonly LiveChange[],
  ): Promise<Map<string, LiveRow>> {
    const columns = view.entity.getRepository().metadata.primaryColumns;
    const ids = new Map<string, unknown>();
    for (const change of changes) {
      // A delete short-circuits: no row to probe, and the client removes the id.
      if (change.row === null || ids.has(change.id)) {
        continue;
      }
      // The change log's row carries every scalar column, the raw PK included.
      const idMap: Record<string, unknown> = {};
      let complete = true;
      for (const column of columns) {
        const value = change.row[column.propertyName];
        if (value === undefined) {
          complete = false;
          break;
        }
        idMap[column.propertyName] = value;
      }
      if (complete) {
        const first = columns[0];
        ids.set(
          change.id,
          columns.length === 1 && first !== undefined ? idMap[first.propertyName] : idMap,
        );
      }
    }

    const rows = new Map<string, LiveRow>();
    const values = [...ids.values()];
    for (let offset = 0; offset < values.length; offset += PROBE_BATCH_SIZE) {
      const probe = view.probeBase.clone();
      probe.andWhereInIds(values.slice(offset, offset + PROBE_BATCH_SIZE));
      for (const member of await probe.getMany()) {
        rows.set(primaryKeyOf(view.entity, member), view.project(member));
      }
    }
    return rows;
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

  async function deliverBatch(driver: Driver, changes: readonly LiveChange[]): Promise<void> {
    const rows = await probeRows(driver.view, changes);
    for (const change of changes) {
      const row = change.row === null ? null : (rows.get(change.id) ?? null);
      if (row !== null) {
        driver.known.add(change.id);
      } else if (!driver.known.delete(change.id)) {
        // Never part of this driver's set: nothing to retract, nothing to leak.
        continue;
      }
      for (const member of driver.members) {
        if (!driver.replaying.has(member)) {
          member.sink(changeMessage(member, change, row));
        }
      }
    }
  }

  async function deliverReplay(driver: Driver, task: ReplayTask): Promise<void> {
    const rows = await probeRows(driver.view, task.changes);
    const messages: LiveServerMessage[] = [];
    for (const change of task.changes) {
      const row = change.row === null ? null : (rows.get(change.id) ?? null);
      if (row !== null) {
        task.held.add(change.id);
        driver.known.add(change.id);
      } else if (task.held.delete(change.id)) {
        driver.known.delete(change.id);
      } else {
        continue;
      }
      messages.push(changeMessage(task.subscription, change, row));
    }
    driver.replaying.delete(task.subscription);
    if (driver.members.has(task.subscription)) {
      for (const message of messages) {
        task.subscription.sink(message);
      }
    }
  }

  /**
   * Run a driver's queued tasks in order, each under the service-wide probe
   * limiter. A failed task is reported and does not stop the ones behind it.
   */
  async function runDriver(driver: Driver): Promise<void> {
    try {
      for (let task = driver.tasks.shift(); task !== undefined; task = driver.tasks.shift()) {
        if (!started || driver.members.size === 0) {
          continue;
        }
        const current = task;
        try {
          await limit(() =>
            current.kind === 'batch'
              ? deliverBatch(driver, current.changes)
              : deliverReplay(driver, current),
          );
        } catch (error) {
          if (current.kind === 'replay') {
            // The member goes live without the missed changes rather than
            // being starved of every later one.
            driver.replaying.delete(current.subscription);
          }
          reportDeliveryFailure(error);
        }
      }
    } finally {
      driver.running = false;
    }
  }

  function kick(driver: Driver): void {
    if (driver.running) {
      return;
    }
    driver.running = true;
    detached(() => detach(runDriver(driver), escalate));
  }

  /** Fan a stored (sequence-assigned) change out to every entity-matched driver. */
  function route(change: LiveChange): void {
    const buffers = buffersByEntity.get(change.collection);
    if (buffers !== undefined) {
      for (const buffer of buffers) {
        buffer.delete(change.id);
        buffer.set(change.id, change);
      }
    }
    const matched = driversByEntity.get(change.collection);
    if (matched === undefined) {
      return;
    }
    for (const driver of matched) {
      // Tasks in the queue have not started, so a trailing batch can still
      // grow: consecutive changes share one probe query.
      const last = driver.tasks[driver.tasks.length - 1];
      if (last?.kind === 'batch') {
        last.changes.push(change);
      } else {
        driver.tasks.push({ kind: 'batch', changes: [change] });
      }
      kick(driver);
    }
  }

  function openBuffer(entityName: string): SnapshotBuffer {
    const buffer: SnapshotBuffer = new Map();
    let set = buffersByEntity.get(entityName);
    if (set === undefined) {
      set = new Set();
      buffersByEntity.set(entityName, set);
    }
    set.add(buffer);
    return buffer;
  }

  function closeBuffer(entityName: string, buffer: SnapshotBuffer): void {
    const set = buffersByEntity.get(entityName);
    set?.delete(buffer);
    if (set !== undefined && set.size === 0) {
      buffersByEntity.delete(entityName);
    }
  }

  /**
   * Join the driver for `key`, creating it on first use, record the ids the
   * new member holds, and queue its replay of the changes it missed. Returns
   * the leave function.
   */
  function joinDriver(
    key: string,
    subscription: Subscription,
    held: Set<string>,
    missed: readonly LiveChange[],
  ): () => void {
    let driver = drivers.get(key);
    if (driver === undefined) {
      driver = {
        key,
        view: subscription.view,
        members: new Set(),
        replaying: new Set(),
        known: new Set(),
        tasks: [],
        running: false,
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
    for (const memberId of held) {
      driver.known.add(memberId);
    }
    if (missed.length > 0) {
      driver.replaying.add(subscription);
      driver.tasks.push({ kind: 'replay', subscription, held: new Set(held), changes: missed });
      kick(driver);
    }
    const joined = driver;
    return () => {
      joined.members.delete(subscription);
      joined.replaying.delete(subscription);
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
      detached(() => detach(drain(), escalate));
    }, flushIntervalMs);
  }

  /**
   * Append a batch in order and fan each change out. A change whose append
   * fails is reported and skipped; the rest of the batch still gets its
   * sequence, because a gap is recoverable (the next change to the row
   * re-probes it) while a stalled log is not.
   */
  async function publish(batch: readonly LiveChange[]): Promise<void> {
    for (const change of batch) {
      let sequence: number;
      try {
        sequence = await changeLog.append(change);
      } catch (error) {
        onError(
          new LiveDeliveryError('io_failed', 'a live change append failed', { cause: error }),
        );
        continue;
      }
      // The log assigns the sequence on a copy; carry it onto the routed record.
      // With a shared log the tailer delivers instead, so routing here would
      // create a second, unordered delivery path (see `deliverLocally`).
      if (deliverLocally && started) {
        route({ ...change, sequence });
      }
    }
  }

  /** Coalesce the pending buffer into the change log and fan out. */
  async function drain(): Promise<void> {
    if (pending.size === 0) {
      return;
    }
    const batch = [...pending.values()];
    pending.clear();
    publishChain = publishChain.then(() => publish(batch)).catch(reportDeliveryFailure);
    await publishChain;
  }

  /**
   * Ingest a capture flush's committed changes, coalesced by (collection, id).
   * A snapshot in flight does not hold the publish back: its buffer captures
   * whatever is routed meanwhile (see the module comment).
   */
  function ingest(changes: readonly LiveChange[]): Promise<void> {
    if (!started || changes.length === 0) {
      return Promise.resolve();
    }
    for (const change of changes) {
      pending.set(`${change.collection}\u0000${change.id}`, change);
    }
    scheduleDrain();
    return Promise.resolve();
  }

  /** Run a publication's `authorize` for a request; only an exact `true` admits it. */
  async function authorizeRequest(
    definition: ErasedPublication,
    params: unknown,
    request: LiveSubscribeRequest,
  ): Promise<boolean> {
    const context: PublicationAuthContext<unknown> = {
      params,
      user: request.user ?? null,
      request: request.request ?? NOOP_REQUEST,
    };
    try {
      return (await definition.authorize(context)) === true;
    } catch {
      return false;
    }
  }

  return {
    async start(): Promise<void> {
      started = true;
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
      for (const driver of drivers.values()) {
        driver.tasks.length = 0;
      }
      drivers.clear();
      driversByEntity.clear();
      buffersByEntity.clear();
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
      if (!(await authorizeRequest(definition, params, request))) {
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
      if (readsTenantScopedModel(query)) {
        return fail('unsupported_tenant_scope');
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
        probeBase: query.builder.clone(),
        project,
      };
      const subscription: Subscription = { id, view, sink, abort: () => controller.abort() };

      // The fan-out key: equal keys share one driver (and one membership set).
      // Params the canonical form cannot represent are an invalid request, not
      // an internal error, and are refused before any query runs. The identity
      // segment covers every claim, not only the id: a query may depend on a
      // role or another claim, and two sessions of one user that disagree on
      // it must not share a membership answer.
      let key: string;
      try {
        key = `${definition.name}:${canonicalParams(params)}`;
      } catch {
        return fail('invalid_params');
      }
      const identity = userFingerprint(user);
      if (identity === undefined) {
        return fail('unauthorized');
      }
      key = `${key}:${identity}`;
      const rowCap = definition.maxRows ?? maxRows;
      // The cap goes into the query: one row past it proves the set is too
      // large without hydrating the rest. The shape guard has already run, so
      // the limit it forbids on the definition cannot trip it here.
      query.builder.take(rowCap + 1);

      /** Load the current member rows, or `undefined` when over the row cap. */
      const loadMembers = async (): Promise<object[] | undefined> => {
        const rows = await query.getMany();
        return rows.length > rowCap ? undefined : rows;
      };

      // The buffer opens before the head is read, so every change appended
      // after that head is routed into it (or, after the join, to the driver).
      const buffer = openBuffer(view.entityName);
      let leave: () => void;
      try {
        const watermark = await readHead();
        let cutoff = watermark;
        let held: Set<string> | undefined;
        let resumed = false;
        let members: object[] | undefined;
        const replay: LiveServerMessage[] = [];

        // Resume replays the retained changes instead of a snapshot when the log
        // still covers the client's last-applied sequence (§8). A successful
        // resume is signalled by replayed changes and *no* snapshot; only the
        // fallback snapshot carries `resumed: false`.
        //
        // A replayed change whose row no longer passes the membership probe is
        // forwarded only when the id is known to be held — by an existing
        // driver for this key or by the current member set. An id that is
        // neither is either a row the client was never allowed to see (which
        // must not be disclosed) or one it held before the window; the snapshot
        // settles both correctly.
        if (request.resumeFrom !== undefined) {
          const slice = await changeLog.since(request.resumeFrom);
          // The replay probes the current row, so only the newest change per id
          // matters; more distinct rows than the cap means a snapshot is cheaper.
          const latest = new Map<string, LiveChange>();
          for (const change of slice.changes) {
            if (change.collection === view.entityName) {
              latest.delete(change.id);
              latest.set(change.id, change);
            }
          }
          if (!slice.truncated && latest.size <= rowCap) {
            const existing = drivers.get(key)?.known;
            let known: Set<string>;
            if (existing === undefined) {
              members = await loadMembers();
              if (members === undefined) {
                return fail('too_many_rows');
              }
              known = new Set(members.map((row) => rowId(view, row)));
            } else {
              known = new Set(existing);
            }
            const changes = [...latest.values()];
            const rows = await probeRows(view, changes);
            let settled = true;
            for (const change of changes) {
              const row = change.row === null ? null : (rows.get(change.id) ?? null);
              if (row !== null) {
                known.add(change.id);
              } else if (!known.delete(change.id)) {
                settled = false;
                break;
              }
              replay.push(changeMessage(subscription, change, row));
            }
            if (settled) {
              resumed = true;
              held = known;
              const last = slice.changes[slice.changes.length - 1];
              cutoff = Math.max(request.resumeFrom, last?.sequence ?? 0);
            } else {
              replay.length = 0;
            }
          }
        }

        let snapshot: LiveServerMessage | undefined;
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
          snapshot = {
            type: 'snapshot',
            subscriptionId: id,
            sequence: watermark,
            rows: projected,
            resumed: false,
          };
          held = new Set(members.map((row) => rowId(view, row)));
          cutoff = watermark;
        }

        // From here to the join everything is synchronous, so no change can be
        // routed between the last buffered one and the driver taking over.
        if (snapshot !== undefined) {
          sink(snapshot);
        }
        for (const message of replay) {
          sink(message);
        }
        const missed = [...buffer.values()].filter((change) => change.sequence > cutoff);
        leave = joinDriver(key, subscription, held ?? new Set(), missed);
      } finally {
        closeBuffer(view.entityName, buffer);
      }
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

    async authorize(request: LiveSubscribeRequest): Promise<boolean> {
      const definition = registry.get(request.publication);
      if (definition === undefined) {
        return false;
      }
      let params: unknown;
      try {
        params = definition.params.parse(request.params);
      } catch {
        return false;
      }
      return authorizeRequest(definition, params, request);
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
