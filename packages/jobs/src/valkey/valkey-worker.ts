/**
 * One `startWorker` of the Valkey transport: a BullMQ worker per queue, each
 * on its own dedicated `queue`-role connection, running the package's
 * processor and applying its outcome the way BullMQ applies outcomes.
 *
 * - completed, discarded, skipped: the processor's return value completes
 *   the job (`'c'`, or `'s'` for skipped).
 * - released: the job is moved back itself (delayed, or waiting at once)
 *   without spending an attempt, and BullMQ is told it moved; an
 *   `unknown_job` release first counts itself in the job's progress field,
 *   which BullMQ delivers with every fetch, so the count costs no read.
 * - failed, not final: `jobs.attempt_failed`; BullMQ spends the attempt and
 *   waits out the envelope's backoff.
 * - failed, final: BullMQ's unrecoverable error carrying the record; a
 *   dropped job has `removeOnFail` set on the delivered job, so BullMQ's
 *   own fail script deletes it in the same step.
 *
 * A job that lost its worker (its lock lapsed: a crash, a blocked event
 * loop) is put back by BullMQ's stalled check, which counts it. The
 * transport applies the stall limit itself rather than leave it to BullMQ,
 * whose own limit fails the job without running any processor and so would
 * settle a batch child or a chain step without its batch record or its
 * catch: a delivery whose count exceeds `maxStalledCount` runs no code and
 * fails for good with `jobs.job_stalled`, carrying the chain's catch when
 * the job is a chain step, through the same settle as any final failure.
 * The job is kept in the failed set whatever its `onFinalFailure`: that is
 * the definition's policy, which only the runtime reads.
 *
 * BullMQ completes or fails a job in its own script, so what a final
 * outcome writes besides (its follow-ups, its batch record, a chain step's
 * fired catch) is written just before, inside the attempt, while the lock
 * is held and renewed. Every follow-up is keyed and a batch record keeps a
 * child's first outcome, so a crash or a lost lock between the two
 * redelivers the job and the writes store nothing twice. A write that keeps
 * failing (five tries, 100 ms doubling) abandons the settle: the job goes
 * back delayed by one lock duration, or, when even that fails, its lock is
 * left to lapse, so it is redelivered and never settled without its writes.
 * An abandoned attempt emits no settle event.
 *
 * A settle event is emitted once BullMQ applied the outcome: on the worker's
 * `completed` and `failed` events, or right after a release moved the job.
 * Drain is BullMQ's `close()`, which waits for every processor; abort first
 * aborts every in-flight signal, synchronously, and so does every later
 * delivery. A drain or an abort that lands while the worker is still
 * starting (a dedicated connection can take seconds) first waits for the
 * start to reach its next step, where it stops, so every BullMQ worker and
 * connection the start opened is closed before the drain resolves.
 */

import type { ValkeyClient } from 'jsails/plugin-sdk';

import {
  checkedAttemptOutcome,
  isFinalFailure,
  PROCESSOR_BROKE_CONTRACT,
  type AdapterWorker,
  type AttemptOutcome,
  type JobEnvelope,
  type JobFollowUp,
  type ProcessJob,
  type QueueDeclaration,
  type SettleEvent,
  type TransportJob,
} from '../contract/index.js';
import { boundedDelay, checkedFollowUps } from '../contract/settle-rules.js';
import { decodeEnvelope } from '../envelope/codec.js';
import { runtimeSummary } from '../errors/error-summary.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { chainCatch, withCatchFired } from '../flows/chain-advance.js';
import { isFlowId } from '../flows/flow-limits.js';
import type { BullJob, BullmqModule, BullWorker } from './bullmq-surface.js';
import { encodeFailure, stackless } from './failure-record.js';
import { envelopeBackoff } from './job-mapping.js';
import { COMPLETED_RESULT, finalizerIdOfChild, SKIPPED_RESULT } from './key-layout.js';
import { transportError } from './transport-error.js';

/**
 * BullMQ's own stall limit, set out of reach: the transport applies
 * `maxStalledCount` itself (see the module comment).
 */
const BULLMQ_STALL_LIMIT = 1_000_000;

/** How often a settle's writes are tried before the settle is abandoned. */
const SETTLE_WRITE_TRIES = 5;
const SETTLE_WRITE_FIRST_DELAY_MS = 100;

/** A batch child's membership, read from its stored envelope and its job id. */
export interface BatchMembership {
  readonly id: string;
  readonly index: number;
  /** The finalizer id of the batch incarnation the child was stored under. */
  readonly finalizerId: string;
}

/** What a worker asks of the adapter that owns it. */
export interface ValkeyWorkerHost {
  readonly module: BullmqModule;
  readonly prefix: string;
  readonly lockDurationMs: number;
  readonly maxStalledCount: number;
  declaration(queue: string): QueueDeclaration | undefined;
  hasQueue(queue: string): boolean;
  /** A new dedicated `queue`-role connection for the worker of `queue`. */
  connect(queue: string): Promise<ValkeyClient>;
  /** Store one follow-up as `enqueue` stores a job. */
  storeFollowUp(followUp: JobFollowUp): Promise<void>;
  /** Record a batch child's final outcome (`'c'`, `'s'` or a failure record). */
  recordChild(batch: BatchMembership, value: string): Promise<void>;
  /** A failure no caller awaits, already value-free. */
  report(error: Error): void;
  /** The worker stopped; resolves once what the adapter runs for workers stopped too. */
  forget(worker: ValkeyWorker): Promise<void>;
}

interface Delivery {
  readonly controller: AbortController;
}

interface Serving {
  readonly queue: string;
  readonly worker: BullWorker;
  readonly connection: ValkeyClient;
}

/** Surface an error nothing can handle as an uncaught exception, never dropped. */
function surface(error: unknown): void {
  setImmediate(() => {
    throw error;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The batch membership of job `jobId` storing `data`, read without decoding
 * the whole envelope; undefined for a job that is no batch child, or whose id
 * is not a child id for its index.
 */
export function batchMembershipOf(
  data: unknown,
  jobId: string | undefined,
): BatchMembership | undefined {
  if (!isRecord(data) || !isRecord(data.meta)) return undefined;
  const { flow } = data.meta;
  if (!isRecord(flow) || flow.kind !== 'batch' || !isFlowId(flow.id)) return undefined;
  const { index } = flow;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return undefined;
  const finalizerId = jobId === undefined ? undefined : finalizerIdOfChild(jobId, index);
  return finalizerId === undefined ? undefined : { id: flow.id, index, finalizerId };
}

/** The unknown-release count a job carries in its progress field. */
function unknownReleasesOf(progress: unknown): number {
  return typeof progress === 'number' && Number.isSafeInteger(progress) && progress > 0
    ? progress
    : 0;
}

/**
 * The final failure of a job that lost its worker more often than the stall
 * limit allows: `jobs.job_stalled`, with the chain's catch when the job is a
 * chain step whose catch has not fired and names a queue `hasQueue` accepts.
 */
export function stalledOutcome(
  data: unknown,
  hasQueue: (queue: string) => boolean,
): AttemptOutcome {
  const error = runtimeSummary('job_stalled');
  const decoded = decodeEnvelope(data);
  const caught = decoded.ok ? chainCatch(decoded.envelope, Date.now()) : undefined;
  if (caught === undefined || !hasQueue(caught.queue)) {
    return Object.freeze({ kind: 'failed', error, retryable: false });
  }
  return Object.freeze({
    kind: 'failed',
    error,
    retryable: false,
    catchFired: true,
    followUps: Object.freeze([caught]),
  });
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The workers one `startWorker` runs, one per queue. */
export class ValkeyWorker implements AdapterWorker {
  readonly #host: ValkeyWorkerHost;
  readonly #process: ProcessJob;
  readonly #onSettle: ((event: SettleEvent) => void) | undefined;
  readonly #inFlight = new Set<Delivery>();
  readonly #pending = new WeakMap<BullJob, SettleEvent>();
  readonly #serving: Serving[] = [];
  #aborted = false;
  #opening: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    host: ValkeyWorkerHost,
    process: ProcessJob,
    onSettle: ((event: SettleEvent) => void) | undefined,
  ) {
    this.#host = host;
    this.#process = process;
    this.#onSettle = onSettle;
  }

  /** Attempts whose processor is running in this process. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** The queues this worker fetches from: none once it drains or aborts. */
  get fetching(): readonly string[] {
    return this.#closing === undefined ? this.#serving.map((serving) => serving.queue) : [];
  }

  /**
   * Start a BullMQ worker on each queue, `concurrency` (or the queue's own)
   * jobs at a time. Resolves true once every one is ready, or false when a
   * drain or an abort began first, by which time everything the start opened
   * is closed. A failure closes what already started.
   */
  async start(
    queues: readonly QueueDeclaration[],
    concurrency: number | undefined,
  ): Promise<boolean> {
    const opening = this.#open(queues, concurrency);
    this.#opening = opening;
    try {
      await opening;
    } catch (error) {
      await this.drain();
      throw transportError(error);
    }
    if (this.#closing === undefined) return true;
    await this.#closing;
    return false;
  }

  /** Open each queue's connection and worker in turn, stopping at the first step that finds a drain begun. */
  async #open(queues: readonly QueueDeclaration[], concurrency: number | undefined): Promise<void> {
    for (const declaration of queues) {
      if (this.#closing !== undefined) return;
      const connection = await this.#host.connect(declaration.name);
      if (this.#closing !== undefined) {
        connection.disconnect();
        return;
      }
      let worker: BullWorker;
      try {
        worker = this.#host.module.createWorker(
          declaration.name,
          (job, token) => this.#run(declaration.name, job, token),
          {
            connection,
            prefix: this.#host.prefix,
            concurrency: concurrency ?? declaration.concurrency,
            lockDuration: this.#host.lockDurationMs,
            // A lapsed lock is found within two checks, as soon as it can lapse.
            stalledInterval: this.#host.lockDurationMs,
            maxStalledCount: BULLMQ_STALL_LIMIT,
            settings: { backoffStrategy: envelopeBackoff },
          },
        );
      } catch (error) {
        connection.disconnect();
        throw error;
      }
      this.#serving.push({ queue: declaration.name, worker, connection });
      worker.on('error', (error) => this.#host.report(transportError(error)));
      worker.on('completed', (job) => this.#settled(job));
      worker.on('failed', (job) => this.#settled(job));
      await worker.waitUntilReady();
    }
  }

  drain(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  abort(): Promise<void> {
    this.#aborted = true;
    for (const delivery of this.#inFlight) {
      delivery.controller.abort(new JobsErrors.Error('worker_aborted'));
    }
    return this.drain();
  }

  async #close(): Promise<void> {
    // A start still opening stops at its next step; what it opened up to
    // there is in #serving once it settles. Its failure is start()'s to throw.
    await Promise.allSettled([this.#opening]);
    // BullMQ's close waits for every running processor: a job stays held
    // until its code settles, so it never runs alongside an abandoned attempt.
    await Promise.all(
      this.#serving.map(async ({ worker, connection }) => {
        try {
          await worker.close();
        } catch (error) {
          this.#host.report(transportError(error));
        } finally {
          connection.disconnect();
        }
      }),
    );
    await this.#host.forget(this);
  }

  #emit(event: SettleEvent): void {
    try {
      this.#onSettle?.(event);
    } catch (error) {
      // The job is already settled; a throwing observer is a runtime bug,
      // surfaced as an uncaught exception rather than wedging this worker.
      surface(error);
    }
  }

  /** BullMQ applied a completion or a failure: emit the settle the processor prepared. */
  #settled(job: BullJob | undefined): void {
    if (job === undefined) return;
    const event = this.#pending.get(job);
    if (event === undefined) return;
    this.#pending.delete(job);
    this.#emit(event);
  }

  async #run(queue: string, job: BullJob, token: string | undefined): Promise<unknown> {
    const delivery: Delivery = { controller: new AbortController() };
    if (this.#aborted) delivery.controller.abort(new JobsErrors.Error('worker_aborted'));
    this.#inFlight.add(delivery);
    try {
      return await this.#attempt(queue, job, token, delivery.controller.signal);
    } finally {
      this.#inFlight.delete(delivery);
    }
  }

  async #attempt(
    queue: string,
    job: BullJob,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const transportJob: TransportJob = Object.freeze({
      id: job.id ?? '',
      queue,
      // BullMQ parses the stored data on every fetch: each delivery gets its own copy.
      envelope: job.data as JobEnvelope,
      attemptsMade: job.attemptsMade,
      unknownReleases: unknownReleasesOf(job.progress),
    });
    let outcome: AttemptOutcome;
    if (job.stalledCounter > this.#host.maxStalledCount) {
      outcome = stalledOutcome(job.data, (name) => this.#host.hasQueue(name));
    } else {
      let processed: Promise<AttemptOutcome>;
      try {
        // `Promise.resolve` also covers a processor that returns a bare value.
        processed = Promise.resolve(this.#process(transportJob, signal));
      } catch {
        processed = Promise.resolve(PROCESSOR_BROKE_CONTRACT);
      }
      outcome = await processed.then(checkedAttemptOutcome, () => PROCESSOR_BROKE_CONTRACT);
    }
    const attempts = job.opts.attempts ?? 1;
    let followUps = checkedFollowUps(outcome, job.attemptsMade, attempts, (name) =>
      this.#host.hasQueue(name),
    );
    if (followUps === undefined) {
      outcome = PROCESSOR_BROKE_CONTRACT;
      followUps = [];
    }
    const { module } = this.#host;
    switch (outcome.kind) {
      case 'completed':
      case 'discarded':
      case 'skipped': {
        const value = outcome.kind === 'skipped' ? SKIPPED_RESULT : COMPLETED_RESULT;
        const writes = followUps;
        if (!(await this.#write(() => this.#settleWrites(job, writes, value, false)))) {
          throw await this.#abandon(job, token);
        }
        this.#pending.set(job, { job: transportJob, outcome, final: true, failedJob: undefined });
        return value;
      }
      case 'released':
        return this.#release(job, token, transportJob, outcome);
      case 'failed': {
        const reason = encodeFailure(job.name, outcome.error);
        if (!isFinalFailure(job.attemptsMade, attempts, outcome.retryable)) {
          this.#pending.set(job, {
            job: transportJob,
            outcome,
            final: false,
            failedJob: undefined,
          });
          // The record of a failure that is not final is never read back (only a
          // final failure is listed), so BullMQ keeps this value-free marker.
          throw stackless(new JobsErrors.Error('attempt_failed'));
        }
        const writes = followUps;
        const catchFired = outcome.catchFired === true;
        if (!(await this.#write(() => this.#settleWrites(job, writes, reason, catchFired)))) {
          throw await this.#abandon(job, token);
        }
        const dropped = outcome.drop === true;
        if (dropped) job.opts.removeOnFail = true;
        // A failed retention count of 0 removes the job as it fails.
        const kept = !dropped && (this.#host.declaration(queue)?.retention.failed.count ?? 1) > 0;
        this.#pending.set(job, {
          job: transportJob,
          outcome,
          final: true,
          failedJob: kept ? Object.freeze({ id: transportJob.id, queue }) : undefined,
        });
        throw stackless(module.unrecoverable(reason));
      }
    }
  }

  /** Move a released job back without spending an attempt, then tell BullMQ it moved. */
  async #release(
    job: BullJob,
    token: string | undefined,
    transportJob: TransportJob,
    outcome: Extract<AttemptOutcome, { kind: 'released' }>,
  ): Promise<never> {
    const { module } = this.#host;
    const delayMs = boundedDelay(outcome.delayMs);
    try {
      if (outcome.reason === 'unknown_job') {
        await job.updateProgress(transportJob.unknownReleases + 1);
      }
      if (delayMs > 0) await job.moveToDelayed(Date.now() + delayMs, token);
      else await job.moveToWait(token);
    } catch (error) {
      // The move did not happen (a lost lock, an unreachable server): the
      // lock lapses and the job is redelivered; nothing settled.
      this.#host.report(transportError(error));
      throw module.waiting();
    }
    this.#emit({ job: transportJob, outcome, final: false, failedJob: undefined });
    throw delayMs > 0 ? module.delayed() : module.waiting();
  }

  /** What a final outcome writes before BullMQ settles the job. */
  async #settleWrites(
    job: BullJob,
    followUps: readonly JobFollowUp[],
    recorded: string,
    catchFired: boolean,
  ): Promise<void> {
    for (const followUp of followUps) await this.#host.storeFollowUp(followUp);
    const batch = batchMembershipOf(job.data, job.id);
    if (batch !== undefined) await this.#host.recordChild(batch, recorded);
    if (catchFired) {
      // A processor that flags a job that is no chain step broke the
      // contract; the flag means nothing for such a job and is ignored.
      const decoded = decodeEnvelope(job.data);
      if (decoded.ok && decoded.envelope.meta.flow?.kind === 'chain') {
        await job.updateData(withCatchFired(decoded.envelope));
      }
    }
  }

  /** Run `writes`, trying again on failure; false once every try failed. */
  async #write(writes: () => Promise<void>): Promise<boolean> {
    let delay = SETTLE_WRITE_FIRST_DELAY_MS;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await writes();
        return true;
      } catch (error) {
        if (attempt >= SETTLE_WRITE_TRIES) {
          this.#host.report(transportError(error));
          return false;
        }
      }
      await pause(delay);
      delay *= 2;
    }
  }

  /** Give up on settling `job`: back to delayed for a lock duration, or left for its lock to lapse. */
  async #abandon(job: BullJob, token: string | undefined): Promise<Error> {
    const { module } = this.#host;
    try {
      await job.moveToDelayed(Date.now() + this.#host.lockDurationMs, token);
      return module.delayed();
    } catch (error) {
      this.#host.report(transportError(error));
      return module.waiting();
    }
  }
}
