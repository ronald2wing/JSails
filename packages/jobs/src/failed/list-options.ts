/**
 * The options of the failed-job reads and deletes, checked once for every
 * transport: a page of at most {@link MAX_FAILED_LIST_LIMIT} entries placed
 * by a `{ failedAt, id }` cursor, an optional queue, and the age a prune
 * deletes beyond. Each refusal is a value-free `jobs.invalid_option` naming
 * the option.
 */

import type { FailedJobCursor } from '../contract/index.js';
import { validDelay } from '../envelope/job-options.js';
import { JobsErrors } from '../errors/jobs-errors.js';
import { isQueueName } from '../queues/queue-set.js';

/** The page size of a list that states none. */
export const DEFAULT_FAILED_LIST_LIMIT = 50;
/** The largest page a list returns. */
export const MAX_FAILED_LIST_LIMIT = 1_000;
/** The longest job id a cursor may carry. */
export const MAX_FAILED_CURSOR_ID_LENGTH = 128;

/** Checked list options. */
export interface FailedListOptions {
  readonly queue: string | undefined;
  readonly limit: number;
  readonly before: FailedJobCursor | undefined;
}

const LIST_KEYS: ReadonlySet<string> = new Set(['queue', 'limit', 'before']);

function refuse(option: string): Error {
  return new JobsErrors.Error('invalid_option', { option });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cursorOf(value: unknown): FailedJobCursor {
  if (!isRecord(value) || Object.keys(value).length !== 2) throw refuse('before');
  const { failedAt, id } = value;
  if (typeof failedAt !== 'number' || !Number.isSafeInteger(failedAt) || failedAt < 0) {
    throw refuse('before');
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_FAILED_CURSOR_ID_LENGTH) {
    throw refuse('before');
  }
  return Object.freeze({ failedAt, id });
}

/**
 * Check the options of `FailedJobsCapability.list`.
 *
 * @throws `jobs.unknown_option` for a field that is not an option,
 *   `jobs.invalid_option` naming `options`, `queue`, `limit` or `before`.
 */
export function checkedListOptions(value: unknown): FailedListOptions {
  if (value === undefined) {
    return { queue: undefined, limit: DEFAULT_FAILED_LIST_LIMIT, before: undefined };
  }
  if (!isRecord(value)) throw refuse('options');
  if (!Object.keys(value).every((key) => LIST_KEYS.has(key))) {
    throw new JobsErrors.Error('unknown_option');
  }
  const { queue, limit } = value;
  if (queue !== undefined && !isQueueName(queue)) throw refuse('queue');
  let checkedLimit = DEFAULT_FAILED_LIST_LIMIT;
  if (limit !== undefined) {
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_FAILED_LIST_LIMIT
    ) {
      throw refuse('limit');
    }
    checkedLimit = limit;
  }
  return {
    queue,
    limit: checkedLimit,
    before: value.before === undefined ? undefined : cursorOf(value.before),
  };
}

/**
 * Check the options of `FailedJobsCapability.prune` and return
 * `olderThanMs` (0 to one year).
 *
 * @throws `jobs.invalid_option` naming `options` or `olderThanMs`.
 */
export function checkedPruneOptions(value: unknown): number {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'olderThanMs')) {
    throw refuse('options');
  }
  const olderThanMs = validDelay(value.olderThanMs);
  if (olderThanMs === undefined) throw refuse('olderThanMs');
  return olderThanMs;
}

/**
 * Whether a failed job at `failedAt` with `id` comes after `before` in list
 * order (`failedAt` descending, then `id` descending by UTF-16 code unit).
 */
export function isAfterCursor(failedAt: number, id: string, before: FailedJobCursor): boolean {
  return failedAt < before.failedAt || (failedAt === before.failedAt && id < before.id);
}

/** List order: newest first, then `id` descending by UTF-16 code unit. */
export function compareFailed(
  a: { readonly failedAt: number; readonly id: string },
  b: { readonly failedAt: number; readonly id: string },
): number {
  if (a.failedAt !== b.failedAt) return b.failedAt - a.failedAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
