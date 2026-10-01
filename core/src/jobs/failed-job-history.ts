/**
 * Failed-job history: the store a jobs runtime records a job into when it
 * fails for the last time (after its retries), and that `jsails queue:failed`,
 * `queue:retry`, and `queue:forget` read and edit.
 *
 * {@link FailedJobHistory} is the asynchronous contract, so a durable backend
 * (the database history in `database-failed-job-history.ts`) fits it as well as
 * the in-process {@link InMemoryFailedJobHistory}. The memory history is
 * bounded: it keeps its entries in an {@link InMemoryFailedJobStore} ring
 * buffer, which it exposes as `store` so the same entries can feed the jobs
 * dashboard and the introspection route.
 *
 * What is recorded: the queue, the job name, the payload exactly as the worker
 * received it (so a retry re-dispatches the same data), the attempt count, the
 * failure time, the originating request id, the dispatch options a retry
 * replays ({@link replayableJobOptions}), whether the job belonged to a chain
 * or a batch, and the value-free error summary the runtime already reports
 * ({@link summarizeJobError}: class, code, message capped at
 * {@link MAX_JOB_ERROR_MESSAGE}). The payload is not redacted, so
 * secrets do not belong in job payloads; pass an id and load the secret inside
 * the handler instead.
 *
 * {@link retryFailedJob} claims one entry first ({@link FailedJobHistory.take}
 * removes and returns it only for the caller whose removal took effect), then
 * dispatches it, and puts it back ({@link FailedJobHistory.restore}) when the
 * dispatch fails. Two concurrent retries of one entry therefore dispatch it
 * once. A retry replays the recorded dispatch options but cannot rejoin the
 * chain or batch the job belonged to, and the job still runs at least once, so
 * it must be idempotent like any other.
 *
 * Ids increase with recording order in both built-in histories, which is what
 * the `beforeId` listing cursor relies on to page through a history that keeps
 * growing while it is read.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import { JsailsError } from '../errors/jsails-error.js';
import { BATCH_OPTION_KEY } from './batch.js';
import { CHAIN_OPTION_KEY } from './chain.js';
import { MAX_JOB_ERROR_MESSAGE, type JobErrorSummary } from './events.js';
import {
  FailedJobNotFoundError,
  InMemoryFailedJobStore,
  type FailedJobEntry,
  type FailedJobMembership,
} from './failed-jobs.js';
import { validateJobOptions } from './queue.js';

/** How many entries a listing returns when the caller names no limit. */
export const DEFAULT_FAILED_JOB_LIST_LIMIT = 50;

/** Upper bound on one listing, so a large history is never read in one go. */
export const MAX_FAILED_JOB_LIST_LIMIT = 1000;

/** How many entries {@link InMemoryFailedJobHistory} keeps by default. */
export const DEFAULT_FAILED_JOB_HISTORY_ENTRIES = 1000;

/** What the runtime records for one finally failed job. */
export interface FailedJobRecordInput {
  /** The queue the job ran on. */
  readonly queue: string;
  /** The registered job name. */
  readonly name: string;
  /** The payload as the worker received it. Stored as given. */
  readonly data: unknown;
  /** The value-free error summary of the last attempt. */
  readonly error: JobErrorSummary;
  /** Attempts made, the final one included. */
  readonly attempts: number;
  /** When the final attempt failed. */
  readonly failedAt: Date;
  /** The originating request id, when the job carried one. */
  readonly requestId?: string;
  /** Normalized monitoring tags, when the job carried them. */
  readonly tags?: readonly string[];
  /** The dispatch options a retry replays; see {@link replayableJobOptions}. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** The chain or batch the job belonged to; see {@link jobMembership}. */
  readonly membership?: readonly FailedJobMembership[];
}

/**
 * The dispatch options a retry replays. A delay is left out (a retry runs
 * now), as is a job id (the failed original may still hold it in the
 * transport, which would drop the retry as a duplicate), and so are the
 * framework's chain, batch, overlap, and request descriptors, which describe
 * the original run rather than the job.
 */
const REPLAYED_JOB_OPTIONS = [
  'attempts',
  'backoff',
  'priority',
  'lifo',
  'removeOnComplete',
  'removeOnFail',
  'keepLogs',
  'stackTraceLimit',
  'sizeLimit',
] as const;

/**
 * Pick the options in {@link REPLAYED_JOB_OPTIONS} out of a job's raw dispatch
 * options, keeping only those the dispatch allowlist accepts, so a value a
 * transport added or a hand-built record cannot make the replay fail.
 * `undefined` when none remain.
 */
export function replayableJobOptions(opts: unknown): Record<string, unknown> | undefined {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) return undefined;
  const source = opts as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of REPLAYED_JOB_OPTIONS) {
    if (source[key] === undefined) continue;
    try {
      const validated = (validateJobOptions({ [key]: source[key] }) as Record<string, unknown>)[
        key
      ];
      if (validated !== undefined) picked[key] = validated;
    } catch {
      // An option the allowlist refuses is not replayed; the rest still are.
    }
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}

/** The chain or batch a job's raw dispatch options say it belonged to, or `undefined`. */
export function jobMembership(opts: unknown): FailedJobMembership[] | undefined {
  if (opts === null || typeof opts !== 'object') return undefined;
  const source = opts as Record<string, unknown>;
  const membership: FailedJobMembership[] = [];
  if (source[CHAIN_OPTION_KEY] !== undefined) membership.push('chain');
  if (source[BATCH_OPTION_KEY] !== undefined) membership.push('batch');
  return membership.length === 0 ? undefined : membership;
}

/** Options for {@link FailedJobHistory.list}. */
export interface FailedJobListOptions {
  /** Only entries recorded for this queue. */
  readonly queue?: string;
  /**
   * At most this many entries, newest first. Defaults to
   * {@link DEFAULT_FAILED_JOB_LIST_LIMIT}; at most {@link MAX_FAILED_JOB_LIST_LIMIT}.
   */
  readonly limit?: number;
  /**
   * Only entries recorded before the entry with this id (which need not still
   * exist): the cursor for reading the next, older page. An id the history
   * could never have assigned matches nothing.
   */
  readonly beforeId?: string;
}

/** Options for {@link FailedJobHistory.clear}. */
export interface FailedJobClearOptions {
  /** Only remove entries recorded for this queue. */
  readonly queue?: string;
}

/** A store of finally failed jobs, durable or in-process. */
export interface FailedJobHistory {
  /** Record one failure and return the stored entry (with its assigned id). */
  record(input: FailedJobRecordInput): Promise<FailedJobEntry>;
  /** Entries newest first, optionally for one queue, bounded by `limit`. */
  list(options?: FailedJobListOptions): Promise<readonly FailedJobEntry[]>;
  /** One entry by id, or `undefined` when none has that id. */
  get(id: string): Promise<FailedJobEntry | undefined>;
  /** Remove one entry. Resolves `true` when an entry was removed. */
  remove(id: string): Promise<boolean>;
  /**
   * Remove one entry and return it, or `undefined` when there is none. When
   * several callers take the same id at once, at most one receives the entry:
   * the one whose removal took effect.
   */
  take(id: string): Promise<FailedJobEntry | undefined>;
  /**
   * Put back an entry {@link take} returned, under its id where the store
   * allows it, and return the stored entry (its id may differ).
   */
  restore(entry: FailedJobEntry): Promise<FailedJobEntry>;
  /** Remove every entry (or every entry of one queue); resolves how many. */
  clear(options?: FailedJobClearOptions): Promise<number>;
  /** Release resources the history opened itself. Optional and idempotent. */
  close?(): Promise<void>;
}

/** Stable failure code carried by {@link FailedJobHistoryError}. */
export type FailedJobHistoryErrorCode =
  | 'invalid_limit'
  | 'invalid_queue'
  | 'invalid_cursor'
  | 'invalid_entry'
  | 'invalid_options'
  | 'missing_table'
  | 'missing_data_source';

/** Raised for invalid history input or an unusable backing store. Value-free. */
export class FailedJobHistoryError extends JsailsError {
  constructor(
    readonly code: FailedJobHistoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `value` implements {@link FailedJobHistory} (shape check, nothing invoked). */
export function isFailedJobHistory(value: unknown): value is FailedJobHistory {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  for (const method of ['record', 'list', 'get', 'remove', 'take', 'restore', 'clear']) {
    if (typeof candidate[method] !== 'function') return false;
  }
  return candidate.close === undefined || typeof candidate.close === 'function';
}

/** Resolve a listing limit: absent means the default; otherwise `1..MAX`. */
export function resolveFailedJobListLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_FAILED_JOB_LIST_LIMIT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_FAILED_JOB_LIST_LIMIT
  ) {
    throw new FailedJobHistoryError(
      'invalid_limit',
      `limit must be an integer between 1 and ${MAX_FAILED_JOB_LIST_LIMIT}`,
    );
  }
  return limit;
}

/** Validate an optional queue filter: a non-empty string when present. */
export function resolveFailedJobQueueFilter(queue: unknown): string | undefined {
  if (queue === undefined) return undefined;
  if (typeof queue !== 'string' || queue === '') {
    throw new FailedJobHistoryError('invalid_queue', 'queue must be a non-empty string');
  }
  return queue;
}

/** Validate an optional `beforeId` cursor: a string when present. */
export function resolveFailedJobCursor(beforeId: unknown): string | undefined {
  if (beforeId === undefined) return undefined;
  if (typeof beforeId !== 'string') {
    throw new FailedJobHistoryError('invalid_cursor', 'beforeId must be a string');
  }
  return beforeId;
}

/** Re-cap an error summary so a hand-built input cannot exceed the runtime's bound. */
function capMessage(message: string): string {
  return message.length > MAX_JOB_ERROR_MESSAGE + 1
    ? `${message.slice(0, MAX_JOB_ERROR_MESSAGE)}…`
    : message;
}

/** Validate a record input value-free; returns the capped error summary. */
export function validateFailedJobRecordInput(input: unknown): FailedJobRecordInput {
  const invalid = (): FailedJobHistoryError =>
    new FailedJobHistoryError('invalid_entry', 'failed-job record input is invalid');
  if (input === null || typeof input !== 'object') throw invalid();
  const value = input as Record<string, unknown>;
  if (typeof value.queue !== 'string' || value.queue === '') throw invalid();
  if (typeof value.name !== 'string' || value.name === '') throw invalid();
  if (typeof value.attempts !== 'number' || !Number.isInteger(value.attempts)) throw invalid();
  if (value.attempts < 0) throw invalid();
  if (!(value.failedAt instanceof Date) || Number.isNaN(value.failedAt.getTime())) throw invalid();
  if (value.requestId !== undefined && typeof value.requestId !== 'string') throw invalid();
  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string'))
  ) {
    throw invalid();
  }
  const error = value.error as Record<string, unknown> | null | undefined;
  if (error === null || typeof error !== 'object') throw invalid();
  if (typeof error.name !== 'string' || typeof error.message !== 'string') throw invalid();
  if (error.code !== undefined && typeof error.code !== 'string') throw invalid();
  if (
    value.membership !== undefined &&
    (!Array.isArray(value.membership) ||
      !value.membership.every((member) => member === 'chain' || member === 'batch'))
  ) {
    throw invalid();
  }
  const summary: JobErrorSummary =
    error.code === undefined
      ? { name: error.name, message: capMessage(error.message) }
      : { name: error.name, message: capMessage(error.message), code: error.code };
  const valid: { -readonly [K in keyof FailedJobRecordInput]: FailedJobRecordInput[K] } = {
    ...(input as FailedJobRecordInput),
    error: summary,
  };
  // Options are re-picked rather than trusted, so a hand-built input cannot
  // store one the replay would refuse or must not repeat (a delay, a job id).
  const options = replayableJobOptions(value.options);
  delete valid.options;
  if (options !== undefined) valid.options = options;
  return valid;
}

/** The record input that stores `entry` again, for {@link FailedJobHistory.restore}. */
export function failedJobRecordInputOf(entry: FailedJobEntry): FailedJobRecordInput {
  return {
    queue: entry.queue ?? '',
    name: entry.name,
    data: entry.data,
    error: {
      name: entry.errorName ?? 'Error',
      message: entry.error,
      ...(entry.errorCode === undefined ? {} : { code: entry.errorCode }),
    },
    attempts: entry.attempts,
    failedAt: entry.failedAt,
    ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
    ...(entry.tags === undefined ? {} : { tags: entry.tags }),
    ...(entry.options === undefined ? {} : { options: entry.options }),
    ...(entry.membership === undefined ? {} : { membership: entry.membership }),
  };
}

/**
 * The outcome of a {@link retryFailedJob}:
 *
 * - `dispatched`: the job went back on its queue and the entry is gone.
 * - `restored`: the dispatch failed (`dispatchError`) and the entry is back in
 *   the history as `entry` (whose id may differ from the one retried).
 * - `lost`: the dispatch failed and putting the entry back failed too
 *   (`restoreError`); `entry` is the only remaining copy.
 */
export type FailedJobRetryResult =
  | { readonly status: 'dispatched'; readonly entry: FailedJobEntry }
  | {
      readonly status: 'restored';
      readonly entry: FailedJobEntry;
      readonly dispatchError: unknown;
    }
  | {
      readonly status: 'lost';
      readonly entry: FailedJobEntry;
      readonly dispatchError: unknown;
      readonly restoreError: unknown;
    };

/**
 * Claim one entry ({@link FailedJobHistory.take}), then re-dispatch it. Rejects
 * with {@link FailedJobNotFoundError} when no entry has `id` or a concurrent
 * retry claimed it first; a failed dispatch puts the entry back and resolves
 * with the outcome rather than rejecting.
 */
export async function retryFailedJob(
  history: FailedJobHistory,
  id: string,
  dispatch: (entry: FailedJobEntry) => Awaitable<unknown>,
): Promise<FailedJobRetryResult> {
  const entry = await history.take(id);
  if (entry === undefined) {
    throw new FailedJobNotFoundError(id);
  }
  try {
    await dispatch(entry);
  } catch (dispatchError) {
    try {
      const restored = await history.restore(entry);
      return { status: 'restored', entry: restored, dispatchError };
    } catch (restoreError) {
      return { status: 'lost', entry, dispatchError, restoreError };
    }
  }
  return { status: 'dispatched', entry };
}

/** Options accepted by {@link InMemoryFailedJobHistory}. */
export interface InMemoryFailedJobHistoryOptions {
  /** Maximum entries kept; the oldest is evicted first. Defaults to 1000. */
  readonly maxEntries?: number;
  /** Maximum entry age in milliseconds. Unset keeps entries until evicted. */
  readonly maxAgeMs?: number;
  /** Injectable clock for the age bound. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Run synchronous work as a promise, so a validation error rejects instead of throwing. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

const SEQUENCE_PATTERN = /^[1-9]\d{0,15}$/;

/** The sequence number an id names, or `null` for an id this history never assigns. */
function sequenceOf(id: string): number | null {
  return SEQUENCE_PATTERN.test(id) ? Number(id) : null;
}

/**
 * A bounded, process-scoped {@link FailedJobHistory}. Its entries live in the
 * exposed {@link InMemoryFailedJobStore}, so they are lost on restart and are
 * not visible to another process (a `jsails queue:*` command included); use the
 * database history when the history must outlive the worker.
 */
export class InMemoryFailedJobHistory implements FailedJobHistory {
  /** The bounded store holding the entries, for dashboards and introspection. */
  readonly store: InMemoryFailedJobStore;
  #sequence = 0;

  constructor(options: InMemoryFailedJobHistoryOptions = {}) {
    this.store = new InMemoryFailedJobStore({
      maxEntries: options.maxEntries ?? DEFAULT_FAILED_JOB_HISTORY_ENTRIES,
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  record(input: FailedJobRecordInput): Promise<FailedJobEntry> {
    return settle(() => this.#record(input));
  }

  #record(input: FailedJobRecordInput): FailedJobEntry {
    const valid = validateFailedJobRecordInput(input);
    this.#sequence += 1;
    const entry: FailedJobEntry = {
      id: String(this.#sequence),
      queue: valid.queue,
      name: valid.name,
      data: valid.data,
      error: valid.error.message,
      errorName: valid.error.name,
      ...(valid.error.code === undefined ? {} : { errorCode: valid.error.code }),
      attempts: valid.attempts,
      failedAt: valid.failedAt,
      ...(valid.requestId === undefined ? {} : { requestId: valid.requestId }),
      ...(valid.tags === undefined ? {} : { tags: valid.tags }),
      ...(valid.options === undefined ? {} : { options: valid.options }),
      ...(valid.membership === undefined ? {} : { membership: valid.membership }),
    };
    this.store.add(entry);
    return entry;
  }

  list(options: FailedJobListOptions = {}): Promise<readonly FailedJobEntry[]> {
    return settle(() => {
      const limit = resolveFailedJobListLimit(options.limit);
      const queue = resolveFailedJobQueueFilter(options.queue);
      const cursor = resolveFailedJobCursor(options.beforeId);
      // Ids are this history's own increasing sequence numbers.
      const before = cursor === undefined ? undefined : sequenceOf(cursor);
      if (before === null) return [];
      // Sorted by id rather than insertion order: a restored entry is
      // re-added at the end under its original, older id.
      const newestFirst = [...this.store.list()].sort((a, b) => Number(b.id) - Number(a.id));
      const matching = newestFirst.filter(
        (entry) =>
          (queue === undefined || entry.queue === queue) &&
          (before === undefined || Number(entry.id) < before),
      );
      return matching.slice(0, limit);
    });
  }

  get(id: string): Promise<FailedJobEntry | undefined> {
    return Promise.resolve(this.store.get(id));
  }

  remove(id: string): Promise<boolean> {
    return Promise.resolve(this.store.remove(id));
  }

  take(id: string): Promise<FailedJobEntry | undefined> {
    const entry = this.store.get(id);
    if (entry === undefined || !this.store.remove(id)) return Promise.resolve(undefined);
    return Promise.resolve(entry);
  }

  restore(entry: FailedJobEntry): Promise<FailedJobEntry> {
    return settle(() => {
      const existing = this.store.get(entry.id);
      if (existing !== undefined) return existing;
      // An id this history never assigned is stored under a fresh one, so the
      // id order the listing cursor relies on still holds.
      if (sequenceOf(entry.id) === null || Number(entry.id) > this.#sequence) {
        return this.#record(failedJobRecordInputOf(entry));
      }
      validateFailedJobRecordInput(failedJobRecordInputOf(entry));
      this.store.add(entry);
      return entry;
    });
  }

  clear(options: FailedJobClearOptions = {}): Promise<number> {
    return settle(() => {
      const queue = resolveFailedJobQueueFilter(options.queue);
      const entries = this.store.list();
      if (queue === undefined) {
        this.store.clear();
        return entries.length;
      }
      let removed = 0;
      for (const entry of entries) {
        if (entry.queue === queue && this.store.remove(entry.id)) removed += 1;
      }
      return removed;
    });
  }
}
