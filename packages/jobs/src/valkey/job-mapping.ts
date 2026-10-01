/**
 * How the Valkey transport maps a stored envelope onto a BullMQ add.
 *
 * - Attempts: the envelope's `attempts` (one by default). BullMQ counts a
 *   failed attempt and retries while attempts remain, which is the package's
 *   `isFinalFailure` rule; a non-retryable failure is thrown as BullMQ's
 *   unrecoverable error.
 * - Backoff: the custom type {@link BACKOFF_TYPE}, which the worker resolves
 *   with the package's own `backoffDelay` over the envelope's backoff, so
 *   every transport waits the same between attempts.
 * - Priority: 0 (the default and the most urgent) is BullMQ's no-priority
 *   list, which it serves before prioritized jobs; others map as they are.
 * - Delay: from `meta.runAt`, bounded to a year and rounded up.
 * - Key: BullMQ deduplication with a TTL of the key's window, by the key's
 *   digest. BullMQ writes the key in the add script and keeps it until the
 *   TTL ends, whatever happens to the job, retention eviction included.
 * - Retention: the queue's rules as BullMQ's `keepJobs`, age in whole
 *   seconds (at least one); a count of 0 removes a settled job at once.
 */

import type { JobEnvelope, QueueDeclaration, RetentionRule } from '../contract/index.js';
import { boundedDelay } from '../contract/settle-rules.js';
import { backoffDelay } from '../envelope/job-options.js';
import type { BullJobOptions, BullKeepJobs } from './bullmq-surface.js';
import { deduplicationId } from './key-layout.js';

/** The backoff type of every job; the worker's strategy computes its delay. */
export const BACKOFF_TYPE = 'jsails';

/** BullMQ's `keepJobs` for a retention rule. */
export function keepJobsOf(rule: RetentionRule): BullKeepJobs {
  if (rule.count === 0) return true;
  return { age: Math.max(1, Math.ceil(rule.ageMs / 1_000)), count: rule.count };
}

/**
 * The add options of `envelope` on the queue `declaration`, under job id
 * `jobId`, at `now`. Batch members pass `withKey: false`: each is stored
 * under a fixed id, which BullMQ stores once, and the batch record keeps a
 * child's first outcome, so a member is once-only without a key.
 */
export function addOptionsOf(
  envelope: JobEnvelope,
  declaration: QueueDeclaration,
  jobId: string,
  now: number,
  withKey = true,
): BullJobOptions {
  const { options, meta } = envelope;
  const delay = meta.runAt === undefined ? 0 : boundedDelay(meta.runAt - now);
  return {
    jobId,
    attempts: options.attempts ?? 1,
    backoff: { type: BACKOFF_TYPE },
    ...(options.priority === undefined || options.priority === 0
      ? {}
      : { priority: options.priority }),
    ...(delay > 0 ? { delay } : {}),
    ...(withKey && meta.key !== undefined
      ? {
          deduplication: { id: deduplicationId(meta.key), ttl: meta.keyWindowMs ?? 0 },
        }
      : {}),
    removeOnComplete: keepJobsOf(declaration.retention.completed),
    removeOnFail: keepJobsOf(declaration.retention.failed),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The worker's backoff strategy: the package's `backoffDelay` over the
 * stored envelope's backoff, for the attempt count BullMQ passes (the failed
 * attempts so far, this one included). A job whose data is not an envelope
 * retries at once.
 */
export function envelopeBackoff(
  attemptsMade: number,
  _type?: string,
  _error?: Error,
  job?: { readonly data: unknown },
): number {
  const data = job?.data;
  if (!isRecord(data) || !isRecord(data.options)) return 0;
  const { backoff } = data.options;
  if (
    !isRecord(backoff) ||
    (backoff.type !== 'fixed' && backoff.type !== 'exponential') ||
    typeof backoff.delayMs !== 'number'
  ) {
    return 0;
  }
  return backoffDelay({ type: backoff.type, delayMs: backoff.delayMs }, attemptsMade);
}
