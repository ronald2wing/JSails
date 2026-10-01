/**
 * The part of BullMQ the Valkey transport uses, as the package's own narrow
 * interface. Nothing here imports BullMQ, so these declarations reach a
 * consumer without `bullmq` installed (it is an optional peer); the loader
 * (`bullmq-module.ts`) maps the real module onto them, so the compiler still
 * checks every call against BullMQ's own types, and a test hands the
 * adapter a fake of the same interface.
 */

import type { ValkeyClient } from 'jsails/plugin-sdk';

/** BullMQ's retention of a settled job: removed at once, kept, or kept within bounds (`age` in seconds). */
export type BullKeepJobs = boolean | { readonly age: number; readonly count: number };

/** The options of one add, as the transport maps an envelope. */
export interface BullJobOptions {
  readonly jobId: string;
  readonly attempts: number;
  readonly backoff: { readonly type: string };
  readonly priority?: number;
  readonly delay?: number;
  readonly deduplication?: { readonly id: string; readonly ttl: number };
  readonly removeOnComplete: BullKeepJobs;
  readonly removeOnFail: BullKeepJobs;
}

/** A job as BullMQ delivers or loads it. */
export interface BullJob {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
  readonly attemptsMade: number;
  /** Times the job was found active with no lock and put back (`stc`). */
  readonly stalledCounter: number;
  readonly progress: unknown;
  /** The delivered job's options; BullMQ reads `removeOnFail` from here when it fails the job. */
  opts: { removeOnFail?: unknown; readonly attempts?: number | undefined };
  updateData(data: unknown): Promise<void>;
  updateProgress(progress: number): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
  moveToWait(token?: string): Promise<number>;
  retry(
    state?: 'completed' | 'failed',
    options?: { readonly resetAttemptsMade?: boolean; readonly resetAttemptsStarted?: boolean },
  ): Promise<void>;
  /** Move this delayed job to waiting now. */
  promote(): Promise<void>;
}

/** One job of an atomic add across queues. */
export interface BullFlowJob {
  readonly queueName: string;
  readonly name: string;
  readonly data: unknown;
  readonly opts: BullJobOptions;
}

/**
 * BullMQ's flow producer, used only for jobs with no parent: its bulk add
 * writes every job, whatever its queue, in one `MULTI` transaction.
 */
export interface BullFlowProducer {
  /** Add every job in one transaction: all are stored, or none. */
  addBulk(jobs: readonly BullFlowJob[]): Promise<void>;
  waitUntilReady(): Promise<unknown>;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** A BullMQ queue: the producer side of one queue. */
export interface BullQueue {
  add(name: string, data: unknown, options: BullJobOptions): Promise<BullJob>;
  /** The job `id` of this queue, or undefined when no job has the id. */
  getJob(id: string): Promise<BullJob | undefined>;
  waitUntilReady(): Promise<unknown>;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** BullMQ's processor callback. */
export type BullProcessor = (job: BullJob, token?: string) => Promise<unknown>;

/** The worker options the transport sets. */
export interface BullWorkerOptions {
  readonly connection: ValkeyClient;
  readonly prefix: string;
  readonly concurrency: number;
  readonly lockDuration: number;
  readonly stalledInterval: number;
  readonly maxStalledCount: number;
  readonly settings: {
    readonly backoffStrategy: (
      attemptsMade: number,
      type?: string,
      error?: Error,
      job?: { readonly data: unknown },
    ) => number;
  };
}

/** A BullMQ worker on one queue. */
export interface BullWorker {
  waitUntilReady(): Promise<unknown>;
  close(force?: boolean): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'completed', listener: (job: BullJob) => void): unknown;
  on(event: 'failed', listener: (job: BullJob | undefined) => void): unknown;
}

/** The connection and key prefix every BullMQ object of one adapter shares. */
export interface BullConnectionOptions {
  readonly connection: ValkeyClient;
  readonly prefix: string;
}

/** Everything the transport takes from BullMQ. */
export interface BullmqModule {
  createQueue(name: string, options: BullConnectionOptions): BullQueue;
  createWorker(name: string, processor: BullProcessor, options: BullWorkerOptions): BullWorker;
  createFlowProducer(options: BullConnectionOptions): BullFlowProducer;
  /** The error a processor throws to fail its job for good. */
  unrecoverable(message: string): Error;
  /** The error a processor throws after it moved its job back to waiting itself. */
  waiting(): Error;
  /** The error a processor throws after it moved its job to delayed itself. */
  delayed(): Error;
}
