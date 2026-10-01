/**
 * Failed jobs on the Valkey transport: BullMQ's failed set of each queue,
 * scored by failure time, read and pruned by the transport's own scripts.
 *
 * - `list` reads each queue's page in one script (every job tied at the
 *   cursor's time, a page of older ones, and every job tied with the oldest
 *   of those, so the id order inside a tie is exact), merges the queues
 *   newest first, and leaves out jobs past the queue's failed age that
 *   BullMQ has not evicted yet.
 * - `retry` checks the stored envelope (`retryRefusal`), resets the job's
 *   unknown-release and stall counts, and has BullMQ move the job back with its
 *   attempts reset; BullMQ refuses a job no longer failed. A batch child's
 *   batch is told before the move and after it (`ValkeyBatches`).
 * - `remove` and `prune` delete only jobs in the failed set and keep their
 *   deduplication keys: a key's window outlives its job.
 */

import type {
  FailedJob,
  FailedJobsCapability,
  JobEnvelope,
  QueueDeclaration,
  RetryResult,
} from '../contract/index.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import {
  checkedListOptions,
  checkedPruneOptions,
  compareFailed,
  isAfterCursor,
} from '../failed/list-options.js';
import { retryRefusal } from '../failed/retry-rule.js';
import type { BullQueue } from './bullmq-surface.js';
import { decodeFailure } from './failure-record.js';
import type { KeyLayout } from './key-layout.js';
import { guarded, transportError } from './transport-error.js';
import type { ValkeyBatches } from './valkey-batches.js';
import type { ValkeyScripts } from './valkey-scripts.js';
import { batchMembershipOf } from './valkey-worker.js';

/** How many failed jobs one prune script deletes before the next runs. */
const PRUNE_CHUNK = 1_000;

/** What the failed jobs need from their adapter. */
export interface FailedJobsHost {
  readonly scripts: ValkeyScripts;
  readonly layout: KeyLayout;
  readonly batches: ValkeyBatches;
  readonly declarations: readonly QueueDeclaration[];
  queue(name: string): BullQueue;
}

interface FoundJob {
  readonly queue: string;
  /** Undefined when the job is not in its queue's failed set. */
  readonly failedAt: number | undefined;
  readonly data: string;
  readonly reason: string;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsed(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    // Data BullMQ holds that is not JSON is no envelope; the retry rule refuses it.
    return undefined;
  }
}

/** BullMQ's numeric script errors: -1 the job does not exist, -3 it is not in the expected state. */
function scriptCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

/** The failed jobs of one adapter. */
export class ValkeyFailedJobs implements FailedJobsCapability {
  readonly #host: FailedJobsHost;

  constructor(host: FailedJobsHost) {
    this.#host = host;
  }

  #declaration(queue: string): QueueDeclaration | undefined {
    return this.#host.declarations.find((declaration) => declaration.name === queue);
  }

  /** The oldest failure time `queue`'s retention still reports. */
  #cutoff(queue: string, now: number): number {
    const declaration = this.#declaration(queue);
    return declaration === undefined ? 0 : now - declaration.retention.failed.ageMs;
  }

  async list(options?: Parameters<FailedJobsCapability['list']>[0]): Promise<readonly FailedJob[]> {
    const { queue, limit, before } = checkedListOptions(options);
    let queues = this.#host.declarations.map((declaration) => declaration.name);
    if (queue !== undefined) {
      if (this.#declaration(queue) === undefined) throw new JobsErrors.Error('unknown_queue');
      queues = [queue];
    }
    const now = Date.now();
    const entries: FailedJob[] = [];
    for (const name of queues) {
      const prefix = this.#host.layout.queueKey(name);
      const reply = asArray(
        await guarded(() =>
          this.#host.scripts.failedPage.run(
            [`${prefix}failed`],
            [before === undefined ? '+inf' : before.failedAt, limit, prefix],
          ),
        ),
      );
      const cutoff = this.#cutoff(name, now);
      for (let i = 0; i + 3 < reply.length; i += 4) {
        const id = asText(reply[i]);
        const failedAt = Number(asText(reply[i + 1]));
        const data = asText(reply[i + 2]);
        if (data === '' || failedAt < cutoff) continue;
        if (before !== undefined && !isAfterCursor(failedAt, id, before)) continue;
        entries.push(this.#failedJob(id, name, failedAt, data, asText(reply[i + 3])));
      }
    }
    return Object.freeze(entries.sort(compareFailed).slice(0, limit));
  }

  #failedJob(id: string, queue: string, failedAt: number, data: string, reason: string): FailedJob {
    return Object.freeze({
      id,
      queue,
      envelope: parsed(data) as JobEnvelope,
      error: decodeFailure(reason).error,
      failedAt,
    });
  }

  /** Where job `id` is, on any declared queue. */
  async #find(id: string): Promise<FoundJob | undefined> {
    const queues = this.#host.declarations.map((declaration) => declaration.name);
    const reply = asArray(
      await guarded(() =>
        this.#host.scripts.findJob.run(
          [],
          [id, ...queues.map((queue) => this.#host.layout.queueKey(queue))],
        ),
      ),
    );
    const position = Number(reply[0]);
    const queue = queues[position - 1];
    if (queue === undefined) return undefined;
    const score = asText(reply[1]);
    return {
      queue,
      failedAt: score === '' ? undefined : Number(score),
      data: asText(reply[2]),
      reason: asText(reply[3]),
    };
  }

  /** Job `id` when it is failed and its queue's retention still reports it. */
  async #findFailed(id: unknown): Promise<(FoundJob & { readonly failedAt: number }) | undefined> {
    if (typeof id !== 'string' || id.length === 0) return undefined;
    const found = await this.#find(id);
    if (found?.failedAt === undefined) return undefined;
    if (found.failedAt < this.#cutoff(found.queue, Date.now())) return undefined;
    return { ...found, failedAt: found.failedAt };
  }

  async get(id: string): Promise<FailedJob | undefined> {
    const found = await this.#findFailed(id);
    if (found === undefined || found.data === '') return undefined;
    return this.#failedJob(id, found.queue, found.failedAt, found.data, found.reason);
  }

  async retry(id: string, options?: { readonly force?: boolean }): Promise<RetryResult> {
    if (options !== undefined) {
      if (!isRecord(options) || Object.keys(options).some((key) => key !== 'force')) {
        throw new JobsErrors.Error('invalid_option', { option: 'options' });
      }
      if (options.force !== undefined && typeof options.force !== 'boolean') {
        throw new JobsErrors.Error('invalid_option', { option: 'force' });
      }
    }
    const force = isRecord(options) && options.force === true;
    if (typeof id !== 'string' || id.length === 0) return 'not_found';
    const found = await this.#find(id);
    if (found === undefined) return 'not_found';
    if (found.failedAt === undefined) return 'not_failed';
    // A job past its queue's failed age is gone as far as the list is concerned.
    if (found.failedAt < this.#cutoff(found.queue, Date.now())) return 'not_found';
    const envelope = parsed(found.data);
    if (retryRefusal(envelope, force) !== undefined) return 'not_retryable';
    const prefix = this.#host.layout.queueKey(found.queue);
    await guarded(() =>
      this.#host.scripts.resetCounts.run([`${prefix}failed`, `${prefix}${id}`], [id]),
    );
    const preparation = await this.#host.batches.prepareRetry(batchMembershipOf(envelope, id));
    let result: RetryResult;
    try {
      result = await this.#moveBack(found.queue, id);
    } catch (error) {
      await this.#host.batches.finishRetry(preparation, false);
      throw error;
    }
    await this.#host.batches.finishRetry(preparation, result === 'retried');
    return result;
  }

  /** Have BullMQ move failed job `id` back to waiting, its attempts reset. */
  async #moveBack(queue: string, id: string): Promise<RetryResult> {
    const job = await guarded(() => this.#host.queue(queue).getJob(id));
    if (job === undefined) return 'not_found';
    try {
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    } catch (error) {
      const code = scriptCode(error);
      if (code === -1) return 'not_found';
      if (code === -3) return 'not_failed';
      throw transportError(error);
    }
    return 'retried';
  }

  async remove(id: string): Promise<boolean> {
    const found = await this.#findFailed(id);
    if (found === undefined) return false;
    const prefix = this.#host.layout.queueKey(found.queue);
    const removed = await guarded(() =>
      this.#host.scripts.removeFailed.run(
        [`${prefix}failed`, `${prefix}${id}`, `${prefix}${id}:logs`],
        [id, this.#cutoff(found.queue, Date.now())],
      ),
    );
    return removed === 1;
  }

  async prune(options: { readonly olderThanMs: number }): Promise<number> {
    const cutoff = Date.now() - checkedPruneOptions(options);
    let pruned = 0;
    for (const declaration of this.#host.declarations) {
      const prefix = this.#host.layout.queueKey(declaration.name);
      for (;;) {
        const deleted = Number(
          await guarded(() =>
            this.#host.scripts.pruneFailed.run([`${prefix}failed`], [prefix, cutoff, PRUNE_CHUNK]),
          ),
        );
        pruned += deleted;
        if (deleted < PRUNE_CHUNK) break;
      }
    }
    return pruned;
  }
}
