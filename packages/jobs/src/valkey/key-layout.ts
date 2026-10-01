/**
 * Where the Valkey transport keeps what, under one app environment's
 * namespace.
 *
 * - BullMQ's keys live under the prefix `<namespace>:jobs`, so a queue's keys
 *   are `<namespace>:jobs:<queue>:…` and a job's hash is
 *   `<namespace>:jobs:<queue>:<id>`.
 * - The transport's own keys (batch records, schedules, leases) start with
 *   `_` inside that prefix: a declared queue name starts with a letter, so
 *   no queue's keys can collide with them.
 *
 * Job ids are chosen by the transport, never by BullMQ: a dispatch gets a
 * random UUID, so a deduplicated add is told apart from a new one by the id
 * BullMQ returns. A batch finalizer gets `b<digest of the batch id>.<incarnation>`
 * and its child `i` gets `<finalizer id>.<i>`, the incarnation being drawn
 * when the batch record is created and kept in it: re-issuing a batch while
 * its record lives addresses the same jobs, and re-issuing it once the record
 * expired addresses fresh ones, never a job BullMQ still retains from the
 * earlier batch (whose add would store nothing). None is an integer or
 * contains `:`, which BullMQ refuses in a custom id. Idempotency keys and
 * batch ids reach the server only as SHA-256 digests, so neither their length
 * nor their characters shape a key.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** The return value a skipped attempt completes with, and a skipped child's batch record. */
export const SKIPPED_RESULT = 's';

/** The return value a completed or discarded attempt completes with, and such a child's batch record. */
export const COMPLETED_RESULT = 'c';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** The keys of one adapter. */
export interface KeyLayout {
  /** BullMQ's key prefix. */
  readonly prefix: string;
  /** The key prefix of `queue`'s BullMQ keys, `:` included. */
  queueKey(queue: string): string;
  /** The hash of job `id` on `queue`. */
  jobKey(queue: string, id: string): string;
  /** The transport's record of batch `id`. */
  batchRecord(id: string): string;
  /** The schedule hashes: `<field>` is `spec`, `repeat`, `paused`, `anchor`, `through` or `rev`. */
  schedules(field: ScheduleField): string;
  /** The schedule set's revision, stamp and change counter. */
  readonly scheduleMeta: string;
  /** The lease of `key`. */
  lease(key: string): string;
}

/** One hash of the schedule store, keyed by schedule id. */
export type ScheduleField = 'spec' | 'repeat' | 'paused' | 'anchor' | 'through' | 'rev';

/** The key layout of the namespace `<app>:<environment>`. */
export function keyLayout(namespace: string): KeyLayout {
  const prefix = `${namespace}:jobs`;
  const own = `${prefix}:_`;
  return Object.freeze({
    prefix,
    queueKey: (queue: string) => `${prefix}:${queue}:`,
    jobKey: (queue: string, id: string) => `${prefix}:${queue}:${id}`,
    batchRecord: (id: string) => `${own}batch:${digest(id)}`,
    schedules: (field: ScheduleField) => `${own}sched:${field}`,
    scheduleMeta: `${own}sched:meta`,
    lease: (key: string) => `${own}lease:${key}`,
  });
}

/** A fresh id for a dispatched job. */
export function newJobId(): string {
  return randomUUID();
}

/** The BullMQ deduplication id of an idempotency key. */
export function deduplicationId(key: string): string {
  return digest(key);
}

/** A fresh incarnation for a batch record about to be created: 72 random bits, base64url. */
export function newBatchIncarnation(): string {
  return randomBytes(9).toString('base64url');
}

/** The id of the finalizer of incarnation `incarnation` of batch `id`. */
export function finalizerJobId(id: string, incarnation: string): string {
  return `b${digest(id)}.${incarnation}`;
}

/** The id of child `index` of the batch whose finalizer is `finalizerId`. */
export function childJobId(finalizerId: string, index: number): string {
  return `${finalizerId}.${index}`;
}

/** The finalizer id child job `jobId` was stored under as child `index`, or undefined when it is no such child. */
export function finalizerIdOfChild(jobId: string, index: number): string | undefined {
  const suffix = `.${index}`;
  return jobId.length > suffix.length && jobId.endsWith(suffix)
    ? jobId.slice(0, -suffix.length)
    : undefined;
}
