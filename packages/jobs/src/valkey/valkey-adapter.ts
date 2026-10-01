/**
 * The Valkey transport: a shared {@link JobsAdapter} on BullMQ, so producers
 * and workers in any number of processes share one app environment's jobs.
 *
 * Its keys live under `<namespace>:jobs` (see `key-layout.ts`). Every
 * client comes from the app's Valkey provider: queues, the batch producer
 * and the transport's scripts share the provider's `command` connection (a
 * dispatch is a request-path command, so it fails fast and every reply has
 * a deadline), and each BullMQ worker gets its own dedicated `queue`-role
 * connection, disconnected when the worker closes. The provider itself
 * belongs to the app and is never closed here.
 *
 * It holds the contract the memory adapter holds, the differences being
 * what a server-side store implies:
 *
 * - a key deduplicates on its queue for its window by BullMQ's TTL
 *   deduplication key, which BullMQ writes in its add script and which
 *   outlives completion and retention eviction;
 * - BullMQ counts attempts: a release moves the job back without spending
 *   one, a retryable failure spends one and waits out the backoff the
 *   worker computes from the envelope (`job-mapping.ts`);
 * - a job's lock is renewed while its code runs; a worker that dies leaves
 *   its jobs to be redelivered once the lock lapses, and a job that loses
 *   its worker more than `maxStalledCount` times fails with
 *   `jobs.job_stalled`;
 * - what a final outcome writes besides its own settle (follow-ups, batch
 *   records, a fired catch) is written just before BullMQ settles the job,
 *   idempotently (`valkey-worker.ts`);
 * - batches, schedules and leases are the transport's own records, each
 *   operation one script (`valkey-batches.ts`, `valkey-schedules.ts`,
 *   `valkey-leases.ts`); failed jobs are BullMQ's failed sets
 *   (`valkey-failed-jobs.ts`).
 *
 * Schedules fire through the package's ticker in every process that runs a
 * worker, on the `clock` option; everything else runs on real time.
 *
 * Test hooks stand for what the server does on its own:
 * {@link ValkeyJobsAdapter.redeliver} delivers a settled job again, as after
 * a lost lock, {@link ValkeyJobsAdapter.evictCompleted} applies retention to
 * completed jobs at once, {@link ValkeyJobsAdapter.promoteDue} lets delayed
 * jobs fall due on a virtual clock, and {@link ValkeyJobsAdapter.busy} and
 * {@link ValkeyJobsAdapter.schedulesIdle} say whether anything is still
 * running.
 */

import type { ValkeyClient } from 'jsails/plugin-sdk';

import type {
  AdapterWorker,
  JobEnvelope,
  JobHandle,
  JobsAdapter,
  JobsAdapterContext,
  JobsAdapterFactory,
  ProcessJob,
  QueueDeclaration,
  WorkerOptions,
} from '../contract/index.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { DEFAULT_RETENTION } from '../queues/queue-set.js';
import { startScheduleTicker, type ScheduleTicker } from '../schedules/ticker.js';
import { loadBullmq } from './bullmq-module.js';
import type { BullFlowProducer, BullmqModule, BullQueue } from './bullmq-surface.js';
import { addOptionsOf } from './job-mapping.js';
import { keyLayout, newJobId, type KeyLayout } from './key-layout.js';
import { guarded, transportError } from './transport-error.js';
import { ValkeyBatches } from './valkey-batches.js';
import { ValkeyFailedJobs } from './valkey-failed-jobs.js';
import { ValkeyLeases } from './valkey-leases.js';
import {
  resolveValkeyJobsOptions,
  type ResolvedValkeyJobsOptions,
  type ValkeyJobsOptions,
} from './valkey-options.js';
import { ValkeySchedules } from './valkey-schedules.js';
import { bindValkeyScripts, type ValkeyScripts } from './valkey-scripts.js';
import { ValkeyWorker, type ValkeyWorkerHost } from './valkey-worker.js';

/** The delayed-set score bound of "due now": BullMQ scores a delayed job `timestamp * 4096 + counter`. */
function dueScore(now: number): string {
  return String((now + 1) * 0x1000);
}

/** The Valkey {@link JobsAdapter}. */
export class ValkeyJobsAdapter implements JobsAdapter {
  readonly name = 'valkey';
  readonly reach = 'shared';
  readonly capabilities: JobsAdapter['capabilities'];
  readonly #options: ResolvedValkeyJobsOptions;
  readonly #module: BullmqModule;
  readonly #connection: ValkeyClient;
  readonly #layout: KeyLayout;
  readonly #scripts: ValkeyScripts;
  readonly #declarations: ReadonlyMap<string, QueueDeclaration>;
  readonly #queues = new Map<string, BullQueue>();
  readonly #flows: BullFlowProducer;
  readonly #workers = new Set<ValkeyWorker>();
  readonly #batches: ValkeyBatches;
  readonly #schedules: ValkeySchedules;
  readonly #workerHost: ValkeyWorkerHost;
  #ticker: ScheduleTicker | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  /**
   * Build the adapter for `context` on BullMQ `module`; `connection` is the
   * provider's shared `command` client. Use {@link valkeyJobs}.
   */
  constructor(
    context: JobsAdapterContext,
    options: ResolvedValkeyJobsOptions,
    module: BullmqModule,
    connection: ValkeyClient,
  ) {
    this.#options = options;
    this.#module = module;
    this.#connection = connection;
    this.#layout = keyLayout(context.namespace);
    this.#scripts = bindValkeyScripts(options.connections);
    this.#declarations = new Map(context.queues.map((queue) => [queue.name, queue]));
    for (const declaration of context.queues) this.#queue(declaration.name);
    const report = (error: Error): void => this.#report(error);
    this.#flows = module.createFlowProducer({ connection, prefix: this.#layout.prefix });
    this.#flows.on('error', (error) => report(transportError(error)));
    const declaration = (queue: string): QueueDeclaration =>
      this.#declarations.get(queue) ?? {
        name: queue,
        concurrency: 1,
        retention: DEFAULT_RETENTION,
      };
    this.#batches = new ValkeyBatches({
      scripts: this.#scripts,
      layout: this.#layout,
      hasQueue: (queue) => this.#declarations.has(queue),
      declaration,
      queue: (name) => this.#queue(name),
      flows: this.#flows,
      assertOpen: () => {
        if (this.#closed) throw new JobsErrors.Error('adapter_closed');
      },
    });
    this.#schedules = new ValkeySchedules({
      scripts: this.#scripts,
      layout: this.#layout,
      clock: options.clock,
      scheduleSyncMs: options.scheduleSyncMs,
      hasQueue: (queue) => this.#declarations.has(queue),
      enqueue: (queue, envelope) => this.#store(queue, envelope),
      report,
    });
    this.#workerHost = {
      module,
      prefix: this.#layout.prefix,
      lockDurationMs: options.lockDurationMs,
      maxStalledCount: options.maxStalledCount,
      declaration: (queue) => this.#declarations.get(queue),
      hasQueue: (queue) => this.#declarations.has(queue),
      connect: (queue) => guarded(() => options.connections.dedicated('queue', `jobs-${queue}`)),
      storeFollowUp: async ({ queue, envelope }) => {
        await this.#store(queue, envelope);
      },
      recordChild: (batch, value) => this.#batches.recordChild(batch, value),
      report,
      forget: (worker) => this.#forget(worker),
    };
    this.capabilities = Object.freeze({
      flows: this.#batches,
      failedJobs: new ValkeyFailedJobs({
        scripts: this.#scripts,
        layout: this.#layout,
        batches: this.#batches,
        declarations: [...this.#declarations.values()],
        queue: (name) => this.#queue(name),
      }),
      schedules: this.#schedules,
      leases: new ValkeyLeases(this.#scripts, this.#layout),
    });
  }

  #report(error: Error): void {
    try {
      this.#options.onError(error);
    } catch (thrown) {
      // A throwing error observer is an app bug, surfaced rather than lost.
      setImmediate(() => {
        throw thrown;
      });
    }
  }

  /** The BullMQ queue `name`, created on first use (a finalizer may run on a queue this process does not declare). */
  #queue(name: string): BullQueue {
    let queue = this.#queues.get(name);
    if (queue === undefined) {
      queue = this.#module.createQueue(name, {
        connection: this.#connection,
        prefix: this.#layout.prefix,
      });
      queue.on('error', (error) => this.#report(transportError(error)));
      this.#queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Resolve once every declared queue's connection and the batch producer's
   * are ready (BullMQ checks the server version when each first connects),
   * so a server that is unreachable fails the app at assembly, not at its
   * first dispatch, and nothing of the setup is still in flight when the
   * first job is added.
   */
  async ready(): Promise<void> {
    await Promise.all([
      ...[...this.#declarations.keys()].map((name) =>
        guarded(() => this.#queue(name).waitUntilReady()),
      ),
      guarded(() => this.#flows.waitUntilReady()),
    ]);
  }

  /**
   * @throws (as a rejection) `jobs.invalid_envelope` for a value that is not
   *   a current-version envelope; `jobs.transport_failed` when the server
   *   does not take it.
   */
  async enqueue(queue: string, value: JobEnvelope): Promise<JobHandle> {
    if (this.#closed) throw new JobsErrors.Error('adapter_closed');
    if (!this.#declarations.has(queue)) throw new JobsErrors.Error('unknown_queue');
    const decoded = decodeEnvelope(value);
    if (!decoded.ok) throw new JobsErrors.Error('invalid_envelope');
    return this.#store(queue, decoded.envelope);
  }

  /** Add a decoded envelope under a fresh id; a taken key hands back the first job's id. */
  async #store(queue: string, envelope: JobEnvelope): Promise<JobHandle> {
    const declaration = this.#declarations.get(queue);
    if (declaration === undefined) throw new JobsErrors.Error('unknown_queue');
    const jobId = newJobId();
    const job = await guarded(() =>
      this.#queue(queue).add(
        envelope.name,
        envelope,
        addOptionsOf(envelope, declaration, jobId, Date.now()),
      ),
    );
    const id = job.id ?? jobId;
    return Object.freeze({ id, deduplicated: id !== jobId });
  }

  async startWorker(options: WorkerOptions, process: ProcessJob): Promise<AdapterWorker> {
    if (this.#closed) throw new JobsErrors.Error('adapter_closed');
    if (options.queues.length === 0) {
      throw new JobsErrors.Error('invalid_worker', { option: 'queues' });
    }
    if (
      options.concurrency !== undefined &&
      (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)
    ) {
      throw new JobsErrors.Error('invalid_worker', { option: 'concurrency' });
    }
    const queues: QueueDeclaration[] = [];
    for (const name of new Set(options.queues)) {
      const declaration = this.#declarations.get(name);
      if (declaration === undefined) throw new JobsErrors.Error('unknown_queue');
      queues.push(declaration);
    }
    const worker = new ValkeyWorker(this.#workerHost, process, options.onSettle);
    this.#workers.add(worker);
    let started: boolean;
    try {
      started = await worker.start(queues, options.concurrency);
    } catch (error) {
      this.#workers.delete(worker);
      throw this.#closed ? new JobsErrors.Error('adapter_closed') : error;
    }
    // Only close() stops a worker that was never handed out, and it owns it:
    // the worker is closed already, or is among those close() waits for.
    if (!started || this.#closed) throw new JobsErrors.Error('adapter_closed');
    if (this.#ticker === undefined) {
      this.#schedules.startFiring();
      this.#ticker = startScheduleTicker(this.#schedules.port, this.#options.clock, (error) =>
        this.#report(transportError(error)),
      );
    }
    return worker;
  }

  async #forget(worker: ValkeyWorker): Promise<void> {
    this.#workers.delete(worker);
    if (this.#workers.size === 0) await this.#stopTicker();
  }

  /**
   * Stop firing schedules (a producer-only process never fires), resolving
   * once every read and fire the ticker started finished: a fire still on
   * its way to the server when the last worker stops, or when the adapter
   * closes, completes against open queues, never after them.
   */
  #stopTicker(): Promise<void> {
    this.#ticker?.stop();
    this.#ticker = undefined;
    return this.#schedules.stopFiring();
  }

  /**
   * Stop every worker as `abort()` does, and the schedule ticker, and wait
   * for both (a worker still starting included, and every schedule read or
   * fire already on its way), then close the queues. The provider's
   * connections stay open: they belong to the app. Idempotent.
   */
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    // Every worker is aborted in this same step, before anything is awaited:
    // a worker still starting then opens nothing more, so no BullMQ worker
    // starts fetching once the close began.
    const stopping = [...this.#workers].map((worker) => worker.abort());
    await this.#stopTicker();
    await Promise.all(stopping);
    await Promise.all(
      [...this.#queues.values(), this.#flows].map(async (producer) => {
        try {
          await producer.close();
        } catch (error) {
          this.#report(transportError(error));
        }
      }),
    );
  }

  /**
   * Test hook: whether an attempt runs here, or a queue a worker of this
   * adapter fetches from has a job runnable now (waiting, prioritized,
   * active, or delayed and due).
   */
  async busy(): Promise<boolean> {
    const fetched = new Set<string>();
    for (const worker of this.#workers) {
      if (worker.inFlight > 0) return true;
      for (const queue of worker.fetching) fetched.add(queue);
    }
    if (fetched.size === 0) return false;
    const keys: string[] = [];
    for (const name of fetched) {
      const prefix = this.#layout.queueKey(name);
      keys.push(`${prefix}wait`, `${prefix}prioritized`, `${prefix}active`, `${prefix}delayed`);
    }
    const reply = await guarded(() => this.#scripts.busy.run(keys, [dueScore(Date.now())]));
    return reply === 1;
  }

  /**
   * Test hook: make every delayed job of the declared queues that is due by
   * `now` runnable at once, as the server does once its clock reaches the
   * job's time; a test on a virtual clock calls it as the clock moves.
   * Returns how many jobs it moved.
   */
  async promoteDue(now: number): Promise<number> {
    let promoted = 0;
    for (const name of this.#declarations.keys()) {
      const prefix = this.#layout.queueKey(name);
      const ids = await guarded(() =>
        this.#scripts.dueDelayed.run([`${prefix}delayed`], [dueScore(now)]),
      );
      for (const id of Array.isArray(ids) ? (ids as unknown[]) : []) {
        if (typeof id !== 'string') continue;
        const job = await guarded(() => this.#queue(name).getJob(id));
        if (job === undefined) continue;
        await guarded(() => job.promote());
        promoted += 1;
      }
    }
    return promoted;
  }

  /** Test hook: resolve once no schedule read or fire of this process is running. */
  schedulesIdle(): Promise<void> {
    return this.#schedules.idle();
  }

  /**
   * Test hook: deliver a completed or failed job again under the same id
   * with the same stored data and attempt count, as the server does after a
   * lost lock. False when no declared queue holds it settled.
   */
  async redeliver(id: string): Promise<boolean> {
    for (const name of this.#declarations.keys()) {
      const prefix = this.#layout.queueKey(name);
      const moved = await guarded(() =>
        this.#scripts.redeliver.run(
          [
            `${prefix}completed`,
            `${prefix}failed`,
            `${prefix}wait`,
            `${prefix}marker`,
            `${prefix}${id}`,
          ],
          [id],
        ),
      );
      if (moved === 1) return true;
    }
    return false;
  }

  /** Test hook: delete every completed job of `queue` now, keeping deduplication keys; returns how many. */
  async evictCompleted(queue: string): Promise<number> {
    if (!this.#declarations.has(queue)) throw new JobsErrors.Error('unknown_queue');
    const prefix = this.#layout.queueKey(queue);
    return Number(
      await guarded(() => this.#scripts.evictCompleted.run([`${prefix}completed`], [prefix])),
    );
  }
}

/**
 * The Valkey adapter factory for `jobs({ adapter })`. Options are checked
 * now; BullMQ is loaded, the shared connection opened and every declared
 * queue made ready when the app builds the adapter.
 *
 * @throws `jobs.invalid_option` or `jobs.unknown_option` for bad options; the
 *   factory rejects with `jobs.missing_dependency` when `bullmq` is not
 *   installed, and with `jobs.transport_failed` (or the provider's own
 *   value-free error) when the server cannot be reached.
 * @public
 */
export function valkeyJobs(options: ValkeyJobsOptions): JobsAdapterFactory {
  const resolved = resolveValkeyJobsOptions(options);
  return async (context) => {
    const module = await (resolved.loadBullmq ?? (() => loadBullmq()))();
    const connection = await guarded(() => resolved.connections.shared('command'));
    const adapter = new ValkeyJobsAdapter(context, resolved, module, connection);
    try {
      await adapter.ready();
    } catch (error) {
      await adapter.close();
      throw error;
    }
    return adapter;
  };
}
